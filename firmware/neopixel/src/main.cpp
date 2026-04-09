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
 *   - arduino-libraries/NTPClient
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
// BLE removed — was causing radio contention with WiFi SSL and iOS bonding failures
#include <mbedtls/pk.h>
#include <mbedtls/md.h>
#include <mbedtls/entropy.h>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/base64.h>

// =============================================================================
// Hardware Type Definition
// =============================================================================
#define HW_TYPE "neopixel"

// =============================================================================
// Pin Definitions
// =============================================================================
#define TOUCH_SENSOR_PIN 4   // Input, Active HIGH
#define NEOPIXEL_PIN     27  // Output to NeoPixel Data In (Din)
#define NEOPIXEL_COUNT   24  // Number of LEDs in the ring

Adafruit_NeoPixel strip(NEOPIXEL_COUNT, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);

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

// Firebase (loaded from config, empty = feature disabled)
String firebase_client_email  = "";
String firebase_private_key   = "";
String firebase_project_id    = "";  // auto-extracted from email

// Away Mode state (persisted in state.json)
String pushToken    = "";
String pushDeviceId = "";
bool   awayModeEnabled = false;



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

// MQTT Topics (populated dynamically after config load)
String triggerTopicSub;
String triggerTopicPub;
String settingsTopicSub;
String otaTopicSub;
String statusTopicPub;

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

String buildOnlineMsg();
void sendFCMAsync(String token, String title, String body);
String hexToEmoji(String hexColor);

// =============================================================================
// Setup
// =============================================================================
void setup() {
  Serial.setRxBufferSize(4096);
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
  Serial.println("My Device ID: " + device_id);
  Serial.println("Target Device ID: " + target_id);

  // Build MQTT Topics (Auto-detect Adafruit IO to use required feeds/ routing)
  String topicPrefix = "linkedlamp/";
  String d_sep = "/";
  String suf_ota = "system/ota";

  if (mqtt_server.indexOf("adafruit") != -1 && mqtt_user.length() > 0) {
    topicPrefix = mqtt_user + "/f/ll_";
    d_sep = "_";
    suf_ota = "system_ota"; // Adafruit doesn't support nested slashes in feed names mapping
  }

  triggerTopicSub  = topicPrefix + device_id + d_sep + "color_trigger";
  settingsTopicSub = topicPrefix + device_id + d_sep + "settings";
  otaTopicSub      = topicPrefix + device_id + d_sep + suf_ota;
  triggerTopicPub  = topicPrefix + target_id + d_sep + "color_trigger";
  statusTopicPub   = topicPrefix + device_id + d_sep + "status";

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

  // OTA Rollback Protection: firmware is NOT marked valid until MQTT connects successfully.
  // If this firmware can't reach MQTT, the bootloader will auto-revert on next boot.

  // Configure NTP with user timezone
  configTzTime(userTimezone.c_str(), "pool.ntp.org", "time.nist.gov");
  Serial.println("NTP configured with timezone: " + userTimezone);
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
    setRGB(0, 120, 0);
    delay(200);
    setRGB(0, 0, 0);
  }


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
          String onlineMsg = buildOnlineMsg();
          mqttClient.publish(statusTopicPub.c_str(), onlineMsg.c_str(), true);
          Serial.println("Status correction: re-published ONLINE (was showing OFFLINE)");
        }
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

  strip.begin();           // INITIALIZE NeoPixel strip object
  strip.show();            // Turn OFF all pixels ASAP
  strip.setBrightness(255); // We handle brightness manually in setRGB()
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
        firebase_client_email = doc["firebase_client_email"] | "";
        firebase_private_key  = doc["firebase_private_key"]  | "";
        firebase_private_key.replace("\"", "");
        firebase_private_key.replace("\\r", "");
        firebase_private_key.replace("\\n", "\n");
        int bIdx = firebase_private_key.indexOf("-----BEGIN");
        if (bIdx > 0) firebase_private_key = firebase_private_key.substring(bIdx);
        firebase_private_key.trim();
        firebase_private_key += "\n";

        // Extract project ID from service account email
        if (firebase_client_email.length() > 0) {
          int atIdx = firebase_client_email.indexOf('@');
          int iamIdx = firebase_client_email.indexOf(".iam.");
          if (atIdx > 0 && iamIdx > atIdx) {
            firebase_project_id = firebase_client_email.substring(atIdx + 1, iamIdx);
          }
        }
        
        Serial.println("\n=== CONFIG LOADED FROM LITTLEFS ===");
        Serial.printf("MQTT Server: %s\n", mqtt_server.c_str());
        Serial.printf("Firebase Client Email: %s\n", firebase_client_email.c_str());
        Serial.printf("Firebase Project ID: %s\n", firebase_project_id.c_str());
        Serial.printf("Firebase Private Key Length: %d\n", firebase_private_key.length());
        if (firebase_private_key.length() > 60) {
            Serial.printf("PK Head: '%s'\n", firebase_private_key.substring(0, 30).c_str());
            Serial.printf("PK Tail: '%s'\n", firebase_private_key.substring(firebase_private_key.length() - 30).c_str());
        } else {
            Serial.printf("PK Raw: '%s'\n", firebase_private_key.c_str());
        }
        Serial.println("===================================");

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
    serialBuffer.reserve(4096);

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
              firebase_client_email = doc["firebase_client_email"] | "";
              firebase_private_key  = doc["firebase_private_key"]  | "";
              firebase_private_key.replace("\"", "");
              firebase_private_key.replace("\\r", "");
              firebase_private_key.replace("\\n", "\n");
              int bIdx = firebase_private_key.indexOf("-----BEGIN");
              if (bIdx > 0) firebase_private_key = firebase_private_key.substring(bIdx);
              firebase_private_key.trim();
              firebase_private_key += "\n";

              if (firebase_client_email.length() > 0) {
                int atIdx = firebase_client_email.indexOf('@');
                int iamIdx = firebase_client_email.indexOf(".iam.");
                if (atIdx > 0 && iamIdx > atIdx) {
                  firebase_project_id = firebase_client_email.substring(atIdx + 1, iamIdx);
                }
              }

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
    pushToken             = doc["pushToken"]         | "";
    pushDeviceId          = doc["pushDeviceId"]      | "";
    awayModeEnabled       = doc["awayMode"]           | false;
    Serial.println("State loaded. Default color: " + defaultColor);
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
  doc["pushToken"]    = pushToken;
  doc["pushDeviceId"] = pushDeviceId;
  doc["awayMode"]     = awayModeEnabled;

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
  mqttClient.setBufferSize(1024); // Larger buffer for JSON settings + push token payloads
  mqttClient.setKeepAlive(60);   // 60s keep-alive (default 15s is too aggressive)
}

// =============================================================================
// MQTT Handlers
// =============================================================================
void handleMqttReconnect() {
  if (millis() - lastMqttReconnectAttempt < MQTT_RECONNECT_INTERVAL) return;
  lastMqttReconnectAttempt = millis();

  // Force clean disconnect after repeated failures
  if (mqttFailCount >= 3) {
    Serial.println("Multiple MQTT failures — forcing clean disconnect...");
    mqttClient.disconnect();
    delay(100);
    mqttFailCount = 0;
  }

  Serial.print("Attempting MQTT connection...");
  String clientId = "LinkedLamp-" + device_id + "-" + String(random(0xffff), HEX);

  // Connect with Last Will and Testament
  if (mqttClient.connect(clientId.c_str(), mqtt_user.c_str(), mqtt_pass.c_str(),
                          statusTopicPub.c_str(), 1, true, "OFFLINE")) {
    Serial.println("Connected to MQTT!");
    mqttFailCount = 0;

    // Announce ONLINE with retained message
    String onlineMsg = buildOnlineMsg();
    mqttClient.publish(statusTopicPub.c_str(), onlineMsg.c_str(), true);
    selfStatusOnline = false; // Will be confirmed when we receive our own retained msg
    lastStatusCheck = millis();
    Serial.println("Published " + onlineMsg + " status.");

    // Subscribe to all topics
    mqttClient.subscribe(triggerTopicSub.c_str());
    mqttClient.subscribe(settingsTopicSub.c_str());
    mqttClient.subscribe(otaTopicSub.c_str());
    mqttClient.subscribe(statusTopicPub.c_str()); // Self-monitor for stale OFFLINE

    // OTA Rollback Protection: mark this firmware as valid once we've proven we can connect
    esp_ota_mark_app_valid_cancel_rollback();
    Serial.println("Firmware marked as valid (rollback cancelled).");

  } else {
    mqttFailCount++;
    Serial.printf("Failed, rc=%d (attempt %d)\n", mqttClient.state(), mqttFailCount);

    // After 6 failures (~30s), force WiFi reconnect
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

  if (topicStr == triggerTopicSub) {
    // --- Incoming Color Trigger ---
    // Parse the target color
    String hexColor = msg;
    if (hexColor.startsWith("#")) hexColor.remove(0, 1);
    long number = strtol(hexColor.c_str(), NULL, 16);
    uint8_t newR = (number >> 16) & 0xFF;
    uint8_t newG = (number >> 8)  & 0xFF;
    uint8_t newB =  number        & 0xFF;

    // Determine if nighttime
    bool isNight = nightModeEnabled && isNighttime();

    // Apply appropriate settings
    if (isNight) {
      currentMaxBrightness = nightMaxBrightness;
      lampDurationMs = (unsigned long)nightLampOnTimeMinutes * 60000UL;

      // If night brightness is 0, keep lamp off entirely
      if (nightMaxBrightness == 0) {
        Serial.println("Nighttime mode: lamp kept OFF (brightness=0).");
        return;
      }
    } else {
      currentMaxBrightness = dayMaxBrightness;
      lampDurationMs = (unsigned long)lampOnTimeMinutes * 60000UL;
    }

    // If lamp is currently off, reset displayed color to black so we fade FROM black (or from ambient!)
    if (!isLampOn) {
      if (ambientModeEnabled && !(nightModeEnabled && isNighttime())) {
        String hexColor = ambientColor;
        if (hexColor.startsWith("#")) hexColor.remove(0, 1);
        long number = strtol(hexColor.c_str(), NULL, 16);
        uint8_t ambR = (number >> 16) & 0xFF;
        uint8_t ambG = (number >> 8)  & 0xFF;
        uint8_t ambB =  number        & 0xFF;
        int ambientBrightness = max(1, dayMaxBrightness / 20);
        // Scale so that when handleLEDs scales by currentMaxBrightness, it equals ambientBrightness
        currentR = min(255, (ambR * ambientBrightness) / max(1, currentMaxBrightness));
        currentG = min(255, (ambG * ambientBrightness) / max(1, currentMaxBrightness));
        currentB = min(255, (ambB * ambientBrightness) / max(1, currentMaxBrightness));
      } else {
        currentR = 0;
        currentG = 0;
        currentB = 0;
      }
    }

    // Start gradual color transition (fade from current color to new color)
    startColorTransition(newR, newG, newB);

    isLampOn = true;
    lampOnStartTime = millis();
    isPulsing = true;
    pulseStartTime = millis();
    Serial.println("Trigger received! Lamp ON with gradual transition.");

    // Away Mode: send push notification
    if (awayModeEnabled && pushToken.length() > 0 && firebase_client_email.length() > 0) {
      String emoji = hexToEmoji(msg);
      sendFCMAsync(pushToken, "Linked Lamp", "New tap received! " + emoji);
    }

  } else if (topicStr == settingsTopicSub) {
    parseSettings(msg);

  } else if (topicStr == otaTopicSub) {
    Serial.println("OTA triggered via MQTT! URL: " + msg);
    performOTA(msg);

  } else if (topicStr == statusTopicPub) {
    // Self-status monitoring: detect and correct stale OFFLINE retained messages
    if (msg.startsWith("ONLINE")) {
      selfStatusOnline = true;
    } else {
      selfStatusOnline = false;
      // Immediately attempt to correct stale OFFLINE
      String onlineMsg = buildOnlineMsg();
      mqttClient.publish(statusTopicPub.c_str(), onlineMsg.c_str(), true);
      Serial.println("Detected stale OFFLINE status — corrected to ONLINE.");
    }
  }
}

void parseSettings(String payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return; // Parse error

  if (doc["defaultColor"].is<const char*>()) {
    defaultColor = doc["defaultColor"].as<String>();
  }
  if (doc["dayTimeMin"].is<int>())   lampOnTimeMinutes      = doc["dayTimeMin"];
  if (doc["dayBright"].is<int>())    dayMaxBrightness       = doc["dayBright"];
  if (doc["nightMode"].is<bool>())   nightModeEnabled       = doc["nightMode"];
  if (doc["nightTimeMin"].is<int>()) nightLampOnTimeMinutes = doc["nightTimeMin"];
  if (doc["nightBright"].is<int>())  nightMaxBrightness     = doc["nightBright"];
  if (doc["nightStart"].is<const char*>()) nightStartTime   = doc["nightStart"].as<String>();
  if (doc["nightEnd"].is<const char*>())   nightEndTime     = doc["nightEnd"].as<String>();
  if (doc["timezone"].is<const char*>()) {
    userTimezone = doc["timezone"].as<String>();
    configTzTime(userTimezone.c_str(), "pool.ntp.org", "time.nist.gov");
    Serial.println("Timezone updated: " + userTimezone);
  }
  if (doc["ambientMode"].is<bool>()) ambientModeEnabled = doc["ambientMode"];
  if (doc["ambientColor"].is<const char*>()) ambientColor = doc["ambientColor"].as<String>();
  if (doc["pushToken"].is<const char*>()) pushToken = doc["pushToken"].as<String>();
  if (doc["deviceId"].is<const char*>()) pushDeviceId = doc["deviceId"].as<String>();
  if (doc["away_mode"].is<bool>()) {
    bool newAwayMode = doc["away_mode"];
    if (newAwayMode != awayModeEnabled) {
      awayModeEnabled = newAwayMode;
    }
  }

  saveState();
  Serial.println("Settings updated from web interface.");
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
  doc["pushToken"]    = pushToken;
  doc["deviceId"]     = pushDeviceId;
  doc["away_mode"]    = awayModeEnabled;

  String payload;
  serializeJson(doc, payload);
  mqttClient.publish(settingsTopicSub.c_str(), payload.c_str(), true); // retained
  Serial.println("Settings published to MQTT: " + payload);
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
      setRGB(0, 0, 0);
    } else {
      Serial.println("Double Tap ignored: lamp already off.");
    }

  } else if (tapCount == 3) {
    // --- Triple+ Tap ---
    if (isLampOn) {
      // Turn off lamp (same as double tap when ON)
      Serial.println("Triple Tap: Turning OFF (lamp was on).");
      isLampOn = false;
      isPulsing = false;
      isTransitioning = false;
      setRGB(0, 0, 0);
    } else {
      Serial.println("Triple Tap ignored: lamp already off.");
    }
  } else if (tapCount >- 5) {
        if (isLampOn) {
      // Turn off lamp (same as double tap when ON)
      Serial.println("Triple Tap: Turning OFF (lamp was on).");
      isLampOn = false;
      isPulsing = false;
      isTransitioning = false;
      setRGB(0, 0, 0);
    } else {
      // Reset WiFi (only from OFF state)
      Serial.println("Triple Tap: Resetting WiFi credentials...");
      // Visual feedback: flash red
      setRGB(255, 0, 0);
      delay(300);
      setRGB(0, 0, 0);
      delay(300);
      setRGB(255, 0, 0);
      delay(300);
      setRGB(0, 0, 0);

      // Clear away mode state before reset
      pushToken = "";
      pushDeviceId = "";
      awayModeEnabled = false;

      saveState();

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

      // Brightness capped at 5% of daytime max brightness
      int ambientBrightness = max(1, dayMaxBrightness / 20);
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
    setRGB(0, 0, 0);
    Serial.println("Timer expired. Lamp OFF.");
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
  // Apply the same color to all NeoPixels in the ring
  uint32_t color = strip.Color(r, g, b);
  strip.fill(color);
  strip.show();
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
// OTA Update (blocking by necessity — flash access)
// =============================================================================
void performOTA(String url) {
  // If a base URL is provided without the path, auto-append the correct firmware path
  if (!url.endsWith(".bin")) {
    if (!url.endsWith("/")) url += "/";
    url += "flash/firmware-neo.bin"; 
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

// =============================================================================
// Away Mode: Utility
// =============================================================================
String buildOnlineMsg() {
  String msg = String("ONLINE:") + HW_TYPE;
  if (firebase_client_email.length() > 0) {
    msg += ":" + firebase_client_email;
  }
  return msg;
}

// =============================================================================
// Away Mode: Color to Emoji Mapping
// =============================================================================
String hexToEmoji(String hexColor) {
  if (hexColor.startsWith("#")) hexColor.remove(0, 1);
  long number = strtol(hexColor.c_str(), NULL, 16);
  uint8_t r = (number >> 16) & 0xFF;
  uint8_t g = (number >> 8) & 0xFF;
  uint8_t b = number & 0xFF;

  // Map to closest emoji heart based on dominant channel
  if (r > g && r > b) {
    if (g > 100) return "\xF0\x9F\xA7\xA1"; // 🧡 orange
    if (b > 100) return "\xF0\x9F\x92\x97"; // 💗 pink
    return "\xE2\x9D\xA4\xEF\xB8\x8F";     // ❤️ red
  }
  if (g > r && g > b) return "\xF0\x9F\x92\x9A"; // 💚 green
  if (b > r && b > g) {
    if (r > 100) return "\xF0\x9F\x92\x9C"; // 💜 purple
    return "\xF0\x9F\x92\x99";              // 💙 blue
  }
  if (r > 200 && g > 200 && b > 200) return "\xF0\x9F\xA4\x8D"; // 🤍 white
  if (r > 200 && g > 200) return "\xF0\x9F\x92\x9B"; // 💛 yellow
  return "\xF0\x9F\x92\x97"; // 💗 default
}

// =============================================================================
// Away Mode: FCM Push Notification via Raw JWT + HTTP
// =============================================================================
static String base64UrlEncode(const uint8_t* data, size_t len) {
  // Calculate base64 output size
  size_t b64Len = 0;
  mbedtls_base64_encode(NULL, 0, &b64Len, data, len);
  
  uint8_t* b64Buf = (uint8_t*)malloc(b64Len + 1);
  if (!b64Buf) return "";
  
  size_t written = 0;
  mbedtls_base64_encode(b64Buf, b64Len + 1, &written, data, len);
  b64Buf[written] = 0;
  
  // Convert to URL-safe base64
  String result = String((char*)b64Buf);
  free(b64Buf);
  result.replace("+", "-");
  result.replace("/", "_");
  // Remove padding
  while (result.endsWith("=")) {
    result.remove(result.length() - 1);
  }
  return result;
}

static String createJWT(const String& email, const String& privateKeyPem) {
  // Header
  String header = "{\"alg\":\"RS256\",\"typ\":\"JWT\"}";
  String b64Header = base64UrlEncode((const uint8_t*)header.c_str(), header.length());
  
  // Claims
  time_t now;
  time(&now);
  String claims = "{\"iss\":\"" + email + "\","
                  "\"scope\":\"https://www.googleapis.com/auth/firebase.messaging\","
                  "\"aud\":\"https://oauth2.googleapis.com/token\","
                  "\"iat\":" + String((unsigned long)now) + ","
                  "\"exp\":" + String((unsigned long)(now + 3600)) + "}";
  String b64Claims = base64UrlEncode((const uint8_t*)claims.c_str(), claims.length());
  
  // Sign
  String signInput = b64Header + "." + b64Claims;
  
  // SHA-256 hash of sign input
  uint8_t hash[32];
  mbedtls_md_context_t mdCtx;
  mbedtls_md_init(&mdCtx);
  mbedtls_md_setup(&mdCtx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&mdCtx);
  mbedtls_md_update(&mdCtx, (const uint8_t*)signInput.c_str(), signInput.length());
  mbedtls_md_finish(&mdCtx, hash);
  mbedtls_md_free(&mdCtx);
  
  Serial.println("\n[FCM JWT GENERATION]");
  Serial.printf("PK Length received by createJWT: %d\n", privateKeyPem.length());
  if (privateKeyPem.length() > 60) {
      Serial.printf("- Key Head: '%s'\n", privateKeyPem.substring(0, 31).c_str());
      Serial.printf("- Key Tail: '%s'\n", privateKeyPem.substring(privateKeyPem.length() - 31).c_str());
  } else {
      Serial.printf("- Key Raw Content: '%s'\n", privateKeyPem.c_str());
  }

  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  
  Serial.println("FCM: Calling mbedtls_pk_parse_key...");
  int ret = mbedtls_pk_parse_key(&pk, (const uint8_t*)privateKeyPem.c_str(),
                                  privateKeyPem.length() + 1, NULL, 0);
  if (ret != 0) {
    Serial.printf("PK parse failed: -0x%04X\n", -ret);
    mbedtls_pk_free(&pk);
    return "";
  }
  
  uint8_t sig[256];
  size_t sigLen = 0;
  
  mbedtls_entropy_context entropy;
  mbedtls_ctr_drbg_context ctrDrbg;
  mbedtls_entropy_init(&entropy);
  mbedtls_ctr_drbg_init(&ctrDrbg);
  mbedtls_ctr_drbg_seed(&ctrDrbg, mbedtls_entropy_func, &entropy, NULL, 0);
  
  ret = mbedtls_pk_sign(&pk, MBEDTLS_MD_SHA256, hash, 32, sig, &sigLen,
                         mbedtls_ctr_drbg_random, &ctrDrbg);
  
  mbedtls_pk_free(&pk);
  mbedtls_ctr_drbg_free(&ctrDrbg);
  mbedtls_entropy_free(&entropy);
  
  if (ret != 0) {
    Serial.printf("PK sign failed: -0x%04X\n", -ret);
    return "";
  }
  
  String b64Sig = base64UrlEncode(sig, sigLen);
  return signInput + "." + b64Sig;
}

// FCM: Cached OAuth token and mutex for memory safety
static String cachedAccessToken = "";
static unsigned long cachedTokenExpiry = 0;
static SemaphoreHandle_t fcmSemaphore = NULL;
static unsigned long lastFcmSendTime = 0;

// FCM task parameters (heap-allocated, freed by task)
struct FCMTaskParams {
  String token;
  String title;
  String body;
  String email;
  String projectId;
  // privateKey is NOT copied — we read from the global to save ~1.7KB heap
};

static String obtainAccessToken(const String& email) {
  // Check if cached token is still valid (with 10-min safety margin)
  if (cachedAccessToken.length() > 0 && millis() < cachedTokenExpiry) {
    Serial.println("FCM: Using cached access token.");
    return cachedAccessToken;
  }
  
  Serial.println("FCM: Generating new JWT & exchanging for access token...");
  
  // Step 1: Create JWT using the global private key (no copy needed)
  String jwt = createJWT(email, firebase_private_key);
  if (jwt.length() == 0) {
    Serial.println("FCM: JWT creation failed.");
    return "";
  }
  
  // Step 2: Exchange JWT for access token
  String accessToken = "";
  {
    WiFiClientSecure client;
    client.setInsecure();

    HTTPClient http;
    
    http.begin(client, "https://oauth2.googleapis.com/token");
    http.addHeader("Content-Type", "application/x-www-form-urlencoded");
    http.setTimeout(15000);
    String tokenBody = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + jwt;
    
    // Clear JWT immediately — it's been copied into tokenBody
    jwt.clear();
    
    int httpCode = http.POST(tokenBody);
    tokenBody.clear(); // Free the large POST body
    
    if (httpCode == 200) {
      String response = http.getString();
      JsonDocument tokenDoc;
      if (!deserializeJson(tokenDoc, response)) {
        accessToken = tokenDoc["access_token"].as<String>();
      }
    } else {
      Serial.printf("FCM: Token exchange failed: %d\n", httpCode);
    }
    
    http.end();
    client.stop(); // Explicitly tear down SSL — frees ~16KB heap
    Serial.printf("FCM: Heap after OAuth cleanup: %u bytes\n", ESP.getFreeHeap());
  } // WiFiClientSecure and HTTPClient destructors fire here
  
  if (accessToken.length() > 0) {
    cachedAccessToken = accessToken;
    cachedTokenExpiry = millis() + (50UL * 60UL * 1000UL); // Cache for 50 minutes
    Serial.println("FCM: Access token cached for 50 minutes.");
  }
  
  return accessToken;
}

static void fcmTask(void* pvParameters) {
  FCMTaskParams* p = (FCMTaskParams*)pvParameters;
  Serial.println("\n+++ FCM ASYNC TASK TRIGGERED +++");
  Serial.printf("Recipient Push Token: %.40s...\n", p->token.c_str());
  Serial.printf("Heap at task start: %u bytes\n", ESP.getFreeHeap());
  Serial.println("++++++++++++++++++++++++++++++++++");
  
  // Step 1: Get access token (cached or fresh)
  String accessToken = obtainAccessToken(p->email);
  if (accessToken.length() == 0) {
    Serial.println("FCM: Failed to obtain access token.");
    delete p;
    xSemaphoreGive(fcmSemaphore);
    vTaskDelete(NULL);
    return;
  }
  
  // Step 2: Send FCM notification using a FRESH SSL client
  {
    WiFiClientSecure client;
    client.setInsecure();

    HTTPClient http;
    
    String fcmUrl = "https://fcm.googleapis.com/v1/projects/" + p->projectId + "/messages:send";
    http.begin(client, fcmUrl);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", "Bearer " + accessToken);
    http.setTimeout(15000);
    
    // Build payload — use data-only (no "notification" key) so iOS always
    // routes through the service worker's onBackgroundMessage handler.
    // A "notification" key causes iOS to auto-display and suppress the SW.
    JsonDocument msgDoc;
    msgDoc["message"]["token"] = p->token;
    msgDoc["message"]["data"]["title"] = p->title;
    msgDoc["message"]["data"]["body"] = p->body;
    
    // APNs: content-available wakes the SW; alert push-type + priority 10
    // ensures immediate delivery even when the app is backgrounded.
    msgDoc["message"]["apns"]["payload"]["aps"]["content-available"] = 1;
    msgDoc["message"]["apns"]["headers"]["apns-push-type"] = "alert";
    msgDoc["message"]["apns"]["headers"]["apns-priority"] = "10";

    String msgPayload;
    serializeJson(msgDoc, msgPayload);
    
    int httpCode = http.POST(msgPayload);
    if (httpCode == 200) {
      Serial.println("FCM: Push notification sent successfully!");
    } else {
      String errBody = http.getString();
      Serial.printf("FCM: Send failed: %d - %s\n", httpCode, errBody.c_str());
      // If 401, token expired — invalidate cache
      if (httpCode == 401) {
        cachedAccessToken.clear();
        cachedTokenExpiry = 0;
        Serial.println("FCM: Cached token invalidated (401).");
      }
    }
    
    http.end();
    client.stop(); // Explicitly tear down SSL — frees ~16KB heap
  }
  
  Serial.printf("FCM: Heap after full cleanup: %u bytes\n", ESP.getFreeHeap());
  
  delete p;
  xSemaphoreGive(fcmSemaphore); // Signal completion for the next notification
  vTaskDelete(NULL);
}

void sendFCMAsync(String token, String title, String body) {
  // Create binary semaphore on first call (not a mutex — avoids ownership crash)
  if (fcmSemaphore == NULL) {
    fcmSemaphore = xSemaphoreCreateBinary();
    xSemaphoreGive(fcmSemaphore); // Start as "available"
  }
  
  // Wait at least 30 minutes between FCM pushes to prevent notification spam
  if (millis() - lastFcmSendTime < 1800000) {
    Serial.println("FCM: Throttled — sent a push within the last 30min. Skipping.");
    return;
  }
  
  // Try to take the semaphore — if another FCM task is running, skip this one
  if (xSemaphoreTake(fcmSemaphore, 0) != pdTRUE) {
    Serial.println("FCM: Another push task is in progress, skipping.");
    return;
  }
  
  lastFcmSendTime = millis();
  
  FCMTaskParams* params = new FCMTaskParams();
  params->token = token;
  params->title = title;
  params->body = body;
  params->email = firebase_client_email;
  params->projectId = firebase_project_id;
  // Note: privateKey is read from the global `firebase_private_key` directly
  
  // Run on core 0 (protocol core) to avoid blocking LED animations on core 1
  // Stack increased to 12288 to accommodate SSL handshake overhead
  xTaskCreatePinnedToCore(fcmTask, "fcm_push", 12288, params, 1, NULL, 0);
  Serial.println("FCM: Push task launched (async).");
}