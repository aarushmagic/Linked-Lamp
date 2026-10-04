/**
 * Linked Lamp Firmware
 * 
 * A Wi-Fi connected "Friendship Lamp" using ESP32-WROOM.
 * Controls 7 common anode RGB LEDs via 3 NPN transistors driven by PWM.
 * Triggered by a TTP223 capacitive touch sensor (Active HIGH).
 * 
 * Core Features:
 *   - Ambient lighting (solid or animated) and timezone-aware nighttime modes
 * 
 * Requires PlatformIO libraries:
 *   - tzapu/WiFiManager
 *   - knolleary/PubSubClient
 *   - bblanchon/ArduinoJson
 * 
 * License: GNU GPLv3
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <PubSubClient.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Update.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <lwip/dns.h>
#include <esp_ota_ops.h>
#include <time.h>
#include <Adafruit_NeoPixel.h>
#include "version.h"

// =============================================================================
// Hardware Type Definition
// =============================================================================
#define HW_TYPE "neopixel"

// =============================================================================
// Pin Definitions
// =============================================================================
#define TOUCH_SENSOR_PIN 4   // Touch sensor input (Active HIGH)
#define NEOPIXEL_PIN     27  // NeoPixel data pin
#define NEOPIXEL_COUNT   16  // LED ring pixel count

Adafruit_NeoPixel strip(NEOPIXEL_COUNT, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);

// =============================================================================
// Config values persisted in LittleFS
// =============================================================================
String device_id      = "A";
String target_id      = "B";
String mqtt_server    = "";
int    mqtt_port      = 8883;
String mqtt_user      = "";
String mqtt_pass      = "";
String mqtt_delimiter = "/";
String ota_url        = "";  // Base URL for OTA firmware check
String owner_name     = "";  // Device owner name

// Device role for status mapping
String role = "";
bool   isSupplementary = false;
volatile bool isRebooting = false;
volatile bool pauseCore1 = false;

// Epoch timestamp of the last tap
unsigned long lastTapTimestamp = 0;

// =============================================================================
// Web-synced settings persisted in LittleFS
// =============================================================================
String defaultColor          = "#FF0000";
int    lampOnTimeMinutes     = 5;       // Day mode active duration (min)
int    dayMaxBrightness      = 255;     // 0-255
bool   nightModeEnabled      = false;
String nightStartTime        = "22:00";
String nightEndTime          = "08:00";
int    nightLampOnTimeMinutes = 5;
int    nightMaxBrightness    = 128;
String userTimezone          = "EST5EDT"; // POSIX timezone format
bool   ambientModeEnabled    = false;
String ambientColor          = "#0000FF";

// =============================================================================
// Ambient Lighting Modes
// =============================================================================
enum AmbientEffect {
  AMBIENT_SOLID,
  AMBIENT_FIRE,
  AMBIENT_BREATH,
  AMBIENT_LAVA,
  AMBIENT_RAIN,
  AMBIENT_AURORA
};
AmbientEffect currentAmbientEffect = AMBIENT_SOLID;

// Cached parsed solid color
uint8_t ambSolidR = 0, ambSolidG = 0, ambSolidB = 255;

// Last calculated ambient output (normalized linear, brightness applied, before gamma)
// Used as the starting point for cross-fading when an active signal arrives
float lastAmbOutR = 0.0f, lastAmbOutG = 0.0f, lastAmbOutB = 0.0f;

// Volatile animation state (kept strictly in RAM, never committed to flash)
unsigned long lastAmbientFrameMs = 0;
float         breathPhase        = 0.0f;
unsigned long nextRainFlareMs    = 0;
unsigned long rainFlareStartMs   = 0;
const unsigned long AMBIENT_FRAME_MS = 20; // ~50 fps update rate

// =============================================================================
// Application state and timing trackers
// =============================================================================
bool           isLampOn           = false;
unsigned long  lampOnStartTime    = 0;
unsigned long  lampDurationMs     = 300000UL; // Day mode active duration in ms
bool           isPulsing          = false;
unsigned long  pulseStartTime     = 0;
const unsigned long PULSE_DURATION_MS = 20000; // Pulse duration in ms

// Pre-scaled output color state
uint8_t currentR = 0, currentG = 0, currentB = 0;
int     currentMaxBrightness = 255;

// Display Color Profile: Standard sRGB Transfer Function (IEC 61966-2-1)
// Calibrated to match the perceptual color curve of iOS and Android phone screens
inline float srgbToLinear(float c) {
  if (c <= 0.0001f) return 0.0f;
  if (c >= 1.0f)    return 1.0f;
  if (c <= 0.04045f) {
    return c / 12.92f;
  }
  return powf((c + 0.055f) / 1.055f, 2.4f);
}

// Ambient mode intensity ratio (calibrated ~4-5% dimmer to achieve subtle background glow)
const float AMBIENT_RATIO = 0.35f;

// Breathing pulse modulation: balanced 50% to 100% perceived brightness
const float PULSE_MIN_FACTOR = 0.50f;
const float PULSE_DEPTH      = 0.50f;

// Touch sensor gesture state machine
unsigned long lastTouchTime     = 0;
unsigned long touchStartTime    = 0;
int           tapCount          = 0;
bool          isTouching        = false;
bool          wasTouching       = false;
const unsigned long TAP_TIMEOUT = 400; // Multi-tap window (ms)
bool          longPressTriggered = false;

// Color wheel spectrum cycle state
float hue              = 0.0;
bool  isCyclingColors  = false;
unsigned long cycleStartTimeMs = 0;
float cycleStartHue = 0.0;
const float CYCLE_PERIOD_MS = 6000.0; // Color cycle period (ms)

// Color transition crossfade state
bool isTransitioning = false;
unsigned long transitionStartMs = 0;
const unsigned long TRANSITION_DURATION = 5000; // Transition duration (ms)
uint8_t transFromR = 0, transFromG = 0, transFromB = 0;
uint8_t transToR = 0, transToG = 0, transToB = 0;

// Custom multi-color pattern cycle state
struct CycleEntry {
  uint8_t r, g, b;
  unsigned long holdMs;
  unsigned long transMs;
};
const int MAX_CYCLE_ENTRIES = 50;
CycleEntry cycleEntries[MAX_CYCLE_ENTRIES];
int cycleEntryCount = 0;
int cycleCurrentIndex = 0;
bool isColorCycling = false;
unsigned long cycleStepStartMs = 0;
enum CyclePhase { CYCLE_HOLD, CYCLE_TRANSITION };
CyclePhase cyclePhase = CYCLE_HOLD;

// Feedback flash state for tap transmissions
bool isSendFlashing = false;
unsigned long sendFlashStart = 0;
const unsigned long SEND_FLASH_DURATION = 1000; // Confirmation flash duration (ms)
uint8_t preSendR = 0, preSendG = 0, preSendB = 0;
bool wasLampOnBeforeSend = false;

// Feedback flash state for color selection
bool isColorPickFlashing = false;
unsigned long colorPickFlashStart = 0;
const unsigned long COLOR_PICK_FLASH_DURATION = 3000; // Pick confirmation flash duration (ms)
uint8_t prePickR = 0, prePickG = 0, prePickB = 0;
bool wasLampOnBeforePick = false;

// =============================================================================
// WiFi networking state
// =============================================================================
WiFiManager     wifiManager;
WiFiClientSecure espClientSecure;
PubSubClient    mqttClient(espClientSecure);

bool           wifiConnected            = false;
bool           hasConnectedOnce         = false;
unsigned long  lastWifiReconnectAttempt  = 0;
const unsigned long WIFI_RECONNECT_INTERVAL = 15000;
unsigned long  wifiDisconnectedSince    = 0;
const unsigned long WIFI_RESTART_TIMEOUT  = 300000; // Reboot threshold (ms) on connection loss

// Persistent RTC memory (survives soft resets)
RTC_NOINIT_ATTR uint32_t rtcBootMarker;
RTC_NOINIT_ATTR bool rtcLastKnownIsNight;
RTC_NOINIT_ATTR bool rtcBonfireActive;
RTC_NOINIT_ATTR uint64_t rtcLastBonfireLogEpoch;
const uint32_t BOOT_MARKER_VALUE = 0xCAFEBEEF;
bool isColdBoot = false;

// =============================================================================
// Virtual Bonfire State (Co-Presence Glow) - Zero Flash Writes
// =============================================================================
bool          isBonfireActive     = false;
uint64_t      lastBonfireLogEpoch = 0;
uint64_t      flareStartEpoch     = 0;
bool          isBonfireFlaring    = false;

// MQTT connection state
unsigned long  lastMqttReconnectAttempt = 0;
const unsigned long MQTT_RECONNECT_INTERVAL = 5000;
int            mqttFailCount = 0;

// Periodic status maintenance
unsigned long  lastStatusCheck = 0;
const unsigned long STATUS_CHECK_INTERVAL = 300000; // 5 minutes
bool           selfStatusOnline = false; // Tracks reported online status

// Retained MQTT state refresher
unsigned long lastDailyRefresh = 0;
const unsigned long DAILY_REFRESH_INTERVAL = 86400000UL; // Daily refresh interval (ms)

// Dynamically generated MQTT topics
String triggerTopicSub;
String triggerTopicPub;
String settingsTopicSub;
String statusTopicPub;
String partnerStatusTopicSub;    // Subscribes to partner primary status
String partnerSupStatusTopicSub; // Subscribes to partner secondary status
String bonfireTopicSub;          // Retained bonfire state topic
String bonfireTopicPub;          // Partner bonfire state topic

// =============================================================================
// Function Prototypes
// =============================================================================
void loadConfig();
void loadState();
void saveState();
void setupPins();
void setupMQTT();
void onWifiConnect();
void handleWifi();
void handleMqttReconnect();
void handleTouch();
void doActionBasedOnTaps();
void handleLEDs();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void parseSettings(String payload);
void setColor(String hexColor);
void setRGB(uint8_t r, uint8_t g, uint8_t b);
void setRGBFloat(float rLin, float gLin, float bLin);
void setRGBRaw(uint8_t r, uint8_t g, uint8_t b);
uint8_t applyGammaNeo(float linearIntensity);
void performOTA(String url);
float hexToHue(String hexColor);
bool isNighttime();
void publishSettingsViaMQTT();
void startColorTransition(uint8_t toR, uint8_t toG, uint8_t toB);
void parseColorCycle(String payload);
void serialCommandTask(void *pvParameters);
void processSerialCommand(String cmd);
void detectRole();
uint64_t getEpochMs();
void startBonfire(uint64_t logEpoch, bool publishMqtt);
void addBonfireLog(bool publishMqtt);
void extinguishBonfire(bool publishMqtt, const char* reason);
void renderBonfireFrame(uint64_t epochMs);
void resolveAmbientEffect();
void renderAmbientFrame();
void writeAmbientOutput(float rLin, float gLin, float bLin);

// =============================================================================
// Setup
// =============================================================================
void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.printf("\n========================================\n");
  Serial.printf("  Linked Lamp Firmware v%s (%s)%s\n", FIRMWARE_VERSION_STR, HW_TYPE, FIRMWARE_IS_BETA ? " [BETA]" : "");
  Serial.printf("========================================\n");

  // Read boot history from RTC memory to determine cold/soft boot
  if (rtcBootMarker != BOOT_MARKER_VALUE) {
    isColdBoot = true;
    rtcBootMarker = BOOT_MARKER_VALUE;
    rtcLastKnownIsNight = false; // Default to day on cold boot
    rtcBonfireActive = false;
    rtcLastBonfireLogEpoch = 0;
    Serial.println("Cold boot detected (power cycle).");
  } else {
    isColdBoot = false;
    Serial.println("Software restart detected.");
    if (rtcBonfireActive && rtcLastBonfireLogEpoch > 0) {
      isBonfireActive = true;
      lastBonfireLogEpoch = rtcLastBonfireLogEpoch;
      isLampOn = true;
      Serial.println("Restored active Bonfire from RTC memory.");
    }
  }

  setupPins();

  // Mount filesystem, format partition if mount fails
  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount failed even with format. Trying manual format...");
    LittleFS.format();
    LittleFS.begin(true);
  }
  loadConfig();
  loadState();

  // Identify reciprocal target device ID
  target_id = (device_id == "A") ? "B" : "A";
  isSupplementary = (role == "secondary");
  Serial.println("My Device ID: " + device_id);
  Serial.println("Target Device ID: " + target_id);
  Serial.println("Role: " + (role.length() > 0 ? role : "UNSET (will auto-detect)"));

  // Build routing topics, adapting path format for the configured delimiter
  String topicPrefix = "linkedlamp/";
  String d_sep = mqtt_delimiter;

  if (mqtt_delimiter == "_") {
    topicPrefix = mqtt_user + "/f/ll_";
  }

  triggerTopicSub  = topicPrefix + device_id + d_sep + "color_trigger";
  settingsTopicSub = topicPrefix + device_id + d_sep + "settings";
  triggerTopicPub  = topicPrefix + target_id + d_sep + "color_trigger";
  bonfireTopicSub  = topicPrefix + device_id + d_sep + "bonfire";
  bonfireTopicPub  = topicPrefix + target_id + d_sep + "bonfire";

  // Set status topic suffix based on primary/secondary role
  if (isSupplementary) {
    statusTopicPub = topicPrefix + device_id + "2" + d_sep + "status";
  } else {
    statusTopicPub = topicPrefix + device_id + d_sep + "status";
  }

  // Subs for remote companion devices
  partnerStatusTopicSub    = topicPrefix + target_id + d_sep + "status";
  partnerSupStatusTopicSub = topicPrefix + target_id + "2" + d_sep + "status";

  // Initialize WiFi config portal (WiFiManager)
  WiFi.setAutoReconnect(true);
  wifiManager.setConfigPortalBlocking(false);
  wifiManager.setCustomHeadElement(
    "<style>"
    "body{background-color:#0d0f17; color:#fff; font-family:sans-serif;}"
    ".btn{background-color:#6b4cff; color:#fff; border:none; padding:10px 20px; border-radius:5px;}"
    ".btn:hover{background-color:#5a3de6;}"
    "input{border-radius:3px; padding:5px; border:1px solid #6b4cff;}"
    "</style>"
  );

  if (isColdBoot) {
    if (wifiManager.autoConnect("Linked Lamp Setup")) {
      onWifiConnect();
    } else {
      Serial.println("WiFi not connected. Config portal running on 'Linked Lamp Setup' AP.");
      wifiDisconnectedSince = millis();
    }
  } else {
    Serial.println("Software restart: Silent WiFi reconnect...");
    WiFi.begin();
    unsigned long startAttempt = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 5000) {
      delay(100);
    }
    if (WiFi.status() == WL_CONNECTED) {
      onWifiConnect();
    } else {
      Serial.println("WiFi not available. Retrying in background...");
      wifiDisconnectedSince = millis();
    }
  }

  // MQTT Setup
  setupMQTT();

  // Auto-negotiate primary/secondary role on first startup
  if (role.length() == 0) {
    Serial.println("Role unset — will auto-detect after WiFi/MQTT connects...");
    
  }

  // Mark firmware valid only after successful MQTT link to allow rollback recovery

  // Sync system time using network NTP server
  configTzTime(userTimezone.c_str(), "pool.ntp.org", "time.nist.gov", "time.google.com");
  Serial.println("NTP configured with timezone: " + userTimezone);

  // Pin serial listener thread to Core 0 to prevent blocking during core loops
  xTaskCreatePinnedToCore(
    serialCommandTask,  // Task function
    "SerialCmd",        // Name
    4096,               // Stack size (bytes)
    NULL,               // Parameters
    1,                  // Priority (low, just needs to run)
    NULL,               // Task handle (not needed)
    0                   // Core 0 (main loop runs on Core 1)
  );
  Serial.println("Serial command listener started on Core 0.");
}

// =============================================================================
// Core Loop Execution
// =============================================================================
void loop() {
  if (pauseCore1) { delay(10); return; }
  if (isRebooting) return;
  wifiManager.process();
  handleWifi();
  handleTouch();
  handleLEDs();
}

// =============================================================================
// WiFi Networking and Maintenance
// =============================================================================
void onWifiConnect() {
  wifiConnected = true;
  mqttFailCount = 0;

  Serial.println("WiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  // Override default DNS with public servers
  ip_addr_t dns1, dns2;
  IP4_ADDR(&dns1.u_addr.ip4, 8, 8, 8, 8);
  dns1.type = IPADDR_TYPE_V4;
  IP4_ADDR(&dns2.u_addr.ip4, 1, 1, 1, 1);
  dns2.type = IPADDR_TYPE_V4;
  dns_setserver(0, &dns1);
  dns_setserver(1, &dns2);
  Serial.println("Public DNS set: 8.8.8.8 / 1.1.1.1");

  // Pulse green to confirm local connection
  if (!hasConnectedOnce && isColdBoot) {
    hasConnectedOnce = true;
    
    setRGB(0, 120, 0);
    delay(200);
    setRGB(0, 0, 0);
    setRGB(0, 0, 0);
    delay(200);
    setRGB(0, 120, 0);
    delay(200);
    setRGB(0, 0, 0);
  }

  // Sync time against configured timezone
  configTzTime(userTimezone.c_str(), "pool.ntp.org", "time.nist.gov", "time.google.com");
}

void handleWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiConnected) {
      onWifiConnect();
    }

    // Maintain non-blocking MQTT client state
    if (!mqttClient.connected()) {
      handleMqttReconnect();
    } else {
      mqttClient.loop();

      // Correct reported status if retained state is inconsistent
      if (millis() - lastStatusCheck >= STATUS_CHECK_INTERVAL) {
        lastStatusCheck = millis();
        if (!selfStatusOnline) {
          String onlineMsg = String("ONLINE:") + HW_TYPE;
          mqttClient.publish(statusTopicPub.c_str(), onlineMsg.c_str(), true);
          Serial.println("Status correction: re-published ONLINE (was showing OFFLINE)");
        }
      }

      // Retained MQTT state refresher: Constantly refresh retained messages just in case the broker drops them
      if (millis() - lastDailyRefresh >= DAILY_REFRESH_INTERVAL) {
        lastDailyRefresh = millis();
        
        // Push Status
        String onlineMsg = String("ONLINE:") + HW_TYPE;
        mqttClient.publish(statusTopicPub.c_str(), onlineMsg.c_str(), true);
        
        
        publishSettingsViaMQTT();
        
        Serial.println("24-Hour Refresher: Pushed retained status and settings to MQTT.");
      }
    }
  } else {
    // Handle connection drop and schedule reconnects
    if (wifiConnected) {
      wifiConnected = false;
      wifiDisconnectedSince = millis();
      Serial.println("WiFi lost! Attempting reconnect...");
      WiFi.disconnect();
      WiFi.reconnect();
    }

    // Reset device if connection is lost for more than 5 minutes
    if (wifiDisconnectedSince > 0 && (millis() - wifiDisconnectedSince >= WIFI_RESTART_TIMEOUT)) {
      Serial.println("WiFi disconnected 5 min. Restarting...");
      ESP.restart();
    }

    // Attempt reconnect on configured intervals
    if (millis() - lastWifiReconnectAttempt > WIFI_RECONNECT_INTERVAL) {
      lastWifiReconnectAttempt = millis();
      Serial.println("WiFi reconnect attempt...");
      WiFi.disconnect();
      WiFi.reconnect();
    }
  }
}

// =============================================================================
// Initialization Helpers
// =============================================================================
void setupPins() {
  pinMode(TOUCH_SENSOR_PIN, INPUT); // TTP223: Active HIGH

  strip.begin();           // Initialize NeoPixel device
  strip.show();            // Force black output on boot
  strip.setBrightness(255); // Let output brightness scale programmatically
}

void loadConfig() {
  bool configValid = false;

  if (LittleFS.exists("/config.json")) {
    File f = LittleFS.open("/config.json", "r");
    if (f) {
      JsonDocument doc;
      if (!deserializeJson(doc, f)) {
        device_id      = doc["device_id"]   | "A";
        mqtt_server    = doc["mqtt_server"] | "";
        mqtt_port      = doc["mqtt_port"]   | 8883;
        mqtt_user      = doc["mqtt_user"]   | "";
        mqtt_pass      = doc["mqtt_pass"]   | "";
        mqtt_delimiter = doc["delimeter"]   | "/";
        ota_url        = doc["ota_url"]     | "";
        owner_name     = doc["owner_name"]  | "";
        if (mqtt_server.length() > 0) {
          configValid = true;
          Serial.println("Config loaded from /config.json");
          Serial.println("MQTT Server: " + mqtt_server);
        }
      }
      f.close();
    }
  }

  // Accept serial configuration if local config is absent
  if (!configValid) {
    Serial.println("SEND_CONFIG");  // Send handshake to web interface
    Serial.println("Waiting for config via Serial (30s timeout)...");
    unsigned long waitStart = millis();
    String serialBuffer = "";

    while (millis() - waitStart < 30000) {
      if (Serial.available()) {
        char c = Serial.read();
        serialBuffer += c;
        if (c == '\n' || c == '\r') {
          serialBuffer.trim();
          if (serialBuffer.startsWith("{") && serialBuffer.endsWith("}")) {
            JsonDocument doc;
            if (!deserializeJson(doc, serialBuffer)) {
              device_id      = doc["device_id"]   | "A";
              mqtt_server    = doc["mqtt_server"] | "";
              mqtt_port      = doc["mqtt_port"]   | 8883;
              mqtt_user      = doc["mqtt_user"]   | "";
              mqtt_pass      = doc["mqtt_pass"]   | "";
              mqtt_delimiter = doc["delimeter"]   | "/";
              ota_url        = doc["ota_url"]     | "";
              owner_name     = doc["owner_name"]  | "";

              // Persist config to local storage
              if (!LittleFS.begin(true)) { LittleFS.format(); LittleFS.begin(true); }
              File wf = LittleFS.open("/config.json", "w");
              if (wf) {
                serializeJsonPretty(doc, wf);
                wf.close();
              }
              Serial.println("CONFIG_SAVED");
              Serial.println("Config received and saved to /config.json");
              Serial.println("MQTT Server: " + mqtt_server);
              return;
            }
          }
          serialBuffer = "";
        }
      }
      delay(10);
    }
    Serial.println("No config received. Continuing with defaults.");
  }
}

void loadState() {
  if (!LittleFS.exists("/state.json")) return;
  File f = LittleFS.open("/state.json", "r");
  if (!f) return;

  JsonDocument doc;
  if (!deserializeJson(doc, f)) {
    defaultColor          = doc["defaultColor"]   | "#FF0000";
    lampOnTimeMinutes     = doc["dayTimeMin"]     | 5;
    dayMaxBrightness      = doc["dayBright"]      | 255;
    nightModeEnabled      = doc["nightMode"]      | false;
    nightStartTime        = doc["nightStart"]     | "22:00";
    nightEndTime          = doc["nightEnd"]        | "08:00";
    nightLampOnTimeMinutes = doc["nightTimeMin"]   | 5;
    nightMaxBrightness    = doc["nightBright"]     | 128;
    userTimezone          = doc["timezone"]         | "EST5EDT";
    ambientModeEnabled    = doc["ambientMode"]      | false;
    ambientColor          = doc["ambientColor"]     | "#0000FF";
    resolveAmbientEffect();
    lastTapTimestamp      = doc["lastTapTimestamp"] | 0UL;
    if (doc["role"].is<const char*>()) role = doc["role"].as<String>();
    Serial.println("State loaded. Default color: " + defaultColor + ", Role: " + (role.length() > 0 ? role : "unset"));
  }
  f.close();
}

void saveState() {
  JsonDocument doc;
  doc["defaultColor"] = defaultColor;
  doc["dayTimeMin"]   = lampOnTimeMinutes;
  doc["dayBright"]    = dayMaxBrightness;
  doc["nightMode"]    = nightModeEnabled;
  doc["nightStart"]   = nightStartTime;
  doc["nightEnd"]     = nightEndTime;
  doc["nightTimeMin"] = nightLampOnTimeMinutes;
  doc["nightBright"]  = nightMaxBrightness;
  doc["timezone"]     = userTimezone;
  doc["ambientMode"]  = ambientModeEnabled;
  doc["ambientColor"] = ambientColor;
  doc["lastTapTimestamp"] = lastTapTimestamp;
  doc["role"]         = role;

  File f = LittleFS.open("/state.json", "w");
  if (f) {
    serializeJson(doc, f);
    f.close();
    Serial.println("State saved to /state.json");
  }
}

void setupMQTT() {
  espClientSecure.setInsecure();
  mqttClient.setServer(mqtt_server.c_str(), mqtt_port);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(2048); // Configure larger buffers for custom JSON payloads
  mqttClient.setKeepAlive(60);   // Adjust keep-alive duration to decrease broker overhead
}

// =============================================================================
// MQTT Handlers
// =============================================================================
void handleMqttReconnect() {
  if (millis() - lastMqttReconnectAttempt < MQTT_RECONNECT_INTERVAL) return;
  lastMqttReconnectAttempt = millis();

  // Cycle connection on repeated failure thresholds
  if (mqttFailCount >= 3) {
    Serial.println("Multiple MQTT failures — forcing clean disconnect...");
    mqttClient.disconnect();
    delay(100);
    mqttFailCount = 0;
  }

  Serial.print("Attempting MQTT connection...");
  String clientId = "LinkedLamp-" + device_id + "-" + String(random(0xffff), HEX);

  bool connected = false;
  if (role.length() == 0) {
    // Skip LWT configuration when role is undetermined
    connected = mqttClient.connect(clientId.c_str(), mqtt_user.c_str(), mqtt_pass.c_str());
  } else {
    // Set LWT to publish offline state on disconnect
    connected = mqttClient.connect(clientId.c_str(), mqtt_user.c_str(), mqtt_pass.c_str(),
                            statusTopicPub.c_str(), 1, true, "OFFLINE");
  }

  if (connected) {
    Serial.println("Connected to MQTT!");
    mqttFailCount = 0;

    // Auto-negotiate role on initial connect success
    if (role.length() == 0) {
      detectRole();
      return; 
    }

    // Publish retained online status
    String onlineMsg = String("ONLINE:") + HW_TYPE;
    mqttClient.publish(statusTopicPub.c_str(), onlineMsg.c_str(), true);
    selfStatusOnline = false; 
    lastStatusCheck = millis();
    Serial.println("Published " + onlineMsg + " status to " + statusTopicPub);

    // Subscribe to control and config feeds
    mqttClient.subscribe(triggerTopicSub.c_str());
    mqttClient.subscribe(settingsTopicSub.c_str());
    mqttClient.subscribe(bonfireTopicSub.c_str());
    mqttClient.subscribe(statusTopicPub.c_str()); // Monitor own channel to prevent stale offline updates

    // Commit firmware write in NVS
    esp_ota_mark_app_valid_cancel_rollback();
    Serial.println("Firmware marked as valid (rollback cancelled).");

  } else {
    mqttFailCount++;
    Serial.printf("Failed, rc=%d (attempt %d)\n", mqttClient.state(), mqttFailCount);

    // Cycle network interfaces on persistent failure
    if (mqttFailCount >= 6) {
      Serial.println("Too many MQTT failures — forcing WiFi reconnect...");
      mqttFailCount = 0;
      wifiConnected = false;
      wifiDisconnectedSince = millis();
      WiFi.disconnect();
      delay(1000);
      WiFi.reconnect();
    }
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String topicStr(topic);
  String msg((char*)payload, length); // Avoid byte-by-byte fragmentation

  Serial.println("MQTT [" + topicStr + "] " + msg);

  if (topicStr == bonfireTopicSub) {
    if (msg.startsWith("ON:")) {
      unsigned long sec = strtoul(msg.substring(3).c_str(), NULL, 10);
      uint64_t epochMs = (uint64_t)sec * 1000ULL;
      uint64_t now = getEpochMs();
      if (now > epochMs && (now - epochMs) >= 3600000ULL) {
        Serial.println("Retained Bonfire is older than 60 minutes — extinguishing.");
        extinguishBonfire(false, "retained_expired");
      } else {
        if (!isBonfireActive) {
          startBonfire(epochMs, false);
        } else {
          lastBonfireLogEpoch = epochMs;
          flareStartEpoch = now;
          isBonfireFlaring = true;
          rtcLastBonfireLogEpoch = epochMs;
          Serial.println("Bonfire log updated from retained MQTT topic.");
        }
      }
    } else if (msg.startsWith("OFF")) {
      extinguishBonfire(false, msg.c_str());
    }
    return;
  }

  if (topicStr == triggerTopicSub) {
    // Process control actions (OTA triggers, cycles, color updates)

    // Handle OTA firmware update commands
    if (msg.startsWith("OTA:")) {
      String url = msg.substring(4);
      Serial.println("OTA triggered via color_trigger! URL: " + url);
      
      // Verify trigger URL targets config-approved endpoints
      String testTrigger = url;
      String testConfig = ota_url;
      
      int qMark = testTrigger.indexOf('?');
      if (qMark != -1) testTrigger = testTrigger.substring(0, qMark);
      
      
      if (testTrigger.startsWith("http://")) testTrigger.remove(0, 7);
      if (testTrigger.startsWith("https://")) testTrigger.remove(0, 8);
      if (testConfig.startsWith("http://")) testConfig.remove(0, 7);
      if (testConfig.startsWith("https://")) testConfig.remove(0, 8);
      
      
      if (testTrigger.startsWith("www.")) testTrigger.remove(0, 4);
      if (testConfig.startsWith("www.")) testConfig.remove(0, 4);
      
      
      if (testTrigger.endsWith("/")) testTrigger.remove(testTrigger.length() - 1);
      if (testConfig.endsWith("/")) testConfig.remove(testConfig.length() - 1);

      if (ota_url.length() == 0 || !(testTrigger == testConfig || testTrigger.startsWith(testConfig + "/"))) {
        Serial.println("OTA Blocked: Trigger URL does not match configured ota_url (" + ota_url + ")");
        return;
      }

      performOTA(url);
      return;
    }

    // Direct Bonfire commands via trigger topic
    if (msg == "BONFIRE:START") {
      startBonfire(0, false);
      return;
    }
    if (msg == "BONFIRE:LOG") {
      addBonfireLog(false);
      return;
    }
    if (msg.startsWith("BONFIRE:STOP") || msg.startsWith("BONFIRE:OFF")) {
      extinguishBonfire(false, msg.c_str());
      return;
    }

    // If Bonfire is active: no colored taps or cycle signals can override it!
    // Any color tap or color cycle tap is intercepted as adding a log to the fire.
    // Crucial: Added logs DO NOT update lastTapTimestamp!
    if (isBonfireActive) {
      Serial.println("Signal received during active Bonfire: Adding log to fire!");
      addBonfireLog(false);
      return;
    }

    // Decode multi-color pattern cycle definitions
    if (msg.startsWith("CC:")) {
      parseColorCycle(msg);

      // Update last tap timestamp for the PWA dashboard (MQTT only, no flash write)
      time_t now;
      time(&now);
      lastTapTimestamp = (unsigned long)now;
      publishSettingsViaMQTT();

    } else {
    isColorCycling = false; // Stop any active cycle immediately
    // Handle standard single-color signal updates
    // Parse the target color
    String hexColor = msg;
    if (hexColor.startsWith("#")) hexColor.remove(0, 1);
    long number = strtol(hexColor.c_str(), NULL, 16);
    uint8_t newR = (number >> 16) & 0xFF;
    uint8_t newG = (number >> 8)  & 0xFF;
    uint8_t newB =  number        & 0xFF;

    // Evaluate local timezone-aware day/night ranges
    bool isNight = nightModeEnabled && isNighttime();

    // Transition limits based on active schedule
    if (isNight) {
      currentMaxBrightness = nightMaxBrightness;
      lampDurationMs = (unsigned long)nightLampOnTimeMinutes * 60000UL;

      
      if (nightMaxBrightness == 0) {
        Serial.println("Nighttime mode: lamp kept OFF (brightness=0).");
        // Update last tap timestamp for the PWA dashboard (MQTT only, no flash write)
        time_t now;
        time(&now);
        lastTapTimestamp = (unsigned long)now;
        publishSettingsViaMQTT();
        return;
      }
    } else {
      currentMaxBrightness = dayMaxBrightness;
      lampDurationMs = (unsigned long)lampOnTimeMinutes * 60000UL;
    }

    // Scale interpolation starting color
    if (!isLampOn) {
      if (ambientModeEnabled && !(nightModeEnabled && isNighttime())) {
        float curMaxFactor = (float)max(1, currentMaxBrightness) / 255.0f;
        currentR = (uint8_t)min(255.0f, lastAmbOutR / curMaxFactor * 255.0f + 0.5f);
        currentG = (uint8_t)min(255.0f, lastAmbOutG / curMaxFactor * 255.0f + 0.5f);
        currentB = (uint8_t)min(255.0f, lastAmbOutB / curMaxFactor * 255.0f + 0.5f);
      } else {
        currentR = 0;
        currentG = 0;
        currentB = 0;
      }
    }

    // Initialize color crossfade parameters
    startColorTransition(newR, newG, newB);

    isLampOn = true;
    lampOnStartTime = millis();
    isPulsing = true;
    pulseStartTime = millis();
    Serial.println("Trigger received! Lamp ON with gradual transition.");

    // Update last tap timestamp for the PWA dashboard (MQTT only, no flash write)
    time_t now;
    time(&now);
    lastTapTimestamp = (unsigned long)now;
    publishSettingsViaMQTT(); 
    } 

  } else if (topicStr == settingsTopicSub) {
    parseSettings(msg);

  } else if (topicStr == statusTopicPub) {
    // Correct reported status on target channel
    if (msg.startsWith("ONLINE")) {
      selfStatusOnline = true;
    } else {
      selfStatusOnline = false;
      // Immediately attempt to correct stale OFFLINE
      String onlineMsg = String("ONLINE:") + HW_TYPE;
      mqttClient.publish(statusTopicPub.c_str(), onlineMsg.c_str(), true);
      Serial.println("Detected stale OFFLINE status — corrected to ONLINE.");
    }
  }
}

// =============================================================================
// Color Cycle Payload Parser
// =============================================================================
void parseColorCycle(String payload) {
  // Format: CC:RRGGBB,hold,trans;RRGGBB,hold,trans;...
  String data = payload.substring(3); 
  cycleEntryCount = 0;

  int startPos = 0;
  while (startPos < (int)data.length() && cycleEntryCount < MAX_CYCLE_ENTRIES) {
    int semiPos = data.indexOf(';', startPos);
    String segment;
    if (semiPos == -1) {
      segment = data.substring(startPos);
      startPos = data.length(); 
    } else {
      segment = data.substring(startPos, semiPos);
      startPos = semiPos + 1;
    }

    // Extract color values and hold/transition intervals
    int c1 = segment.indexOf(',');
    int c2 = segment.indexOf(',', c1 + 1);
    if (c1 == -1 || c2 == -1) continue; 

    String hexStr = segment.substring(0, c1);
    int holdTenths = segment.substring(c1 + 1, c2).toInt();
    int transTenths = segment.substring(c2 + 1).toInt();

    long number = strtol(hexStr.c_str(), NULL, 16);
    cycleEntries[cycleEntryCount].r = (number >> 16) & 0xFF;
    cycleEntries[cycleEntryCount].g = (number >> 8) & 0xFF;
    cycleEntries[cycleEntryCount].b = number & 0xFF;
    cycleEntries[cycleEntryCount].holdMs = (unsigned long)holdTenths * 100UL;
    cycleEntries[cycleEntryCount].transMs = (unsigned long)transTenths * 100UL;
    cycleEntryCount++;
  }

  if (cycleEntryCount < 1) {
    Serial.println("CC: payload parse failed — no valid entries.");
    return;
  }

  Serial.printf("Color Cycle parsed: %d entries\n", cycleEntryCount);

  // Load schedule brightness thresholds
  bool isNight = nightModeEnabled && isNighttime();
  if (isNight) {
    currentMaxBrightness = nightMaxBrightness;
    lampDurationMs = (unsigned long)nightLampOnTimeMinutes * 60000UL;
    if (nightMaxBrightness == 0) {
      Serial.println("Nighttime mode: lamp kept OFF (brightness=0).");
      return;
    }
  } else {
    currentMaxBrightness = dayMaxBrightness;
    lampDurationMs = (unsigned long)lampOnTimeMinutes * 60000UL;
  }

  // Apply cycling execution parameters
  cycleCurrentIndex = 0;
  cyclePhase = CYCLE_HOLD;
  cycleStepStartMs = millis();
  isColorCycling = true;
  isTransitioning = false;

  // Set first color
  currentR = cycleEntries[0].r;
  currentG = cycleEntries[0].g;
  currentB = cycleEntries[0].b;

  isLampOn = true;
  lampOnStartTime = millis();
  isPulsing = true;
  pulseStartTime = millis();

  // Flush initial cycle target to hardware
  float initCycleFactor = (float)currentMaxBrightness / 255.0f;
  setRGBFloat(((float)currentR / 255.0f) * initCycleFactor,
              ((float)currentG / 255.0f) * initCycleFactor,
              ((float)currentB / 255.0f) * initCycleFactor);

  Serial.println("Color Cycle started!");
}

void parseSettings(String payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return; // Parse error

  // Check and apply config changes from MQTT parameters
  String newDefaultColor = doc["defaultColor"] | defaultColor;
  int    newDayTimeMin   = doc["dayTimeMin"]   | lampOnTimeMinutes;
  int    newDayBright    = doc["dayBright"]     | dayMaxBrightness;
  bool   newNightMode    = doc["nightMode"]     | nightModeEnabled;
  int    newNightTimeMin = doc["nightTimeMin"]  | nightLampOnTimeMinutes;
  int    newNightBright  = doc["nightBright"]   | nightMaxBrightness;
  String newNightStart   = doc["nightStart"]    | nightStartTime;
  String newNightEnd     = doc["nightEnd"]      | nightEndTime;
  String newTimezone     = doc["timezone"]      | userTimezone;
  bool   newAmbientMode  = doc["ambientMode"]   | ambientModeEnabled;
  String newAmbientColor = doc["ambientColor"]  | ambientColor;
  unsigned long newLastTap = doc["lastTapTimestamp"] | lastTapTimestamp;

  
  bool changed = (newDefaultColor != defaultColor)
              || (newDayTimeMin != lampOnTimeMinutes)
              || (newDayBright != dayMaxBrightness)
              || (newNightMode != nightModeEnabled)
              || (newNightTimeMin != nightLampOnTimeMinutes)
              || (newNightBright != nightMaxBrightness)
              || (newNightStart != nightStartTime)
              || (newNightEnd != nightEndTime)
              || (newTimezone != userTimezone)
              || (newAmbientMode != ambientModeEnabled)
              || (newAmbientColor != ambientColor);

  
  defaultColor          = newDefaultColor;
  lampOnTimeMinutes     = newDayTimeMin;
  dayMaxBrightness      = newDayBright;
  nightModeEnabled      = newNightMode;
  nightLampOnTimeMinutes = newNightTimeMin;
  nightMaxBrightness    = newNightBright;
  nightStartTime        = newNightStart;
  nightEndTime          = newNightEnd;
  ambientModeEnabled    = newAmbientMode;
  ambientColor          = newAmbientColor;
  resolveAmbientEffect();
  lastTapTimestamp       = newLastTap;

  
  if (newTimezone != userTimezone || changed) {
    userTimezone = newTimezone;
    configTzTime(userTimezone.c_str(), "pool.ntp.org", "time.nist.gov", "time.google.com");
  }

  // Commit parameters to flash only on actual variance to conserve write cycles
  if (changed) {
    saveState();
    Serial.println("Settings updated from web interface (saved to flash).");
  } else {
    Serial.println("Settings received (no changes, skipping flash write).");
  }
}

// =============================================================================
// Keep MQTT broker retained state synchronized
// =============================================================================
void publishSettingsViaMQTT() {
  if (!mqttClient.connected()) return;

  JsonDocument doc;
  doc["defaultColor"] = defaultColor;
  doc["dayTimeMin"]   = lampOnTimeMinutes;
  doc["dayBright"]    = dayMaxBrightness;
  doc["nightMode"]    = nightModeEnabled;
  doc["nightStart"]   = nightStartTime;
  doc["nightEnd"]     = nightEndTime;
  doc["nightTimeMin"] = nightLampOnTimeMinutes;
  doc["nightBright"]  = nightMaxBrightness;
  doc["timezone"]     = userTimezone;
  doc["ambientMode"]  = ambientModeEnabled;
  doc["ambientColor"] = ambientColor;
  doc["lastTapTimestamp"] = lastTapTimestamp;
  if (owner_name.length() > 0) doc["ownerName"] = owner_name;
  doc["fwVersion"]    = FIRMWARE_VERSION_STR;
  doc["isBeta"]       = FIRMWARE_IS_BETA;
  doc["hwType"]       = HW_TYPE;

  String payload;
  serializeJson(doc, payload);
  mqttClient.publish(settingsTopicSub.c_str(), payload.c_str(), true); // retained
  Serial.println("Settings published to MQTT: " + payload);
}

// =============================================================================
// Role auto-detection sequence
// =============================================================================
static volatile bool roleDetectGotRetained = false;

void roleDetectCallback(char* topic, byte* payload, unsigned int length) {
  String msg((char*)payload, length);
  if (msg.length() > 0) {
    roleDetectGotRetained = true;
    Serial.println("Role detect: received retained message on primary status: " + msg);
  }
}

void detectRole() {
  Serial.println("=== Role Auto-Detection ===");

  // Build primary status topic (always ll_A_status or ll_B_status)
  String topicPrefix = "linkedlamp/";
  String d_sep = mqtt_delimiter;
  if (mqtt_delimiter == "_") {
    topicPrefix = mqtt_user + "/f/ll_";
  }
  String primaryStatusTopic = topicPrefix + device_id + d_sep + "status";

  // Listen for existing primary devices on target channels
  roleDetectGotRetained = false;
  mqttClient.setCallback(roleDetectCallback);
  mqttClient.subscribe(primaryStatusTopic.c_str());

  
  unsigned long detectStart = millis();
  while (millis() - detectStart < 3000) {
    mqttClient.loop();
    if (roleDetectGotRetained) break;
    delay(50);
  }

  mqttClient.unsubscribe(primaryStatusTopic.c_str());

  // Set device role (Primary or Secondary)
  if (roleDetectGotRetained) {
    role = "secondary";
    Serial.println("Primary lamp detected — this lamp will be SECONDARY.");
  } else {
    role = "primary";
    Serial.println("No primary lamp found — this lamp will be PRIMARY.");
  }

  // Restore normal callback
  mqttClient.setCallback(mqttCallback);
  mqttClient.disconnect();

  
  saveState();
  Serial.println("Role saved. Rebooting to apply...");
  delay(500);
  ESP.restart();
}

// =============================================================================
// Color Transition Helper
// =============================================================================
void startColorTransition(uint8_t toR, uint8_t toG, uint8_t toB) {
  transFromR = currentR;
  transFromG = currentG;
  transFromB = currentB;
  transToR = toR;
  transToG = toG;
  transToB = toB;
  transitionStartMs = millis();
  isTransitioning = true;

  
  currentR = toR;
  currentG = toG;
  currentB = toB;

  Serial.printf("Color transition: (%d,%d,%d) -> (%d,%d,%d) over %dms\n",
                transFromR, transFromG, transFromB, toR, toG, toB, TRANSITION_DURATION);
}

// =============================================================================
// Touch Sensor Logic
// =============================================================================
void handleTouch() {
  isTouching = (digitalRead(TOUCH_SENSOR_PIN) == HIGH);

  // Touch event start handler
  if (isTouching && !wasTouching) {
    if (millis() - lastTouchTime < 100) {
      wasTouching = isTouching;
      return;
    }
    touchStartTime = millis();
    longPressTriggered = false;
    isCyclingColors = false;
  }

  // Touch duration handler (evaluates hold state)
  if (isTouching && wasTouching) {
    unsigned long holdTime = millis() - touchStartTime;

    if (holdTime > 1500 && !longPressTriggered) {
      if (!isBonfireActive) {
        // Seed color spectrum cycling from active default (suppressed during bonfire)
        hue = hexToHue(defaultColor);
        cycleStartHue = hue;
        cycleStartTimeMs = millis();
        longPressTriggered = true;

        // Backup state before spectrum cycle override
        prePickR = currentR;
        prePickG = currentG;
        prePickB = currentB;
        wasLampOnBeforePick = isLampOn;
      }
    }

    if (longPressTriggered) {
      isCyclingColors = true;

      // Advance color wheel position by time delta
      unsigned long elapsed = millis() - cycleStartTimeMs;
      hue = cycleStartHue + (elapsed / CYCLE_PERIOD_MS) * 360.0;
      while (hue >= 360.0) hue -= 360.0;

      // Convert HSV vectors back to RGB space
      float c = 1.0;
      float x = c * (1.0 - fabs(fmod(hue / 60.0, 2.0) - 1.0));
      float m = 0.0;
      float rf = 0, gf = 0, bf = 0;
      if      (hue < 60)  { rf = c; gf = x; bf = 0; }
      else if (hue < 120) { rf = x; gf = c; bf = 0; }
      else if (hue < 180) { rf = 0; gf = c; bf = x; }
      else if (hue < 240) { rf = 0; gf = x; bf = c; }
      else if (hue < 300) { rf = x; gf = 0; bf = c; }
      else                 { rf = c; gf = 0; bf = x; }

      currentR = (uint8_t)((rf + m) * 255.0f + 0.5f);
      currentG = (uint8_t)((gf + m) * 255.0f + 0.5f);
      currentB = (uint8_t)((bf + m) * 255.0f + 0.5f);

      setRGBFloat(rf + m, gf + m, bf + m);
    }
  }

  // --- Finger just released ---
  if (!isTouching && wasTouching) {
    if (longPressTriggered) {
      // Persist user selected color to flash storage
      isCyclingColors = false;
      char hexBuf[8];
      sprintf(hexBuf, "#%02X%02X%02X", currentR, currentG, currentB);
      defaultColor = String(hexBuf);
      Serial.println("New default color: " + defaultColor);
      saveState();

      // Push new defaults to MQTT broker
      publishSettingsViaMQTT();

      // Trigger selection feedback pulse
      isColorPickFlashing = true;
      colorPickFlashStart = millis();
      
      setRGB(currentR, currentG, currentB);
    } else {
      // Enforce touch debounce window
      if (millis() - touchStartTime > 50) {
        tapCount++;
        lastTouchTime = millis();
      }
    }
  }

  wasTouching = isTouching;

  // Dispatch multi-tap actions
  if (tapCount > 0 && !isTouching && (millis() - lastTouchTime > TAP_TIMEOUT)) {
    doActionBasedOnTaps();
    tapCount = 0;
  }
}

void doActionBasedOnTaps() {
  Serial.printf("Tap Count: %d\n", tapCount);

  if (tapCount == 1) {
    if (isBonfireActive) {
      Serial.println("Single Tap in Bonfire: Adding log to fire!");
      addBonfireLog(true);
      // Crucial: Added logs DO NOT update lastTapTimestamp!
      return;
    }

    // Tap gesture handler: publishes local default color to paired device
    Serial.println("Single Tap: Sending Signal!");

    
    preSendR = currentR;
    preSendG = currentG;
    preSendB = currentB;
    wasLampOnBeforeSend = isLampOn;

    
    String hexColor = defaultColor;
    if (hexColor.startsWith("#")) hexColor.remove(0, 1);
    long number = strtol(hexColor.c_str(), NULL, 16);
    uint8_t flashR = (number >> 16) & 0xFF;
    uint8_t flashG = (number >> 8)  & 0xFF;
    uint8_t flashB =  number        & 0xFF;

    
    setRGB(flashR, flashG, flashB);

    
    isSendFlashing = true;
    sendFlashStart = millis();

    
    if (mqttClient.connected()) {
      mqttClient.publish(triggerTopicPub.c_str(), defaultColor.c_str());
    } else {
      Serial.println("Warning: MQTT not connected, signal not sent.");
    }

  } else if (tapCount == 2) {
    if (isBonfireActive) {
      Serial.println("Double Tap in Bonfire: Extinguishing fire!");
      extinguishBonfire(true, "double_tap");
      return;
    }

    // Double tap gesture: forces lamp shutdown
    if (isLampOn) {
      
      Serial.println("Double Tap: Turning OFF.");
      isLampOn = false;
      isPulsing = false;
      isTransitioning = false;
      isColorCycling = false;
      setRGB(0, 0, 0);
    } else {
      Serial.println("Double Tap ignored: lamp already off.");
    }

  } else if (tapCount == 3) {
    // Triple tap gesture: redundant shut down helper
    if (isLampOn) {
      
      Serial.println("Triple Tap: Turning OFF (lamp was on).");
      isLampOn = false;
      isPulsing = false;
      isTransitioning = false;
      isColorCycling = false;
      setRGB(0, 0, 0);
    } else {
      Serial.println("Triple Tap ignored: lamp already off.");
    }
  } else if (tapCount >= 5) {
        if (isLampOn) {
      
      Serial.println("5+ Tap: Turning OFF (lamp was on).");
      isLampOn = false;
      isPulsing = false;
      isTransitioning = false;
      isColorCycling = false;
      setRGB(0, 0, 0);
    } else {
      // Multi-tap gesture: resets WiFi settings (must be done from standby)
      Serial.println("5+ Tap: Resetting WiFi credentials...");
      
      setRGB(255, 0, 0);
      delay(300);
      setRGB(0, 0, 0);
      delay(300);
      setRGB(255, 0, 0);
      delay(300);
      setRGB(0, 0, 0);

      wifiManager.resetSettings();
      rtcBootMarker = 0; 
      delay(500);
      ESP.restart();
    }
  }
}

// =============================================================================
// LED Control (Non-blocking)
// =============================================================================
void handleLEDs() {
  if (isCyclingColors) return; // Touch sensor has direct control

  // Execute feedback flash animations
  if (isSendFlashing) {
    if (millis() - sendFlashStart >= SEND_FLASH_DURATION) {
      isSendFlashing = false;
      
      if (wasLampOnBeforeSend) {
        currentR = preSendR;
        currentG = preSendG;
        currentB = preSendB;
        float factor = (float)currentMaxBrightness / 255.0f;
        setRGBFloat(((float)currentR / 255.0f) * factor,
                    ((float)currentG / 255.0f) * factor,
                    ((float)currentB / 255.0f) * factor);
      } else {
        setRGB(0, 0, 0);
      }
      Serial.println("Send flash ended. Reverted to previous state.");
    }
    return; 
  }

  
  if (isColorPickFlashing) {
    if (millis() - colorPickFlashStart >= COLOR_PICK_FLASH_DURATION) {
      isColorPickFlashing = false;
      
      if (wasLampOnBeforePick) {
        currentR = prePickR;
        currentG = prePickG;
        currentB = prePickB;
        float factor = (float)currentMaxBrightness / 255.0f;
        setRGBFloat(((float)currentR / 255.0f) * factor,
                    ((float)currentG / 255.0f) * factor,
                    ((float)currentB / 255.0f) * factor);
        
        isLampOn = true;
      } else {
        currentR = 0;
        currentG = 0;
        currentB = 0;
        setRGB(0, 0, 0);
        isLampOn = false;
      }
      Serial.println("Color pick flash ended. Reverted to previous state.");
    }
    return; 
  }

  if (isBonfireActive) {
    if (nightModeEnabled && isNighttime()) {
      Serial.println("Night mode active — extinguishing Virtual Bonfire.");
      extinguishBonfire(true, "night");
      return;
    }
    uint64_t now = getEpochMs();
    renderBonfireFrame(now);
    return;
  }

  if (!isLampOn) {
    if (ambientModeEnabled && !(nightModeEnabled && isNighttime())) {
      renderAmbientFrame();
    } else {
      lastAmbOutR = 0.0f;
      lastAmbOutG = 0.0f;
      lastAmbOutB = 0.0f;
      setRGB(0, 0, 0);
    }
    return;
  }

  // Enforce auto-shutdown active timers
  if (millis() - lampOnStartTime >= lampDurationMs) {
    isLampOn = false;
    isPulsing = false;
    isTransitioning = false;
    isColorCycling = false;
    setRGB(0, 0, 0);
    Serial.println("Timer expired. Lamp OFF.");
    return;
  }

  // Render running multi-color sequence frames
  if (isColorCycling && cycleEntryCount > 0) {
    unsigned long stepElapsed = millis() - cycleStepStartMs;
    CycleEntry &cur = cycleEntries[cycleCurrentIndex];
    int nextIdx = (cycleCurrentIndex + 1) % cycleEntryCount;
    CycleEntry &nxt = cycleEntries[nextIdx];

    float normR = 0.0f, normG = 0.0f, normB = 0.0f;

    if (cyclePhase == CYCLE_HOLD) {
      currentR = cur.r;
      currentG = cur.g;
      currentB = cur.b;
      normR = (float)cur.r / 255.0f;
      normG = (float)cur.g / 255.0f;
      normB = (float)cur.b / 255.0f;

      if (stepElapsed >= cur.holdMs) {
        cyclePhase = CYCLE_TRANSITION;
        cycleStepStartMs = millis();
      }
    } else {
      if (cur.transMs == 0 || stepElapsed >= cur.transMs) {
        currentR = nxt.r;
        currentG = nxt.g;
        currentB = nxt.b;
        normR = (float)nxt.r / 255.0f;
        normG = (float)nxt.g / 255.0f;
        normB = (float)nxt.b / 255.0f;
        cycleCurrentIndex = nextIdx;
        cyclePhase = CYCLE_HOLD;
        cycleStepStartMs = millis();
      } else {
        float t = (float)stepElapsed / (float)cur.transMs;
        float fR = (float)cur.r + ((float)nxt.r - (float)cur.r) * t;
        float fG = (float)cur.g + ((float)nxt.g - (float)cur.g) * t;
        float fB = (float)cur.b + ((float)nxt.b - (float)cur.b) * t;
        currentR = (uint8_t)(fR + 0.5f);
        currentG = (uint8_t)(fG + 0.5f);
        currentB = (uint8_t)(fB + 0.5f);
        normR = fR / 255.0f;
        normG = fG / 255.0f;
        normB = fB / 255.0f;
      }
    }

    float factor = (float)currentMaxBrightness / 255.0f;
    if (isPulsing) {
      unsigned long pulseElapsed = millis() - pulseStartTime;
      if (pulseElapsed < PULSE_DURATION_MS) {
        float phase = (float)(pulseElapsed % 2000) / 2000.0f * 2.0f * PI;
        float pulseFactor = PULSE_MIN_FACTOR + PULSE_DEPTH * ((sinf(phase) + 1.0f) / 2.0f);
        factor *= pulseFactor;
      } else {
        isPulsing = false;
      }
    }

    setRGBFloat(normR * factor, normG * factor, normB * factor);
    return;
  }

  // Apply incremental crossfade animations
  if (isTransitioning) {
    unsigned long elapsed = millis() - transitionStartMs;
    if (elapsed < TRANSITION_DURATION) {
      float t = (float)elapsed / (float)TRANSITION_DURATION;

      float normR = ((float)transFromR + ((float)transToR - (float)transFromR) * t) / 255.0f;
      float normG = ((float)transFromG + ((float)transToG - (float)transFromG) * t) / 255.0f;
      float normB = ((float)transFromB + ((float)transToB - (float)transFromB) * t) / 255.0f;

      float factor = (float)currentMaxBrightness / 255.0f;
      if (isPulsing) {
        unsigned long pulseElapsed = millis() - pulseStartTime;
        if (pulseElapsed < PULSE_DURATION_MS) {
          float phase = (float)(pulseElapsed % 2000) / 2000.0f * 2.0f * PI;
          float pulseFactor = PULSE_MIN_FACTOR + PULSE_DEPTH * ((sinf(phase) + 1.0f) / 2.0f);
          factor *= pulseFactor;
        } else {
          isPulsing = false;
        }
      }

      setRGBFloat(normR * factor, normG * factor, normB * factor);
    } else {
      isTransitioning = false;
      Serial.println("Color transition complete.");
      // Fall through to normal LED handling below
    }
    if (isTransitioning) return;
  }

  if (isPulsing) {
    unsigned long elapsed = millis() - pulseStartTime;
    if (elapsed < PULSE_DURATION_MS) {
      // Modulate active duty cycles with a gentle, subtle breathing sine wave
      float phase = (float)(elapsed % 2000) / 2000.0f * 2.0f * PI;
      float pulseFactor = PULSE_MIN_FACTOR + PULSE_DEPTH * ((sinf(phase) + 1.0f) / 2.0f);
      float factor = ((float)currentMaxBrightness / 255.0f) * pulseFactor;

      setRGBFloat(((float)currentR / 255.0f) * factor,
                  ((float)currentG / 255.0f) * factor,
                  ((float)currentB / 255.0f) * factor);
    } else {
      isPulsing = false;
      Serial.println("Pulsing ended. Steady ON.");
      float factor = (float)currentMaxBrightness / 255.0f;
      setRGBFloat(((float)currentR / 255.0f) * factor,
                  ((float)currentG / 255.0f) * factor,
                  ((float)currentB / 255.0f) * factor);
    }
  }
  
}

void setColor(String hexColor) {
  if (hexColor.startsWith("#")) hexColor.remove(0, 1);
  long number = strtol(hexColor.c_str(), NULL, 16);
  currentR = (number >> 16) & 0xFF;
  currentG = (number >> 8)  & 0xFF;
  currentB =  number        & 0xFF;
  Serial.printf("Color parsed: R:%d G:%d B:%d\n", currentR, currentG, currentB);
}

void setRGBRaw(uint8_t r, uint8_t g, uint8_t b) {
  // Flush uniform color output to WS2812 interface
  uint32_t color = strip.Color(r, g, b);
  strip.fill(color);
  strip.show();
}

uint8_t applyGammaNeo(float linearIntensity) {
  if (linearIntensity <= 0.0001f) return 0;
  if (linearIntensity >= 1.0f)    return 255;
  
  float corrected = srgbToLinear(linearIntensity);
  uint32_t duty = (uint32_t)(corrected * 255.0f + 0.5f);
  if (duty > 255) duty = 255;
  return (uint8_t)duty;
}

void setRGBFloat(float rLin, float gLin, float bLin) {
  setRGBRaw(applyGammaNeo(rLin), applyGammaNeo(gLin), applyGammaNeo(bLin));
}

void setRGB(uint8_t r, uint8_t g, uint8_t b) {
  setRGBFloat((float)r / 255.0f, (float)g / 255.0f, (float)b / 255.0f);
}

// =============================================================================
// NTP / Time Helpers
// =============================================================================

bool isNighttime() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 0)) return rtcLastKnownIsNight; // Non-blocking: timeout=0

  int nowMinutes = timeinfo.tm_hour * 60 + timeinfo.tm_min;

  // Convert scheduling inputs to raw minute values
  int startH = nightStartTime.substring(0, 2).toInt();
  int startM = nightStartTime.substring(3, 5).toInt();
  int endH   = nightEndTime.substring(0, 2).toInt();
  int endM   = nightEndTime.substring(3, 5).toInt();

  int startMinutes = startH * 60 + startM;
  int endMinutes   = endH * 60 + endM;

  bool currentIsNight;
  if (startMinutes <= endMinutes) {
    currentIsNight = (nowMinutes >= startMinutes && nowMinutes < endMinutes);
  } else {
    currentIsNight = (nowMinutes >= startMinutes || nowMinutes < endMinutes);
  }
  
  rtcLastKnownIsNight = currentIsNight;
  return currentIsNight;
}

float hexToHue(String hexColor) {
  if (hexColor.startsWith("#")) hexColor.remove(0, 1);
  long num = strtol(hexColor.c_str(), NULL, 16);
  float r = ((num >> 16) & 0xFF) / 255.0;
  float g = ((num >> 8) & 0xFF)  / 255.0;
  float b = (num & 0xFF)         / 255.0;

  float maxC = max(max(r, g), b);
  float minC = min(min(r, g), b);
  float delta = maxC - minC;

  if (delta < 0.001) return 0.0; 

  float h = 0;
  if (maxC == r)      h = 60.0 * fmod(((g - b) / delta), 6.0);
  else if (maxC == g) h = 60.0 * (((b - r) / delta) + 2.0);
  else                h = 60.0 * (((r - g) / delta) + 4.0);

  if (h < 0) h += 360.0;
  return h;
}

// =============================================================================
// Virtual Bonfire Logic & Helpers (Zero Flash Writes)
// =============================================================================

uint64_t getEpochMs() {
  struct timeval tv;
  if (gettimeofday(&tv, NULL) == 0 && tv.tv_sec > 1600000000) {
    return (uint64_t)tv.tv_sec * 1000ULL + (tv.tv_usec / 1000ULL);
  }
  return (uint64_t)millis();
}

void startBonfire(uint64_t logEpoch, bool publishMqtt) {
  // Prevent ignition if night mode is currently active
  if (nightModeEnabled && isNighttime()) {
    Serial.println("Bonfire Blocked: Lamp is currently in Night Mode.");
    if (publishMqtt && mqttClient.connected()) {
      mqttClient.publish(bonfireTopicPub.c_str(), "OFF:NIGHT", true);
      mqttClient.publish(bonfireTopicSub.c_str(), "OFF:NIGHT", true);
    }
    return;
  }

  isBonfireActive = true;
  isLampOn = true;
  isPulsing = false;
  isTransitioning = false;
  isColorCycling = false;
  isSendFlashing = false;
  isColorPickFlashing = false;

  uint64_t now = getEpochMs();
  if (logEpoch == 0) logEpoch = now;
  lastBonfireLogEpoch = logEpoch;
  flareStartEpoch = now;
  isBonfireFlaring = true;

  rtcBonfireActive = true;
  rtcLastBonfireLogEpoch = logEpoch;

  Serial.println("Virtual Bonfire Ignited! Base brightness 75%, initial flare 100%.");

  if (publishMqtt && mqttClient.connected()) {
    String payload = "ON:" + String((unsigned long)(logEpoch / 1000ULL));
    mqttClient.publish(bonfireTopicPub.c_str(), payload.c_str(), true);
    mqttClient.publish(bonfireTopicSub.c_str(), payload.c_str(), true);
  }
}

void addBonfireLog(bool publishMqtt) {
  if (!isBonfireActive) {
    startBonfire(0, publishMqtt);
    return;
  }

  uint64_t now = getEpochMs();
  lastBonfireLogEpoch = now;
  flareStartEpoch = now;
  isBonfireFlaring = true;

  rtcLastBonfireLogEpoch = now;
  Serial.println("Log added to Virtual Bonfire! Flaring to 100%.");

  if (publishMqtt && mqttClient.connected()) {
    String payload = "ON:" + String((unsigned long)(now / 1000ULL));
    mqttClient.publish(bonfireTopicPub.c_str(), payload.c_str(), true);
    mqttClient.publish(bonfireTopicSub.c_str(), payload.c_str(), true);
  }
}

void extinguishBonfire(bool publishMqtt, const char* reason) {
  if (!isBonfireActive && !rtcBonfireActive) return;

  Serial.printf("Extinguishing Virtual Bonfire (reason: %s)\n", reason ? reason : "manual");
  isBonfireActive = false;
  isBonfireFlaring = false;
  rtcBonfireActive = false;
  rtcLastBonfireLogEpoch = 0;

  isLampOn = false;
  setRGB(0, 0, 0); // Standby (handleLEDs will manage ambient mode if enabled)

  if (publishMqtt && mqttClient.connected()) {
    String payload = "OFF";
    if (reason && (strcmp(reason, "night") == 0 || strstr(reason, "NIGHT") != NULL)) {
      payload = "OFF:NIGHT";
    }
    mqttClient.publish(bonfireTopicPub.c_str(), payload.c_str(), true);
    mqttClient.publish(bonfireTopicSub.c_str(), payload.c_str(), true);
  }
}

// =============================================================================
// Virtual Bonfire Organic Fire Animation Helpers & Rendering
// =============================================================================

inline float hashNoise1D(uint32_t x) {
  x = ((x >> 16) ^ x) * 0x45d9f3b;
  x = ((x >> 16) ^ x) * 0x45d9f3b;
  x = (x >> 16) ^ x;
  return (float)(x & 0xFFFF) / 65535.0f; // 0.0 to 1.0
}

inline float smoothNoise(float t) {
  int32_t i0 = (int32_t)floorf(t);
  int32_t i1 = i0 + 1;
  float f = t - (float)i0;
  // Quintic Hermite interpolant: 6f^5 - 15f^4 + 10f^3 (continuous 1st & 2nd derivatives)
  float u = f * f * f * (f * (f * 6.0f - 15.0f) + 10.0f);
  float n0 = hashNoise1D((uint32_t)i0 * 1013904223U);
  float n1 = hashNoise1D((uint32_t)i1 * 1013904223U);
  return n0 + u * (n1 - n0);
}

// Multi-octave natural flame turbulence (completely non-repeating, non-periodic)
inline float fireNoise(float tSec, uint32_t seedOffset = 0) {
  float t = tSec + (float)seedOffset * 0.317f;
  float n1 = smoothNoise(t * 0.35f);
  float n2 = smoothNoise(t * 1.35f + 17.31f);
  float n3 = smoothNoise(t * 4.20f + 53.17f);
  float n4 = smoothNoise(t * 10.50f + 89.73f);
  return (n1 * 0.38f + n2 * 0.32f + n3 * 0.18f + n4 * 0.12f) * 2.0f - 1.0f;
}

// Campfire chromaticity formula shared by Virtual Bonfire and Fireplace ambient mode
inline void fireChroma(float energy, float &rOut, float &gOut) {
  float gRatio = 0.215f + 0.195f * powf(energy, 0.75f);
  rOut = energy;
  gOut = gRatio * energy;
}

void renderBonfireFrame(uint64_t epochMs) {
  float minutesSinceLog = 0.0f;
  if (lastBonfireLogEpoch > 0 && epochMs > lastBonfireLogEpoch) {
    minutesSinceLog = (float)(epochMs - lastBonfireLogEpoch) / 60000.0f;
  }

  // Auto-extinguish at 60 minutes
  if (minutesSinceLog >= 60.0f) {
    Serial.println("60 minutes elapsed with no log: Bonfire died out.");
    extinguishBonfire(true, "timeout");
    return;
  }

  // Base perceived brightness:
  // 0 - 30 min: steady strong 75% (0.75)
  // 30 - 60 min: linear fade from 0.75 down to 0.0
  float basePerceived = 0.75f;
  if (minutesSinceLog > 30.0f) {
    float progress = (minutesSinceLog - 30.0f) / 30.0f; // 0.0 -> 1.0
    basePerceived = 0.75f * (1.0f - progress);
    if (basePerceived < 0.0f) basePerceived = 0.0f;
  }

  // Flare boost on log added (spikes to 100% and decays to base over ~20s)
  float flareBoost = 0.0f;
  if (flareStartEpoch > 0 && epochMs >= flareStartEpoch) {
    float flareElapsedSec = (float)(epochMs - flareStartEpoch) / 1000.0f;
    if (flareElapsedSec < 20.0f) {
      flareBoost = (1.0f - basePerceived) * expf(-flareElapsedSec / 5.0f);
    } else {
      isBonfireFlaring = false;
    }
  }

  float targetPerceived = basePerceived + flareBoost;
  if (targetPerceived > 1.0f) targetPerceived = 1.0f;
  if (targetPerceived <= 0.001f) {
    strip.clear();
    strip.show();
    return;
  }

  float tSec = (float)(epochMs % 86400000ULL) / 1000.0f;

  // Occasional micro-draft flame surges (pops) - lively and natural
  float popNoise = smoothNoise(tSec * 0.65f + 137.91f);
  float pop = 0.0f;
  if (popNoise > 0.65f) {
    float pVal = (popNoise - 0.65f) / 0.35f;
    pop = pVal * pVal * 0.28f; // Noticeable natural flame lick
  }

  // Scale flicker with fire strength
  float flickerScale = targetPerceived / 0.75f;
  if (flickerScale > 1.0f) flickerScale = 1.0f;
  if (flickerScale < 0.20f) flickerScale = 0.20f;

  // Global shared breathing pulse (noticeable campfire flicker matching PCB strength)
  float globalTurbulence = fireNoise(tSec, 100);
  float globalFlicker = (globalTurbulence * 0.24f + pop) * flickerScale;
  float basePerceivedLed = targetPerceived + globalFlicker;

  // Asynchronous flame tongues across 16 NeoPixels
  // Wood fire is a rich, natural mix of yellow-orange, campfire orange, and red-orange!
  for (int i = 0; i < NEOPIXEL_COUNT; i++) {
    // Unique spatial turbulence per LED for flickering dancing flame tongues
    float localNoise = fireNoise(tSec * 1.60f, (uint32_t)(i * 59 + 23));
    float localFlicker = (localNoise * 0.18f) * flickerScale;

    float ledPerceived = basePerceivedLed + localFlicker;
    if (ledPerceived > 1.0f) ledPerceived = 1.0f;
    if (ledPerceived < 0.02f) ledPerceived = 0.02f;

    // Organic temperature noise across the 16 LEDs:
    // Produces a rich, authentic mix of yellow-orange flame tips, campfire orange body, and deep red embers.
    // Coupled with local brightness so hotter flame tips flare yellow-orange and ember bases glow deep red.
    float tempNoise = fireNoise(tSec * 0.90f + 50.0f, (uint32_t)(i * 37 + 11));
    float gRatio = 0.44f + 0.10f * tempNoise + 0.06f * (ledPerceived - 0.60f);
    if (gRatio < 0.28f) gRatio = 0.28f;
    if (gRatio > 0.58f) gRatio = 0.58f;

    float ledR = ledPerceived;
    float ledG = gRatio * ledPerceived;

    // Apply single-pass gamma correction directly to hardware duty cycle
    uint8_t dR = applyGammaNeo(ledR);
    uint8_t dG = applyGammaNeo(ledG);
    uint8_t dB = 0; // ZERO blue to completely eliminate any pinkish hue
    strip.setPixelColor(i, strip.Color(dR, dG, dB));
  }
  strip.show();
}

// Write gamma-corrected duty with hardware min floor
void writeAmbientOutput(float rLin, float gLin, float bLin) {
  uint8_t dR = applyGammaNeo(rLin);
  uint8_t dG = applyGammaNeo(gLin);
  uint8_t dB = applyGammaNeo(bLin);

  // If any channel has intensity, ensure at least 1 count on the dominant channel(s)
  // so extreme dimming never leaves the lamp completely dark
  if (dR == 0 && dG == 0 && dB == 0 && (rLin > 0.0001f || gLin > 0.0001f || bLin > 0.0001f)) {
    if (rLin >= gLin && rLin >= bLin && rLin > 0.0001f) dR = 1;
    if (gLin >= rLin && gLin >= bLin && gLin > 0.0001f) dG = 1;
    if (bLin >= rLin && bLin >= gLin && bLin > 0.0001f) dB = 1;
  }

  setRGBRaw(dR, dG, dB);
}

void resolveAmbientEffect() {
  if (ambientColor == "FIRE") {
    currentAmbientEffect = AMBIENT_FIRE;
  } else if (ambientColor == "BREATH") {
    currentAmbientEffect = AMBIENT_BREATH;
  } else if (ambientColor == "LAVA") {
    currentAmbientEffect = AMBIENT_LAVA;
  } else if (ambientColor == "RAIN") {
    currentAmbientEffect = AMBIENT_RAIN;
  } else if (ambientColor == "AURORA") {
    currentAmbientEffect = AMBIENT_AURORA;
  } else if (ambientColor.startsWith("#") && ambientColor.length() == 7) {
    long number = strtol(ambientColor.substring(1).c_str(), NULL, 16);
    ambSolidR = (number >> 16) & 0xFF;
    ambSolidG = (number >> 8)  & 0xFF;
    ambSolidB =  number        & 0xFF;
    currentAmbientEffect = AMBIENT_SOLID;
  } else {
    // Fallback: warm amber (#FFAA00)
    ambSolidR = 255;
    ambSolidG = 170;
    ambSolidB = 0;
    currentAmbientEffect = AMBIENT_SOLID;
  }
  nextRainFlareMs = 0;
  rainFlareStartMs = 0;
  breathPhase = 0.0f;
}

void renderAmbientFrame() {
  unsigned long now = millis();
  if (now - lastAmbientFrameMs < AMBIENT_FRAME_MS) return;
  unsigned long dt = (lastAmbientFrameMs == 0) ? AMBIENT_FRAME_MS : (now - lastAmbientFrameMs);
  lastAmbientFrameMs = now;

  float A = ((float)dayMaxBrightness / 255.0f) * AMBIENT_RATIO;
  float tSec = (float)(now % 86400000UL) / 1000.0f;
  float r = 0.0f, g = 0.0f, b = 0.0f;

  switch (currentAmbientEffect) {
    case AMBIENT_SOLID: {
      r = (float)ambSolidR / 255.0f;
      g = (float)ambSolidG / 255.0f;
      b = (float)ambSolidB / 255.0f;
      break;
    }
    case AMBIENT_FIRE: {
      float popNoise = smoothNoise(tSec * 0.65f + 211.37f);
      float pop = 0.0f;
      if (popNoise > 0.70f) {
        float p = (popNoise - 0.70f) / 0.30f;
        pop = p * p * 0.20f;
      }
      float energy = 0.75f + fireNoise(tSec, 200) * 0.22f + pop;
      if (energy < 0.35f) energy = 0.35f;
      if (energy > 1.00f) energy = 1.00f;
      fireChroma(energy, r, g);
      b = 0.0f;
      break;
    }
    case AMBIENT_BREATH: {
      float period = 10000.0f * (1.0f + 0.06f * (smoothNoise(tSec * 0.05f + 7.7f) * 2.0f - 1.0f));
      breathPhase += (float)dt / period;
      if (breathPhase >= 1.0f) breathPhase -= 1.0f;

      float p = breathPhase;
      float e = 0.0f;
      if (p < 0.38f) {
        e = 0.5f - 0.5f * cosf(3.14159265f * p / 0.38f);            // Inhale ~3.8s
      } else if (p < 0.44f) {
        e = 1.0f;                                                   // Soft crest ~0.6s
      } else if (p < 0.92f) {
        e = 0.5f + 0.5f * cosf(3.14159265f * (p - 0.44f) / 0.48f); // Exhale ~4.8s
      } else {
        e = 0.0f;                                                   // Rest ~0.8s
      }

      float level = 0.18f + 0.82f * e;
      // Lavender at rest (#9D4EDD), warming toward blush (#C77DFF) at crest
      r = (0.616f + (0.780f - 0.616f) * e) * level;
      g = (0.306f + (0.490f - 0.306f) * e) * level;
      b = (0.867f + (1.000f - 0.867f) * e) * level;
      break;
    }
    case AMBIENT_LAVA: {
      float p = (float)(now % 60000UL) / 60000.0f;
      float k = 0.5f - 0.5f * cosf(2.0f * 3.14159265f * p);
      float level = 0.92f + 0.08f * smoothNoise(tSec * 0.15f + 41.0f);
      // Molten Coral (#FF4500) to Golden Amber (#FFAA00)
      r = 1.0f * level;
      g = (0.2706f + (0.6667f - 0.2706f) * k) * level;
      b = 0.0f;
      break;
    }
    case AMBIENT_RAIN: {
      if (nextRainFlareMs == 0) {
        nextRainFlareMs = now + (unsigned long)random(120000, 240001);
      }
      float env = 0.0f;
      if (now >= nextRainFlareMs && rainFlareStartMs == 0) {
        rainFlareStartMs = now;
        nextRainFlareMs = now + (unsigned long)random(120000, 240001);
      }
      if (rainFlareStartMs > 0) {
        unsigned long f = now - rainFlareStartMs;
        if (f < 150) {
          env = sinf(3.14159265f * (float)f / 150.0f);
        } else if (f >= 220 && f < 400) {
          env = 0.7f * sinf(3.14159265f * (float)(f - 220) / 180.0f);
        } else if (f >= 400) {
          rainFlareStartMs = 0;
        }
      }
      float level = 0.55f + 0.45f * env;
      // Slate Blue (#2B3A42 normalized to blue: 0.6515, 0.8788, 1.0) with soft white accents (0.92, 0.95, 1.0)
      r = (0.6515f + (0.9200f - 0.6515f) * env) * level;
      g = (0.8788f + (0.9500f - 0.8788f) * env) * level;
      b = (1.0000f + (1.0000f - 1.0000f) * env) * level;
      break;
    }
    case AMBIENT_AURORA: {
      float hWave = 0.7f * sinf(2.0f * 3.14159265f * (float)(now % 45000UL) / 45000.0f) +
                    0.3f * sinf(2.0f * 3.14159265f * (float)(now % 17300UL) / 17300.0f + 1.3f);
      float h = 200.0f + 80.0f * hWave; // range 120 (emerald) to 280 (violet)
      if (h < 120.0f) h = 120.0f;
      if (h > 280.0f) h = 280.0f;

      // Convert HSV (h, s=0.85, v=1.0) to RGB
      float s = 0.85f;
      float v = 1.0f;
      float cVal = v * s;
      float hPrime = h / 60.0f;
      float xVal = cVal * (1.0f - fabsf(fmodf(hPrime, 2.0f) - 1.0f));
      float mVal = v - cVal;
      float rH = 0.0f, gH = 0.0f, bH = 0.0f;
      if (hPrime >= 2.0f && hPrime < 3.0f) {
        rH = 0.0f; gH = cVal; bH = xVal;
      } else if (hPrime >= 3.0f && hPrime < 4.0f) {
        rH = 0.0f; gH = xVal; bH = cVal;
      } else if (hPrime >= 4.0f && hPrime <= 5.0f) {
        rH = xVal; gH = 0.0f; bH = cVal;
      }
      float level = 0.85f + 0.15f * sinf(2.0f * 3.14159265f * (float)(now % 23000UL) / 23000.0f);
      r = (rH + mVal) * level;
      g = (gH + mVal) * level;
      b = (bH + mVal) * level;
      break;
    }
  }

  float outR = r * A;
  float outG = g * A;
  float outB = b * A;

  lastAmbOutR = outR;
  lastAmbOutG = outG;
  lastAmbOutB = outB;

  writeAmbientOutput(outR, outG, outB);
}

// =============================================================================
// Serial Command Task (runs on Core 0, independent of main loop)
// =============================================================================
void serialCommandTask(void *pvParameters) {
  String buffer = "";
  for (;;) {
    while (Serial.available()) {
      char c = Serial.read();
      if (c == '\n' || c == '\r') {
        buffer.trim();
        if (buffer.length() > 0) {
          processSerialCommand(buffer);
        }
        buffer = "";
      } else {
        buffer += c;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(50)); 
  }
}

void processSerialCommand(String cmd) {
  Serial.println("[CMD] Received: " + cmd);

  if (cmd == "RESET_WIFI") {
    Serial.println("[CMD] Erasing WiFi credentials and rebooting...");
    wifiManager.resetSettings();
    rtcBootMarker = 0; 
    delay(500);
    ESP.restart();

  } else if (cmd == "RESET_CONFIG") {
    Serial.println("[CMD] Deleting /config.json and rebooting...");
    Serial.println("[CMD] On next boot, lamp will enter SEND_CONFIG mode (30s serial window).");
    LittleFS.remove("/config.json");
    delay(500);
    ESP.restart();

  } else if (cmd == "RESET_ALL") {
    Serial.println("[CMD] Factory reset: erasing WiFi + config + state...");
    wifiManager.resetSettings();
    LittleFS.remove("/config.json");
    LittleFS.remove("/state.json");
    rtcBootMarker = 0;
    delay(500);
    ESP.restart();

  } else if (cmd.startsWith("SET_CONFIG:")) {
    String json = cmd.substring(11); 
    json.trim();
    JsonDocument doc;
    if (deserializeJson(doc, json)) {
      Serial.println("[CMD] ERROR: Invalid JSON in SET_CONFIG.");
      return;
    }
    
    File wf = LittleFS.open("/config.json", "w");
    if (wf) {
      serializeJsonPretty(doc, wf);
      wf.close();
      Serial.println("[CMD] Config saved to /config.json. Rebooting...");
      delay(500);
      ESP.restart();
    } else {
      Serial.println("[CMD] ERROR: Failed to write /config.json.");
    }

  } else if (cmd == "GET_CONFIG") {
    if (LittleFS.exists("/config.json")) {
      File f = LittleFS.open("/config.json", "r");
      if (f) {
        Serial.println("[CMD] CONFIG_START");
        while (f.available()) Serial.write(f.read());
        Serial.println();
        Serial.println("[CMD] CONFIG_END");
        f.close();
      }
    } else {
      Serial.println("[CMD] No /config.json found.");
    }

  } else if (cmd == "GET_STATE") {
    if (LittleFS.exists("/state.json")) {
      File f = LittleFS.open("/state.json", "r");
      if (f) {
        Serial.println("[CMD] STATE_START");
        while (f.available()) Serial.write(f.read());
        Serial.println();
        Serial.println("[CMD] STATE_END");
        f.close();
      }
    } else {
      Serial.println("[CMD] No /state.json found.");
    }

  } else if (cmd == "GET_STATUS") {
    Serial.println("[CMD] STATUS_START");
    Serial.println("WiFi: " + String(WiFi.status() == WL_CONNECTED ? "CONNECTED" : "DISCONNECTED"));
    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("IP: " + WiFi.localIP().toString());
      Serial.println("SSID: " + WiFi.SSID());
      Serial.println("RSSI: " + String(WiFi.RSSI()) + " dBm");
    }
    Serial.println("MQTT: " + String(mqttClient.connected() ? "CONNECTED" : "DISCONNECTED"));
    Serial.println("Device ID: " + device_id);
    Serial.println("Owner Name: " + (owner_name.length() > 0 ? owner_name : "(not set)"));
    Serial.println("MQTT Server: " + mqtt_server);
    Serial.println("Role: " + (role.length() > 0 ? role : "unset"));
    Serial.println("Status Topic: " + statusTopicPub);
    Serial.println("MAC: " + WiFi.macAddress());
    Serial.println("[CMD] STATUS_END");

  } else if (cmd == "SCAN_WIFI") {
    Serial.println("[CMD] Scanning for WiFi networks...");
    int n = WiFi.scanNetworks();
    Serial.println("[CMD] SCAN_START");
    if (n == 0) {
      Serial.println("[CMD] No networks found.");
    } else {
      for (int i = 0; i < n; i++) {
        // Output: SSID, RSSI, Encryption status code
        Serial.println(WiFi.SSID(i) + "," + String(WiFi.RSSI(i)) + "," + String(WiFi.encryptionType(i)));
      }
    }
    Serial.println("[CMD] SCAN_END");
    WiFi.scanDelete();

  } else if (cmd.startsWith("SET_WIFI:")) {
    String data = cmd.substring(9); 
    int commaPos = data.indexOf(',');
    if (commaPos == -1) {
      Serial.println("[CMD] ERROR: Format is SET_WIFI:ssid,password");
      return;
    }
    String ssid = data.substring(0, commaPos);
    String password = data.substring(commaPos + 1);
    ssid.trim();
    password.trim();
    if (ssid.length() == 0) {
      Serial.println("[CMD] ERROR: SSID cannot be empty.");
      return;
    }
    Serial.println("[CMD] Setting WiFi credentials...");
    Serial.println("[CMD] SSID: " + ssid);
    Serial.println("[CMD] Password: " + String(password.length() > 0 ? "(set)" : "(open network)"));
    // Save network configuration to NVS and restart interfaces
    wifiManager.resetSettings(); // Clear old credentials first
    WiFi.begin(ssid.c_str(), password.c_str());
    delay(1000); 
    Serial.println("[CMD] WiFi credentials saved. Rebooting...");
    ESP.restart();

  } else if (cmd == "MAKE_PRIMARY") {
    Serial.println("[CMD] Promoting lamp to PRIMARY role...");
    pauseCore1 = true;
    delay(50);
    // Clear secondary status topic state
    String topicPrefix = "linkedlamp/";
    String d_sep = mqtt_delimiter;
    if (mqtt_delimiter == "_") {
      topicPrefix = mqtt_user + "/f/ll_";
    }
    String secStatusTopic = topicPrefix + device_id + "2" + d_sep + "status";

    if (mqttClient.connected()) {
      
      mqttClient.publish(secStatusTopic.c_str(), "", true);
      mqttClient.loop();
      delay(200);
      Serial.println("[CMD] Cleared secondary status topic: " + secStatusTopic);
    } else {
      Serial.println("[CMD] WARNING: MQTT not connected, could not clear secondary status.");
    }

    role = "primary";
    saveState();
    Serial.println("[CMD] Role set to PRIMARY. Rebooting...");
    isRebooting = true;
    if (mqttClient.connected()) mqttClient.disconnect();
    delay(500);
    ESP.restart();

  } else if (cmd == "MAKE_SECONDARY") {
    Serial.println("[CMD] Demoting lamp to SECONDARY role...");
    pauseCore1 = true;
    delay(50);
    // Clear primary status topic state
    String topicPrefix = "linkedlamp/";
    String d_sep = mqtt_delimiter;
    if (mqtt_delimiter == "_") {
      topicPrefix = mqtt_user + "/f/ll_";
    }
    String priStatusTopic = topicPrefix + device_id + d_sep + "status";

    if (mqttClient.connected()) {
      
      mqttClient.publish(priStatusTopic.c_str(), "", true);
      mqttClient.loop();
      delay(200);
      Serial.println("[CMD] Cleared primary status topic: " + priStatusTopic);
    } else {
      Serial.println("[CMD] WARNING: MQTT not connected, could not clear primary status.");
    }

    role = "secondary";
    saveState();
    Serial.println("[CMD] Role set to SECONDARY. Rebooting...");
    isRebooting = true;
    if (mqttClient.connected()) mqttClient.disconnect();
    delay(500);
    ESP.restart();

  } else if (cmd == "RESET_ROLE") {
    Serial.println("[CMD] Clearing role (will auto-detect on next boot)...");
    pauseCore1 = true;
    delay(50);
    
    if (mqttClient.connected() && statusTopicPub.length() > 0) {
      mqttClient.publish(statusTopicPub.c_str(), "", true);
      mqttClient.loop();
      delay(200);
      Serial.println("[CMD] Cleared current status topic: " + statusTopicPub);
    } else if (!mqttClient.connected()) {
      Serial.println("[CMD] WARNING: MQTT not connected, could not clear current status.");
    }

    role = "";
    saveState();
    Serial.println("[CMD] Role cleared. Rebooting...");
    isRebooting = true;
    if (mqttClient.connected()) mqttClient.disconnect();
    delay(500);
    ESP.restart();

  } else if (cmd == "REBOOT") {
    Serial.println("[CMD] Rebooting...");
    delay(500);
    ESP.restart();

  } else if (cmd.startsWith("SET_NAME:")) {
    String newName = cmd.substring(9);
    newName.trim();
    if (newName.length() == 0) {
      Serial.println("[CMD] ERROR: Name cannot be empty. Usage: SET_NAME:YourName");
    } else {
      owner_name = newName;
      Serial.println("[CMD] Owner name set to: " + owner_name);
      // Update config.json with the new name
      if (LittleFS.exists("/config.json")) {
        File f = LittleFS.open("/config.json", "r");
        if (f) {
          JsonDocument doc;
          if (!deserializeJson(doc, f)) {
            f.close();
            doc["owner_name"] = owner_name;
            File wf = LittleFS.open("/config.json", "w");
            if (wf) {
              serializeJsonPretty(doc, wf);
              wf.close();
              Serial.println("[CMD] Config updated with new name.");
            }
          } else {
            f.close();
          }
        }
      }
      // Update companion devices with updated configuration parameters
      publishSettingsViaMQTT();
    }

  } else if (cmd == "GET_VERSION") {
    Serial.printf("[VERSION] %s (%s)%s\n", FIRMWARE_VERSION_STR, HW_TYPE, FIRMWARE_IS_BETA ? " [BETA]" : "");

  } else if (cmd == "HELP") {
    Serial.println("[CMD] Available commands:");
    Serial.println("  GET_VERSION     - Print firmware version and target");
    Serial.println("  RESET_WIFI      - Clear WiFi credentials and reboot (opens config portal)");
    Serial.println("  SCAN_WIFI       - Scan for nearby WiFi networks");
    Serial.println("  SET_WIFI:s,p    - Set new WiFi credentials (SSID,password) and reboot");
    Serial.println("  RESET_CONFIG    - Delete MQTT config and reboot (enters SEND_CONFIG mode)");
    Serial.println("  RESET_ALL       - Factory reset: clear WiFi + config + state");
    Serial.println("  SET_CONFIG:{}   - Set new config JSON and reboot");
    Serial.println("  GET_CONFIG      - Print current /config.json");
    Serial.println("  GET_STATE       - Print current /state.json");
    Serial.println("  GET_STATUS      - Print WiFi/MQTT/role status");
    Serial.println("  SET_NAME:x      - Set lamp owner name (saved to config, published to MQTT)");
    Serial.println("  MAKE_PRIMARY    - Promote to primary (clears secondary status, reboots)");
    Serial.println("  MAKE_SECONDARY  - Demote to secondary (clears primary status, reboots)");
    Serial.println("  RESET_ROLE      - Clear role (auto-detect on next boot)");
    Serial.println("  REBOOT          - Restart the device");
    Serial.println("  HELP            - Show this help message");

  } else {
    Serial.println("[CMD] Unknown command. Type HELP for available commands.");
  }
}

// =============================================================================
// OTA Update (blocking by necessity — flash access)
// =============================================================================
void performOTA(String url) {
  // Construct complete binary download path if target path is absent
  if (!url.endsWith(".bin")) {
    bool wantBeta = (url.indexOf("beta") != -1);
    int qIdx = url.indexOf('?');
    if (qIdx != -1) url = url.substring(0, qIdx);
    if (!url.endsWith("/")) url += "/";
    url += wantBeta ? "flash/firmware-neo-beta.bin" : "flash/firmware-neo.bin"; 
  }
  
  Serial.println("Starting OTA from: " + url);

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  const int MAX_RETRIES = 3;

  for (int attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    Serial.printf("\n=== OTA Attempt %d of %d ===\n", attempt, MAX_RETRIES);

    if (mqttClient.connected()) {
      String statusMsg = "OTA_START:" + String(attempt);
      mqttClient.publish(statusTopicPub.c_str(), statusMsg.c_str());
      mqttClient.loop();
    }

    WiFiClientSecure secureClient;
    secureClient.setInsecure();
    WiFiClient insecureClient;
    HTTPClient http;
    http.useHTTP10(true); // Override HTTP interface to force raw HTTP/1.0 streams (bypasses chunked encoding)
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
    http.setTimeout(15000);

    bool isHttps = url.startsWith("https");
    bool beginOk = isHttps ? http.begin(secureClient, url) : http.begin(insecureClient, url);

    if (!beginOk) {
      Serial.println("Error: Cannot connect to OTA URL.");
      if (attempt < MAX_RETRIES) { delay(5000); continue; }
      break;
    }

    int httpCode = http.GET();
    if (httpCode == HTTP_CODE_MOVED_PERMANENTLY || httpCode == HTTP_CODE_FOUND || httpCode == 307 || httpCode == 308) {
      String newUrl = http.getLocation();
      Serial.println("Redirected to: " + newUrl);
      http.end();
      url = newUrl;
      // Prevent redirect loops during network renegotiations
      continue;
    }

    if (httpCode != HTTP_CODE_OK) {
      Serial.printf("HTTP error: %d\n", httpCode);
      http.end();
      if (attempt < MAX_RETRIES) { delay(5000); continue; }
      break;
    }

    int totalSize = http.getSize();
    size_t updateSize = (totalSize > 0) ? totalSize : UPDATE_SIZE_UNKNOWN;

    if (totalSize <= 0) {
      Serial.println("Using UPDATE_SIZE_UNKNOWN for chunked transfer.");
    } else {
      Serial.printf("Firmware size: %d bytes\n", totalSize);
    }

    if (!Update.begin(updateSize)) {
      Serial.println("Error: Not enough space for OTA!");
      http.end();
      if (attempt < MAX_RETRIES) { delay(5000); continue; }
      break;
    }

    WiFiClient* stream = http.getStreamPtr();
    size_t written = 0;
    uint8_t buff[1024];
    unsigned long lastDataTime = millis();
    const unsigned long INACTIVITY_TIMEOUT = 30000;
    bool downloadOk = true;

    while (http.connected() || stream->available() > 0) {
      // Break if we already reached known size
      if (totalSize > 0 && written >= (size_t)totalSize) break;

      size_t available = stream->available();
      if (available) {
        int bytesRead = stream->readBytes(buff, min(available, sizeof(buff)));
        size_t bytesWritten = Update.write(buff, bytesRead);
        if (bytesWritten != (size_t)bytesRead) {
          downloadOk = false;
          Serial.println("\nOTA Write Failed.");
          break;
        }
        written += bytesWritten;
        lastDataTime = millis();

        
        if (written % 102400 < 1024) {
          Serial.printf("  OTA progress: %d bytes written...\n", written);
        }
      } else {
        if (millis() - lastDataTime > INACTIVITY_TIMEOUT) {
          Serial.println("\nOTA stalled (30s timeout).");
          downloadOk = false;
          break;
        }
        delay(1); // Yield to system scheduler to prevent watchdog resets
      }
    }

    if (downloadOk && written > 0) {
      if (Update.end(true)) {
        Serial.printf("\nOTA Success! %d bytes written. Rebooting...\n", written);
        if (mqttClient.connected()) {
          mqttClient.publish(statusTopicPub.c_str(), "OTA_SUCCESS");
          mqttClient.loop();
          delay(500);
        }
        delay(1000);
        ESP.restart();
      } else {
        Serial.printf("OTA verify failed. Error: %d\n", Update.getError());
      }
    } else {
      Update.abort();
      Serial.printf("OTA download failed. Written: %d bytes\n", written);
    }

    http.end();
    if (attempt < MAX_RETRIES) { delay(5000); }
  }

  Serial.println("OTA FAILED after all attempts.");
  if (mqttClient.connected()) {
    mqttClient.publish(statusTopicPub.c_str(), "OTA_FAILED");
    mqttClient.loop();
  }
}