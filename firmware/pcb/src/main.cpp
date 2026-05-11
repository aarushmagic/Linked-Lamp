/**
 * Linked Lamp Firmware
 * 
 * A Wi-Fi connected "Friendship Lamp" using ESP32-WROOM.
 * Controls 7 common anode RGB LEDs via 3 NPN transistors driven by PWM.
 * Triggered by a TTP223 capacitive touch sensor (Active HIGH).
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

// =============================================================================
// Hardware Type Definition
// =============================================================================
#define HW_TYPE "pcb"

// =============================================================================
// Pin Definitions
// =============================================================================
#define TOUCH_SENSOR_PIN 4   // Input, Active HIGH
#define RED_PWM_PIN      13  // Output to NPN transistor base
#define GREEN_PWM_PIN    14  // Output to NPN transistor base
#define BLUE_PWM_PIN     27  // Output to NPN transistor base

// =============================================================================
// Configuration (loaded from LittleFS /config.json)
// =============================================================================
String device_id    = "A";
String target_id    = "B";
String mqtt_server  = "";
int    mqtt_port    = 8883;
String mqtt_user    = "";
String mqtt_pass    = "";
String ota_url      = "";  // Optional: base URL for auto-OTA checks

// Role: "primary", "secondary", or "" (unset = auto-detect on first boot)
String role = "";
bool   isSupplementary = false;

// Last Tap Time (Epoch)
unsigned long lastTapTimestamp = 0;

// =============================================================================
// User Settings (synced from web interface via MQTT, persisted in /state.json)
// =============================================================================
String defaultColor          = "#FF0000";
int    lampOnTimeMinutes     = 5;       // Daytime duration (minutes), 1-30
int    dayMaxBrightness      = 255;     // 0-255
bool   nightModeEnabled      = false;
String nightStartTime        = "22:00";
String nightEndTime          = "08:00";
int    nightLampOnTimeMinutes = 5;
int    nightMaxBrightness    = 128;
String userTimezone          = "EST5EDT"; // POSIX TZ string
bool   ambientModeEnabled    = false;
String ambientColor          = "#0000FF";

// =============================================================================
// State & Timing Variables
// =============================================================================
bool           isLampOn           = false;
unsigned long  lampOnStartTime    = 0;
unsigned long  lampDurationMs     = 300000UL; // 5 minutes default
bool           isPulsing          = false;
unsigned long  pulseStartTime     = 0;
const unsigned long PULSE_DURATION_MS = 20000; // 20 seconds pulsing

// Current displayed color (before brightness scaling)
uint8_t currentR = 0, currentG = 0, currentB = 0;
int     currentMaxBrightness = 255;

// PWM Channels
const int redChannel   = 0;
const int greenChannel = 1;
const int blueChannel  = 2;
const int pwmFreq      = 5000;
const int pwmResolution = 8;

// Touch Sensor State Machine
unsigned long lastTouchTime     = 0;
unsigned long touchStartTime    = 0;
int           tapCount          = 0;
bool          isTouching        = false;
bool          wasTouching       = false;
const unsigned long TAP_TIMEOUT = 400; // ms window for multi-taps
bool          longPressTriggered = false;

// Color Cycling (time-based, ~6 seconds per full rotation)
float hue              = 0.0;
bool  isCyclingColors  = false;
unsigned long cycleStartTimeMs = 0;
float cycleStartHue = 0.0;
const float CYCLE_PERIOD_MS = 6000.0; // 6 seconds per full hue rotation

// Color Transition (gradual fade between colors, ~5 seconds)
bool isTransitioning = false;
unsigned long transitionStartMs = 0;
const unsigned long TRANSITION_DURATION = 5000; // 5 seconds
uint8_t transFromR = 0, transFromG = 0, transFromB = 0;
uint8_t transToR = 0, transToG = 0, transToB = 0;

// Color Cycle State (CC: multi-color cycling from web presets)
struct CycleEntry {
  uint8_t r, g, b;
  unsigned long holdMs;
  unsigned long transMs;
};
const int MAX_CYCLE_ENTRIES = 10;
CycleEntry cycleEntries[MAX_CYCLE_ENTRIES];
int cycleEntryCount = 0;
int cycleCurrentIndex = 0;
bool isColorCycling = false;
unsigned long cycleStepStartMs = 0;
enum CyclePhase { CYCLE_HOLD, CYCLE_TRANSITION };
CyclePhase cyclePhase = CYCLE_HOLD;

// Send Flash (single tap: flash sent color briefly, then revert)
bool isSendFlashing = false;
unsigned long sendFlashStart = 0;
const unsigned long SEND_FLASH_DURATION = 1000; // 1 second confirmation flash
uint8_t preSendR = 0, preSendG = 0, preSendB = 0;
bool wasLampOnBeforeSend = false;

// Color Pick Flash (hold-release: flash selected color, then revert)
bool isColorPickFlashing = false;
unsigned long colorPickFlashStart = 0;
const unsigned long COLOR_PICK_FLASH_DURATION = 3000; // 3 seconds
uint8_t prePickR = 0, prePickG = 0, prePickB = 0;
bool wasLampOnBeforePick = false;

// =============================================================================
// WiFi State (modeled after sample.cpp)
// =============================================================================
WiFiManager     wifiManager;
WiFiClientSecure espClientSecure;
PubSubClient    mqttClient(espClientSecure);

bool           wifiConnected            = false;
bool           hasConnectedOnce         = false;
unsigned long  lastWifiReconnectAttempt  = 0;
const unsigned long WIFI_RECONNECT_INTERVAL = 15000;
unsigned long  wifiDisconnectedSince    = 0;
const unsigned long WIFI_RESTART_TIMEOUT  = 300000; // 5 minutes

// RTC Memory: survives software restart, cleared on power cycle
RTC_NOINIT_ATTR uint32_t rtcBootMarker;
const uint32_t BOOT_MARKER_VALUE = 0xCAFEBEEF;
bool isColdBoot = false;

// MQTT Reconnect
unsigned long  lastMqttReconnectAttempt = 0;
const unsigned long MQTT_RECONNECT_INTERVAL = 5000;
int            mqttFailCount = 0;

// MQTT Periodic Status Re-publish (guards against stale retained OFFLINE)
unsigned long  lastStatusCheck = 0;
const unsigned long STATUS_CHECK_INTERVAL = 300000; // 5 minutes
bool           selfStatusOnline = false; // Tracks our own retained status

// 24-Hour Refresher
unsigned long lastDailyRefresh = 0;
const unsigned long DAILY_REFRESH_INTERVAL = 86400000UL; // 24 hours

// MQTT Topics (populated dynamically after config load)
String triggerTopicSub;
String triggerTopicPub;
String settingsTopicSub;
String statusTopicPub;
String partnerStatusTopicSub;    // Partner's primary status (for web UI detection)
String partnerSupStatusTopicSub; // Partner's secondary status (for web UI detection)

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
void performOTA(String url);
float hexToHue(String hexColor);
bool isNighttime();
void publishSettingsViaMQTT();
void startColorTransition(uint8_t toR, uint8_t toG, uint8_t toB);
void parseColorCycle(String payload);
void serialCommandTask(void *pvParameters);
void processSerialCommand(String cmd);
void detectRole();

// =============================================================================
// Setup
// =============================================================================
void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n\n--- Linked Lamp Boot ---");

  // Detect cold boot vs software restart via RTC memory
  if (rtcBootMarker != BOOT_MARKER_VALUE) {
    isColdBoot = true;
    rtcBootMarker = BOOT_MARKER_VALUE;
    Serial.println("Cold boot detected (power cycle).");
  } else {
    isColdBoot = false;
    Serial.println("Software restart detected.");
  }

  setupPins();

  // Mount LittleFS (auto-format if mount fails, e.g. fresh flash or corrupted partition)
  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount failed even with format. Trying manual format...");
    LittleFS.format();
    LittleFS.begin(true);
  }
  loadConfig();
  loadState();

  // Determine Target ID
  target_id = (device_id == "A") ? "B" : "A";
  isSupplementary = (role == "secondary");
  Serial.println("My Device ID: " + device_id);
  Serial.println("Target Device ID: " + target_id);
  Serial.println("Role: " + (role.length() > 0 ? role : "UNSET (will auto-detect)"));

  // Build MQTT Topics (Auto-detect Adafruit IO to use required feeds/ routing)
  String topicPrefix = "linkedlamp/";
  String d_sep = "/";

  if (mqtt_server.indexOf("adafruit") != -1 && mqtt_user.length() > 0) {
    topicPrefix = mqtt_user + "/f/ll_";
    d_sep = "_";
  }

  triggerTopicSub  = topicPrefix + device_id + d_sep + "color_trigger";
  settingsTopicSub = topicPrefix + device_id + d_sep + "settings";
  triggerTopicPub  = topicPrefix + target_id + d_sep + "color_trigger";

  // Status topic depends on role: primary uses ll_A_status, secondary uses ll_A2_status
  if (isSupplementary) {
    statusTopicPub = topicPrefix + device_id + "2" + d_sep + "status";
  } else {
    statusTopicPub = topicPrefix + device_id + d_sep + "status";
  }

  // Partner status topics
  partnerStatusTopicSub    = topicPrefix + target_id + d_sep + "status";
  partnerSupStatusTopicSub = topicPrefix + target_id + "2" + d_sep + "status";

  // --- WiFi Setup (from sample.cpp pattern) ---
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

  // Auto-detect role on first boot (no role saved)
  if (role.length() == 0) {
    Serial.println("Role unset — will auto-detect after WiFi/MQTT connects...");
  }

  // OTA Rollback Protection: firmware is NOT marked valid until MQTT connects successfully.
  // If this firmware can't reach MQTT, the bootloader will auto-revert on next boot.

  // Configure NTP with user timezone
  configTzTime(userTimezone.c_str(), "pool.ntp.org", "time.nist.gov");
  Serial.println("NTP configured with timezone: " + userTimezone);

  // Start serial command listener on Core 0 (independent of main loop on Core 1)
  // This allows serial commands like RESET_WIFI even when MQTT connect is blocking
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
// Main Loop (NO delay() calls)
// =============================================================================
void loop() {
  wifiManager.process();
  handleWifi();
  handleTouch();
  handleLEDs();
}

// =============================================================================
// WiFi Connection Management (from sample.cpp)
// =============================================================================
void onWifiConnect() {
  wifiConnected = true;
  mqttFailCount = 0;

  Serial.println("WiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  // Set public DNS servers (preserves DHCP)
  ip_addr_t dns1, dns2;
  IP4_ADDR(&dns1.u_addr.ip4, 8, 8, 8, 8);
  dns1.type = IPADDR_TYPE_V4;
  IP4_ADDR(&dns2.u_addr.ip4, 1, 1, 1, 1);
  dns2.type = IPADDR_TYPE_V4;
  dns_setserver(0, &dns1);
  dns_setserver(1, &dns2);
  Serial.println("Public DNS set: 8.8.8.8 / 1.1.1.1");

  // Visual indicator on cold boot: brief color flash
  if (!hasConnectedOnce && isColdBoot) {
    hasConnectedOnce = true;
    // Flash green briefly to indicate WiFi connected
    setRGB(0, 120, 0);
    delay(200);
    setRGB(0, 0, 0);
    delay(200);
    setRGB(0, 0, 0);
    delay(200);
    setRGB(0, 120, 0);
    delay(200);
    setRGB(0, 0, 0);
  }

  // Set local time from NTP using user's timezone configuration
  configTzTime(userTimezone.c_str(), "pool.ntp.org", "time.nist.gov");
}

void handleWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiConnected) {
      onWifiConnect();
    }

    // Non-blocking MQTT reconnect
    if (!mqttClient.connected()) {
      handleMqttReconnect();
    } else {
      mqttClient.loop();

      // Periodically check self-status and correct if showing OFFLINE
      if (millis() - lastStatusCheck >= STATUS_CHECK_INTERVAL) {
        lastStatusCheck = millis();
        if (!selfStatusOnline) {
          String onlineMsg = String("ONLINE:") + HW_TYPE;
          mqttClient.publish(statusTopicPub.c_str(), onlineMsg.c_str(), true);
          Serial.println("Status correction: re-published ONLINE (was showing OFFLINE)");
        }
      }

      // 24-Hour Refresher: Constantly refresh retained messages just in case the broker drops them
      if (millis() - lastDailyRefresh >= DAILY_REFRESH_INTERVAL) {
        lastDailyRefresh = millis();
        
        // Push Status
        String onlineMsg = String("ONLINE:") + HW_TYPE;
        mqttClient.publish(statusTopicPub.c_str(), onlineMsg.c_str(), true);
        
        // Push Settings
        publishSettingsViaMQTT();
        
        Serial.println("24-Hour Refresher: Pushed retained status and settings to MQTT.");
      }
    }
  } else {
    // WiFi just dropped
    if (wifiConnected) {
      wifiConnected = false;
      wifiDisconnectedSince = millis();
      Serial.println("WiFi lost! Attempting reconnect...");
      WiFi.disconnect();
      WiFi.reconnect();
    }

    // If disconnected for over 5 minutes, reboot
    if (wifiDisconnectedSince > 0 && (millis() - wifiDisconnectedSince >= WIFI_RESTART_TIMEOUT)) {
      Serial.println("WiFi disconnected 5 min. Restarting...");
      ESP.restart();
    }

    // Periodic reconnect attempts
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

  ledcSetup(redChannel, pwmFreq, pwmResolution);
  ledcSetup(greenChannel, pwmFreq, pwmResolution);
  ledcSetup(blueChannel, pwmFreq, pwmResolution);

  ledcAttachPin(RED_PWM_PIN, redChannel);
  ledcAttachPin(GREEN_PWM_PIN, greenChannel);
  ledcAttachPin(BLUE_PWM_PIN, blueChannel);

  setRGB(0, 0, 0);
}

void loadConfig() {
  bool configValid = false;

  if (LittleFS.exists("/config.json")) {
    File f = LittleFS.open("/config.json", "r");
    if (f) {
      JsonDocument doc;
      if (!deserializeJson(doc, f)) {
        device_id    = doc["device_id"]   | "A";
        mqtt_server  = doc["mqtt_server"] | "";
        mqtt_port    = doc["mqtt_port"]   | 8883;
        mqtt_user    = doc["mqtt_user"]   | "";
        mqtt_pass    = doc["mqtt_pass"]   | "";
        ota_url      = doc["ota_url"]     | "";
        if (mqtt_server.length() > 0) {
          configValid = true;
          Serial.println("Config loaded from /config.json");
          Serial.println("MQTT Server: " + mqtt_server);
        }
      }
      f.close();
    }
  }

  // If no valid config, wait for JSON config via Serial (browser flasher)
  if (!configValid) {
    Serial.println("SEND_CONFIG");  // Signal to browser flasher
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
              device_id    = doc["device_id"]   | "A";
              mqtt_server  = doc["mqtt_server"] | "";
              mqtt_port    = doc["mqtt_port"]   | 8883;
              mqtt_user    = doc["mqtt_user"]   | "";
              mqtt_pass    = doc["mqtt_pass"]   | "";
              ota_url      = doc["ota_url"]     | "";

              // Save to LittleFS so we don't need Serial next boot
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
  mqttClient.setBufferSize(1024); // Larger buffer for JSON settings + color cycle payloads
  mqttClient.setKeepAlive(60);   // 60s keep-alive (default 15s is too aggressive)
}

// =============================================================================
// MQTT Handlers
// =============================================================================
void handleMqttReconnect() {
  if (millis() - lastMqttReconnectAttempt < MQTT_RECONNECT_INTERVAL) return;
  lastMqttReconnectAttempt = millis();

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
    connected = mqttClient.connect(clientId.c_str(), mqtt_user.c_str(), mqtt_pass.c_str());
  } else {
    connected = mqttClient.connect(clientId.c_str(), mqtt_user.c_str(), mqtt_pass.c_str(),
                            statusTopicPub.c_str(), 1, true, "OFFLINE");
  }

  if (connected) {
    Serial.println("Connected to MQTT!");
    mqttFailCount = 0;

    if (role.length() == 0) {
      detectRole();
      return;
    }

    String onlineMsg = String("ONLINE:") + HW_TYPE;
    mqttClient.publish(statusTopicPub.c_str(), onlineMsg.c_str(), true);
    selfStatusOnline = false;
    lastStatusCheck = millis();
    Serial.println("Published " + onlineMsg + " status to " + statusTopicPub);

    mqttClient.subscribe(triggerTopicSub.c_str());
    mqttClient.subscribe(settingsTopicSub.c_str());
    mqttClient.subscribe(statusTopicPub.c_str());

    esp_ota_mark_app_valid_cancel_rollback();
    Serial.println("Firmware marked as valid (rollback cancelled).");

  } else {
    mqttFailCount++;
    Serial.printf("Failed, rc=%d (attempt %d)\n", mqttClient.state(), mqttFailCount);

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
  String msg((char*)payload, length);

  Serial.println("MQTT [" + topicStr + "] " + msg);

  if (topicStr == triggerTopicSub) {
    if (msg.startsWith("OTA:")) {
      String url = msg.substring(4);
      Serial.println("OTA triggered via color_trigger! URL: " + url);
      performOTA(url);
      return;
    }

    if (msg.startsWith("CC:")) {
      parseColorCycle(msg);

      time_t now;
      time(&now);
      lastTapTimestamp = (unsigned long)now;
      publishSettingsViaMQTT();

    } else {
    String hexColor = msg;
    if (hexColor.startsWith("#")) hexColor.remove(0, 1);
    long number = strtol(hexColor.c_str(), NULL, 16);
    uint8_t newR = (number >> 16) & 0xFF;
    uint8_t newG = (number >> 8)  & 0xFF;
    uint8_t newB =  number        & 0xFF;

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

    if (!isLampOn) {
      if (ambientModeEnabled && !(nightModeEnabled && isNighttime())) {
        String hexColor = ambientColor;
        if (hexColor.startsWith("#")) hexColor.remove(0, 1);
        long number = strtol(hexColor.c_str(), NULL, 16);
        uint8_t ambR = (number >> 16) & 0xFF;
        uint8_t ambG = (number >> 8)  & 0xFF;
        uint8_t ambB =  number        & 0xFF;
        int ambientBrightness = max(1, dayMaxBrightness / 10);
        currentR = min(255, (ambR * ambientBrightness) / max(1, currentMaxBrightness));
        currentG = min(255, (ambG * ambientBrightness) / max(1, currentMaxBrightness));
        currentB = min(255, (ambB * ambientBrightness) / max(1, currentMaxBrightness));
      } else {
        currentR = 0;
        currentG = 0;
        currentB = 0;
      }
    }

    startColorTransition(newR, newG, newB);

    isLampOn = true;
    lampOnStartTime = millis();
    isPulsing = true;
    pulseStartTime = millis();
    Serial.println("Trigger received! Lamp ON with gradual transition.");

    time_t now;
    time(&now);
    lastTapTimestamp = (unsigned long)now;
    publishSettingsViaMQTT();
    } // end single color else

  } else if (topicStr == settingsTopicSub) {
    parseSettings(msg);

  } else if (topicStr == statusTopicPub) {
    if (msg.startsWith("ONLINE")) {
      selfStatusOnline = true;
    } else {
      selfStatusOnline = false;
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
  String data = payload.substring(3); // Strip "CC:" prefix
  cycleEntryCount = 0;

  int startPos = 0;
  while (startPos < (int)data.length() && cycleEntryCount < MAX_CYCLE_ENTRIES) {
    int semiPos = data.indexOf(';', startPos);
    String segment;
    if (semiPos == -1) {
      segment = data.substring(startPos);
      startPos = data.length(); // Done
    } else {
      segment = data.substring(startPos, semiPos);
      startPos = semiPos + 1;
    }

    // Parse "RRGGBB,hold,trans"
    int c1 = segment.indexOf(',');
    int c2 = segment.indexOf(',', c1 + 1);
    if (c1 == -1 || c2 == -1) continue; // Malformed entry, skip

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

  // Apply night/day brightness and duration settings
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

  // Initialize cycling state
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

  // Apply first color immediately
  setRGB((currentR * currentMaxBrightness) / 255,
         (currentG * currentMaxBrightness) / 255,
         (currentB * currentMaxBrightness) / 255);

  Serial.println("Color Cycle started!");
}

void parseSettings(String payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return;

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
  lastTapTimestamp       = newLastTap;

  if (newTimezone != userTimezone || changed) {
    userTimezone = newTimezone;
    configTzTime(userTimezone.c_str(), "pool.ntp.org", "time.nist.gov");
  }

  if (changed) {
    saveState();
    Serial.println("Settings updated from web interface (saved to flash).");
  } else {
    Serial.println("Settings received (no changes, skipping flash write).");
  }
}

// =============================================================================
// Publish settings via MQTT (e.g. after color pick from lamp)
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

  String payload;
  serializeJson(doc, payload);
  mqttClient.publish(settingsTopicSub.c_str(), payload.c_str(), true); // retained
  Serial.println("Settings published to MQTT: " + payload);
}

// =============================================================================
// Role Auto-Detection (runs once on first boot when role is unset)
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

  String topicPrefix = "linkedlamp/";
  String d_sep = "/";
  if (mqtt_server.indexOf("adafruit") != -1 && mqtt_user.length() > 0) {
    topicPrefix = mqtt_user + "/f/ll_";
    d_sep = "_";
  }
  String primaryStatusTopic = topicPrefix + device_id + d_sep + "status";

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

  if (roleDetectGotRetained) {
    role = "secondary";
    Serial.println("Primary lamp detected — this lamp will be SECONDARY.");
  } else {
    role = "primary";
    Serial.println("No primary lamp found — this lamp will be PRIMARY.");
  }

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

  // Set target as current (for after transition completes)
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

  // --- Finger just pressed down ---
  if (isTouching && !wasTouching) {
    if (millis() - lastTouchTime < 100) {
      wasTouching = isTouching;
      return;
    }
    touchStartTime = millis();
    longPressTriggered = false;
    isCyclingColors = false;
  }

  // --- Finger is being held ---
  if (isTouching && wasTouching) {
    unsigned long holdTime = millis() - touchStartTime;

    if (holdTime > 1500 && !longPressTriggered) {
      // Start cycling from current default color's hue
      hue = hexToHue(defaultColor);
      cycleStartHue = hue;
      cycleStartTimeMs = millis();
      longPressTriggered = true;

      // Save lamp state before cycling
      prePickR = currentR;
      prePickG = currentG;
      prePickB = currentB;
      wasLampOnBeforePick = isLampOn;
    }

    if (longPressTriggered) {
      isCyclingColors = true;

      // Time-based hue advancement (~6 seconds per full rotation)
      unsigned long elapsed = millis() - cycleStartTimeMs;
      hue = cycleStartHue + (elapsed / CYCLE_PERIOD_MS) * 360.0;
      while (hue >= 360.0) hue -= 360.0;

      // HSV to RGB (S=1, V=1)
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

      currentR = (uint8_t)((rf + m) * 255);
      currentG = (uint8_t)((gf + m) * 255);
      currentB = (uint8_t)((bf + m) * 255);

      setRGB(currentR, currentG, currentB);
    }
  }

  // --- Finger just released ---
  if (!isTouching && wasTouching) {
    if (longPressTriggered) {
      // Finished color picking — save new default
      isCyclingColors = false;
      char hexBuf[8];
      sprintf(hexBuf, "#%02X%02X%02X", currentR, currentG, currentB);
      defaultColor = String(hexBuf);
      Serial.println("New default color: " + defaultColor);
      saveState();

      // Publish updated settings to MQTT so web page updates instantly
      publishSettingsViaMQTT();

      // Start 3-second flash of the picked color, then revert
      isColorPickFlashing = true;
      colorPickFlashStart = millis();
      // currentR/G/B already has the picked color, setRGB will be handled by handleLEDs
      setRGB(currentR, currentG, currentB);
    } else {
      // Register as a tap ONLY if held for >50ms (debounce/false trigger prevention)
      if (millis() - touchStartTime > 50) {
        tapCount++;
        lastTouchTime = millis();
      }
    }
  }

  wasTouching = isTouching;

  // Process taps after timeout
  if (tapCount > 0 && !isTouching && (millis() - lastTouchTime > TAP_TIMEOUT)) {
    doActionBasedOnTaps();
    tapCount = 0;
  }
}

void doActionBasedOnTaps() {
  Serial.printf("Tap Count: %d\n", tapCount);

  if (tapCount == 1) {
    // --- Single Tap: Send signal to partner ---
    // Maintain current lamp state, flash sent color briefly, then revert
    Serial.println("Single Tap: Sending Signal!");

    // Save current state before flash
    preSendR = currentR;
    preSendG = currentG;
    preSendB = currentB;
    wasLampOnBeforeSend = isLampOn;

    // Parse default color for flash
    String hexColor = defaultColor;
    if (hexColor.startsWith("#")) hexColor.remove(0, 1);
    long number = strtol(hexColor.c_str(), NULL, 16);
    uint8_t flashR = (number >> 16) & 0xFF;
    uint8_t flashG = (number >> 8)  & 0xFF;
    uint8_t flashB =  number        & 0xFF;

    // Show the sent color immediately
    setRGB(flashR, flashG, flashB);

    // Start send flash timer
    isSendFlashing = true;
    sendFlashStart = millis();

    // Publish to partner
    if (mqttClient.connected()) {
      mqttClient.publish(triggerTopicPub.c_str(), defaultColor.c_str());
    } else {
      Serial.println("Warning: MQTT not connected, signal not sent.");
    }

  } else if (tapCount == 2) {
    // --- Double Tap ---
    if (isLampOn) {
      // Turn off lamp
      Serial.println("Double Tap: Turning OFF.");
      isLampOn = false;
      isPulsing = false;
      isTransitioning = false;
      isColorCycling = false;
      setRGB(0, 0, 0);
    } else {
      Serial.println("Double Tap ignored: lamp already off.");
    }

  }else if (tapCount == 3) {
    // --- Triple+ Tap ---
    if (isLampOn) {
      // Turn off lamp (same as double tap when ON)
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
      // Turn off lamp (same as double tap when ON)
      Serial.println("5+ Tap: Turning OFF (lamp was on).");
      isLampOn = false;
      isPulsing = false;
      isTransitioning = false;
      isColorCycling = false;
      setRGB(0, 0, 0);
    } else {
      // Reset WiFi (only from OFF state)
      Serial.println("5+ Tap: Resetting WiFi credentials...");
      // Visual feedback: flash red
      setRGB(255, 0, 0);
      delay(300);
      setRGB(0, 0, 0);
      delay(300);
      setRGB(255, 0, 0);
      delay(300);
      setRGB(0, 0, 0);

      wifiManager.resetSettings();
      rtcBootMarker = 0; // Force cold boot for config portal
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

  // Handle send flash (single tap confirmation)
  if (isSendFlashing) {
    if (millis() - sendFlashStart >= SEND_FLASH_DURATION) {
      isSendFlashing = false;
      // Revert to previous state
      if (wasLampOnBeforeSend) {
        currentR = preSendR;
        currentG = preSendG;
        currentB = preSendB;
        setRGB((currentR * currentMaxBrightness) / 255,
               (currentG * currentMaxBrightness) / 255,
               (currentB * currentMaxBrightness) / 255);
      } else {
        setRGB(0, 0, 0);
      }
      Serial.println("Send flash ended. Reverted to previous state.");
    }
    return; // Don't run other LED logic during flash
  }

  // Handle color pick flash (hold-release confirmation)
  if (isColorPickFlashing) {
    if (millis() - colorPickFlashStart >= COLOR_PICK_FLASH_DURATION) {
      isColorPickFlashing = false;
      // Revert to previous state
      if (wasLampOnBeforePick) {
        currentR = prePickR;
        currentG = prePickG;
        currentB = prePickB;
        setRGB((currentR * currentMaxBrightness) / 255,
               (currentG * currentMaxBrightness) / 255,
               (currentB * currentMaxBrightness) / 255);
        // Restore lamp on state
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
    return; // Don't run other LED logic during flash
  }

  if (!isLampOn) {
    if (ambientModeEnabled && !(nightModeEnabled && isNighttime())) {
      // Parse ambient color
      String hexColor = ambientColor;
      if (hexColor.startsWith("#")) hexColor.remove(0, 1);
      long number = strtol(hexColor.c_str(), NULL, 16);
      uint8_t ambR = (number >> 16) & 0xFF;
      uint8_t ambG = (number >> 8)  & 0xFF;
      uint8_t ambB =  number        & 0xFF;

      // Brightness capped at 10% of daytime max brightness
      int ambientBrightness = max(1, dayMaxBrightness / 10);
      setRGB((ambR * ambientBrightness) / 255, 
             (ambG * ambientBrightness) / 255, 
             (ambB * ambientBrightness) / 255);
    } else {
      setRGB(0, 0, 0);
    }
    return;
  }

  // Check auto-off timer
  if (millis() - lampOnStartTime >= lampDurationMs) {
    isLampOn = false;
    isPulsing = false;
    isTransitioning = false;
    isColorCycling = false;
    setRGB(0, 0, 0);
    Serial.println("Timer expired. Lamp OFF.");
    return;
  }

  // Handle color cycling (CC: multi-color presets)
  if (isColorCycling && cycleEntryCount > 0) {
    unsigned long stepElapsed = millis() - cycleStepStartMs;
    CycleEntry &cur = cycleEntries[cycleCurrentIndex];
    int nextIdx = (cycleCurrentIndex + 1) % cycleEntryCount;
    CycleEntry &nxt = cycleEntries[nextIdx];

    if (cyclePhase == CYCLE_HOLD) {
      // During hold: display current color
      currentR = cur.r;
      currentG = cur.g;
      currentB = cur.b;

      if (stepElapsed >= cur.holdMs) {
        // Move to transition phase
        cyclePhase = CYCLE_TRANSITION;
        cycleStepStartMs = millis();
      }
    } else {
      // During transition: interpolate from current to next
      if (cur.transMs == 0) {
        // Instant transition
        currentR = nxt.r;
        currentG = nxt.g;
        currentB = nxt.b;
        cycleCurrentIndex = nextIdx;
        cyclePhase = CYCLE_HOLD;
        cycleStepStartMs = millis();
      } else if (stepElapsed >= cur.transMs) {
        // Transition complete
        currentR = nxt.r;
        currentG = nxt.g;
        currentB = nxt.b;
        cycleCurrentIndex = nextIdx;
        cyclePhase = CYCLE_HOLD;
        cycleStepStartMs = millis();
      } else {
        // Interpolate
        float t = (float)stepElapsed / (float)cur.transMs;
        currentR = cur.r + (int)((nxt.r - cur.r) * t);
        currentG = cur.g + (int)((nxt.g - cur.g) * t);
        currentB = cur.b + (int)((nxt.b - cur.b) * t);
      }
    }

    // Apply brightness and pulsing
    uint8_t outR = currentR, outG = currentG, outB = currentB;
    if (isPulsing) {
      unsigned long pulseElapsed = millis() - pulseStartTime;
      if (pulseElapsed < PULSE_DURATION_MS) {
        float phase = (float)(pulseElapsed % 2000) / 2000.0 * 2.0 * PI;
        float pulseFactor = 0.3 + 0.7 * ((sin(phase) + 1.0) / 2.0);
        outR = (uint8_t)(currentR * pulseFactor * currentMaxBrightness / 255);
        outG = (uint8_t)(currentG * pulseFactor * currentMaxBrightness / 255);
        outB = (uint8_t)(currentB * pulseFactor * currentMaxBrightness / 255);
      } else {
        isPulsing = false;
        outR = (currentR * currentMaxBrightness) / 255;
        outG = (currentG * currentMaxBrightness) / 255;
        outB = (currentB * currentMaxBrightness) / 255;
      }
    } else {
      outR = (currentR * currentMaxBrightness) / 255;
      outG = (currentG * currentMaxBrightness) / 255;
      outB = (currentB * currentMaxBrightness) / 255;
    }

    setRGB(outR, outG, outB);
    return;
  }

  // Handle gradual color transition
  if (isTransitioning) {
    unsigned long elapsed = millis() - transitionStartMs;
    if (elapsed < TRANSITION_DURATION) {
      float t = (float)elapsed / (float)TRANSITION_DURATION;

      uint8_t r = transFromR + (int)((transToR - transFromR) * t);
      uint8_t g = transFromG + (int)((transToG - transFromG) * t);
      uint8_t b = transFromB + (int)((transToB - transFromB) * t);

      // Apply brightness and pulsing if active
      if (isPulsing) {
        unsigned long pulseElapsed = millis() - pulseStartTime;
        if (pulseElapsed < PULSE_DURATION_MS) {
          float phase = (float)(pulseElapsed % 2000) / 2000.0 * 2.0 * PI;
          float pulseFactor = 0.3 + 0.7 * ((sin(phase) + 1.0) / 2.0);
          r = (uint8_t)(r * pulseFactor * currentMaxBrightness / 255);
          g = (uint8_t)(g * pulseFactor * currentMaxBrightness / 255);
          b = (uint8_t)(b * pulseFactor * currentMaxBrightness / 255);
        } else {
          isPulsing = false;
          r = (r * currentMaxBrightness) / 255;
          g = (g * currentMaxBrightness) / 255;
          b = (b * currentMaxBrightness) / 255;
        }
      } else {
        r = (r * currentMaxBrightness) / 255;
        g = (g * currentMaxBrightness) / 255;
        b = (b * currentMaxBrightness) / 255;
      }

      setRGB(r, g, b);
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
      // Breathing effect: sine wave modulates brightness
      // ~2 second cycle, range ~0.3 to 1.0 (never fully off)
      float phase = (float)(elapsed % 2000) / 2000.0 * 2.0 * PI;
      float pulseFactor = 0.3 + 0.7 * ((sin(phase) + 1.0) / 2.0);

      int r = (int)(currentR * pulseFactor * currentMaxBrightness / 255);
      int g = (int)(currentG * pulseFactor * currentMaxBrightness / 255);
      int b = (int)(currentB * pulseFactor * currentMaxBrightness / 255);

      setRGB((uint8_t)r, (uint8_t)g, (uint8_t)b);
    } else {
      isPulsing = false;
      Serial.println("Pulsing ended. Steady ON.");
      setRGB((currentR * currentMaxBrightness) / 255,
             (currentG * currentMaxBrightness) / 255,
             (currentB * currentMaxBrightness) / 255);
    }
  }
  // Steady state: no need to continuously rewrite PWM
}

void setColor(String hexColor) {
  if (hexColor.startsWith("#")) hexColor.remove(0, 1);
  long number = strtol(hexColor.c_str(), NULL, 16);
  currentR = (number >> 16) & 0xFF;
  currentG = (number >> 8)  & 0xFF;
  currentB =  number        & 0xFF;
  Serial.printf("Color parsed: R:%d G:%d B:%d\n", currentR, currentG, currentB);
}

void setRGB(uint8_t r, uint8_t g, uint8_t b) {
  ledcWrite(redChannel, r);
  ledcWrite(greenChannel, g);
  ledcWrite(blueChannel, b);
}

// =============================================================================
// NTP / Time Helpers
// =============================================================================
bool isNighttime() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 0)) return false; // Non-blocking: timeout=0

  int nowMinutes = timeinfo.tm_hour * 60 + timeinfo.tm_min;

  // Parse "HH:MM" strings
  int startH = nightStartTime.substring(0, 2).toInt();
  int startM = nightStartTime.substring(3, 5).toInt();
  int endH   = nightEndTime.substring(0, 2).toInt();
  int endM   = nightEndTime.substring(3, 5).toInt();

  int startMinutes = startH * 60 + startM;
  int endMinutes   = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Same-day range (e.g. 01:00 - 06:00)
    return (nowMinutes >= startMinutes && nowMinutes < endMinutes);
  } else {
    // Overnight range (e.g. 22:00 - 08:00)
    return (nowMinutes >= startMinutes || nowMinutes < endMinutes);
  }
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

  if (delta < 0.001) return 0.0; // Achromatic

  float h = 0;
  if (maxC == r)      h = 60.0 * fmod(((g - b) / delta), 6.0);
  else if (maxC == g) h = 60.0 * (((b - r) / delta) + 2.0);
  else                h = 60.0 * (((r - g) / delta) + 4.0);

  if (h < 0) h += 360.0;
  return h;
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
    vTaskDelay(pdMS_TO_TICKS(50)); // Check every 50ms
  }
}

void processSerialCommand(String cmd) {
  Serial.println("[CMD] Received: " + cmd);

  if (cmd == "RESET_WIFI") {
    Serial.println("[CMD] Erasing WiFi credentials and rebooting...");
    wifiManager.resetSettings();
    rtcBootMarker = 0; // Force cold boot for config portal
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
    String json = cmd.substring(11); // Strip "SET_CONFIG:"
    json.trim();
    JsonDocument doc;
    if (deserializeJson(doc, json)) {
      Serial.println("[CMD] ERROR: Invalid JSON in SET_CONFIG.");
      return;
    }
    // Write to LittleFS
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
    Serial.println("MQTT Server: " + mqtt_server);
    Serial.println("Role: " + (role.length() > 0 ? role : "unset"));
    Serial.println("Status Topic: " + statusTopicPub);
    Serial.println("Uptime: " + String(millis() / 1000) + "s");
    Serial.println("[CMD] STATUS_END");

  } else if (cmd == "SCAN_WIFI") {
    Serial.println("[CMD] Scanning for WiFi networks...");
    int n = WiFi.scanNetworks();
    Serial.println("[CMD] SCAN_START");
    if (n == 0) {
      Serial.println("[CMD] No networks found.");
    } else {
      for (int i = 0; i < n; i++) {
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
    wifiManager.resetSettings();
    WiFi.begin(ssid.c_str(), password.c_str());
    delay(1000);
    Serial.println("[CMD] WiFi credentials saved. Rebooting...");
    ESP.restart();

  } else if (cmd == "MAKE_PRIMARY") {
    Serial.println("[CMD] Promoting lamp to PRIMARY role...");
    String topicPrefix = "linkedlamp/";
    String d_sep = "/";
    if (mqtt_server.indexOf("adafruit") != -1 && mqtt_user.length() > 0) {
      topicPrefix = mqtt_user + "/f/ll_";
      d_sep = "_";
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
    delay(500);
    ESP.restart();

  } else if (cmd == "MAKE_SECONDARY") {
    Serial.println("[CMD] Demoting lamp to SECONDARY role...");
    String topicPrefix = "linkedlamp/";
    String d_sep = "/";
    if (mqtt_server.indexOf("adafruit") != -1 && mqtt_user.length() > 0) {
      topicPrefix = mqtt_user + "/f/ll_";
      d_sep = "_";
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
    delay(500);
    ESP.restart();

  } else if (cmd == "RESET_ROLE") {
    Serial.println("[CMD] Clearing role (will auto-detect on next boot)...");
    role = "";
    saveState();
    Serial.println("[CMD] Role cleared. Rebooting...");
    delay(500);
    ESP.restart();

  } else if (cmd == "REBOOT") {
    Serial.println("[CMD] Rebooting...");
    delay(500);
    ESP.restart();

  } else if (cmd == "HELP") {
    Serial.println("[CMD] Available commands:");
    Serial.println("  RESET_WIFI      - Clear WiFi credentials and reboot (opens config portal)");
    Serial.println("  SCAN_WIFI       - Scan for nearby WiFi networks");
    Serial.println("  SET_WIFI:s,p    - Set new WiFi credentials (SSID,password) and reboot");
    Serial.println("  RESET_CONFIG    - Delete MQTT config and reboot (enters SEND_CONFIG mode)");
    Serial.println("  RESET_ALL       - Factory reset: clear WiFi + config + state");
    Serial.println("  SET_CONFIG:{}   - Set new config JSON and reboot");
    Serial.println("  GET_CONFIG      - Print current /config.json");
    Serial.println("  GET_STATE       - Print current /state.json");
    Serial.println("  GET_STATUS      - Print WiFi/MQTT/role status");
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
  // If a base URL is provided without the path, auto-append the correct firmware path
  if (!url.endsWith(".bin")) {
    if (!url.endsWith("/")) url += "/";
    url += "flash/firmware.bin"; 
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
    http.useHTTP10(true); // Force HTTP/1.0 — prevents chunked encoding so stream is raw firmware bytes
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
      // Do not decrement attempt so it consumes one retry, preventing infinite loops.
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

        // Progress every ~100KB
        if (written % 102400 < 1024) {
          Serial.printf("  OTA progress: %d bytes written...\n", written);
        }
      } else {
        if (millis() - lastDataTime > INACTIVITY_TIMEOUT) {
          Serial.println("\nOTA stalled (30s timeout).");
          downloadOk = false;
          break;
        }
        delay(1); // Yield to watchdog
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