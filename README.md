# Linked Lamp 💡

An open-source Wi-Fi connected **Friendship Lamp**. Tap your lamp to let someone know you're thinking of them — their lamp lights up in your chosen color.

## ✨ Features

- **Touch Gestures**: Tap to send, double-tap to turn off, hold to pick a new color
- **Breathing Glow**: 20-second pulsing animation when a signal arrives, then steady light
- **Customizable**: Set your default color, lamp-on duration (1–30 min), and max brightness
- **Nighttime Mode**: Schedule quiet hours with reduced brightness or lamp fully off
- **Web App**: Send signals, manage presets, and adjust settings from your phone
- **Preset Signals**: Quick-send "I Love You", "I Miss You", or custom messages
- **OTA Updates**: Firmware updates pushed wirelessly with automatic rollback protection

## 🔧 Hardware Needed

| Component | Details |
|---|---|
| ESP32-WROOM Dev Board | USB-C powered |
| TTP223 Touch Sensor | Capacitive, Active HIGH |
| 7× RGB LEDs | Common Anode, wired in parallel |
| 3× 2N2222 NPN Transistors | + 330Ω base resistors each |

### Wiring

| Signal | GPIO |
|---|---|
| Touch Sensor | 4 |
| Red LED Channel | 13 |
| Green LED Channel | 14 |
| Blue LED Channel | 27 |

Schematic and PCB files are in `Circuit/`. 3D printable enclosure files are in `3D Models/`.

## 🚀 Setup

### Easy Way: Browser-Based Setup Wizard

If you just want to build and use the lamp without modifying the code:

1. Go to the [Setup Wizard](https://aarushmagic.github.io/Linked-Lamp/setup.html) in **Google Chrome** or **Microsoft Edge**
2. Enter your HiveMQ credentials and names
3. Connect each ESP32 via USB and click **Flash** — the wizard handles everything

### Advanced Way: PlatformIO (for developers who want to customize)

If you want to modify the firmware, use a different MQTT provider, or have full control:

#### What You Need

- [VS Code](https://code.visualstudio.com/) with [PlatformIO](https://platformio.org/) extension installed
- An MQTT broker account (e.g., free [HiveMQ Cloud](https://www.hivemq.com/mqtt-cloud-broker/))

#### Step 1: Configure Your Lamp

1. In the `firmware/data/` folder, copy `config.example.json` and rename it to `config.json`
2. Open `config.json` and fill in your details:
   ```json
   {
     "device_id": "A",
     "mqtt_server": "your-broker.s1.eu.hivemq.cloud",
     "mqtt_port": 8883,
     "mqtt_user": "your_username",
     "mqtt_pass": "your_password",
     "ota_url": "https://www.linkedlamp.com"
   }
   ```
   - Set `device_id` to `"A"` for the first lamp and `"B"` for the second
   - Use the same broker/credentials for both lamps
   - Don't edit `ota_url` unless you have a custom domain and want to make personal changes to the firmware
      - If you do choose to do this, you would also have to update the `triggerUpdate()` function in `docs/script.js`

#### Step 2: Flash the Firmware & Config

1. Open the `firmware/` folder in VS Code with PlatformIO.
2. **Flash the Config (LittleFS)**:
   - In the PlatformIO sidebar (Alien icon), go to **Project Tasks → esp32dev → Platform**.
   - Click **Build Filesystem Image** and wait for SUCCESS.
   - Click **Upload Filesystem Image** and wait for SUCCESS. *(This pushes your `config.json` info to the lamp's internal storage).*
3. **Flash the Code**:
   - Now, click the regular **Upload** button (the `→` arrow icon on the bottom blue bar) to flash the main `main.cpp` codebase.
4. Repeat for the second lamp (making sure to change `device_id` to `"B"` in your `config.json` before flashing its filesystem image!)

### Step 3: Connect to WiFi

On first power-up, each lamp creates a WiFi network called **"Linked Lamp Setup"**. Connect to it from your phone, select your home WiFi network, and enter the password. The lamp will remember this across restarts.

### Step 4: Open the Web App

The web app is already hosted. Open this URL on your phone (bookmark it!):

```
https://aarushmagic.github.io/Linked-Lamp/?s=BROKER_URL&u=USERNAME&p=PASSWORD&id=A&name=Sarah
```

Replace the values:
- `s` = your MQTT broker URL
- `u` = MQTT username  
- `p` = MQTT password
- `id` = `A` or `B` (must match the lamp's `device_id`)
- `name` = the **other** person's name (this appears as "Sarah's Lamp" in the app)

After the first visit, credentials are saved — you can just open the page normally.

## 📱 How to Use

| Action | What Happens |
|---|---|
| **Single Tap** | Sends your default color to the other lamp |
| **Double Tap** | Turns off your lamp (if it's on) |
| **Triple Tap** | Resets WiFi settings (only works when lamp is off) |
| **Hold 1.5s+** | Cycles through colors — lift your finger to pick one |

## 🔄 Pushing Firmware Updates (For Maintainers)

After making code changes, you can push OTA updates to all lamps without plugging them in:

1. Compile in PlatformIO — the binary is at `firmware/.pio/build/esp32dev/firmware.bin`
2. Run the build helper: `python docs/flash/build_template.py` — this copies the binary to both `docs/flash/` (for browser flashing) and `docs/firmware.bin` (for OTA updates)
3. Commit and push to GitHub — GitHub Pages will serve the `.bin` files
4. The ESP32 auto-checks for updates every 7 days, or users can tap "Check for Update" in the web app

The ESP32 downloads the binary, flashes it, and reboots. If the new firmware crashes before reaching `setup()`, it automatically rolls back to the previous working version.

## 📜 License

GNU General Public License v3.0 — see [LICENSE](https://www.gnu.org/licenses/gpl-3.0.html).

## 🙏 Credits

[WiFiManager](https://github.com/tzapu/WiFiManager) · [PubSubClient](https://github.com/knolleary/pubsubclient) · [ArduinoJson](https://github.com/bblanchon/ArduinoJson) · [iro.js](https://iro.js.org/) · [MQTT.js](https://github.com/mqttjs/MQTT.js) · [esptool-js](https://github.com/espressif/esptool-js)
