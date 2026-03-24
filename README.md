<p align="center">
  <img src="docs/images/logo.png" alt="Linked Lamp" width="80">
</p>

<h1 align="center">Linked Lamp</h1>

<p align="center">
  An open-source Wi-Fi connected <strong>Friendship Lamp</strong>.<br>
  Tap your lamp to let someone know you're thinking of them — their lamp lights up in your chosen color, anywhere in the world.
</p>

<p align="center">
  <a href="https://linkedlamp.com">Website</a> · <a href="https://linkedlamp.com/setup.html">Setup Guide</a> · <a href="https://linkedlamp.com/faq.html">FAQ</a>
</p>

---

## ✨ Features

- **Touch Gestures** — Tap to send, double-tap to turn off, hold to pick a new color
- **Breathing Glow** — 20-second pulsing animation when a signal arrives, then steady light
- **Customizable** — Set your default color, lamp-on duration (1–30 min), and max brightness
- **Nighttime Mode** — Schedule quiet hours with reduced brightness or lamp fully off
- **Web App** — Send signals, manage presets, and adjust settings from your phone
- **Preset Signals** — Quick-send "I Love You", "I Miss You", or custom messages
- **OTA Updates** — Firmware updates pushed wirelessly with automatic rollback protection

## 🔧 Hardware Options

You'll need an **ESP32-WROOM** dev board, a **TTP223** touch sensor, and a 3D-printed enclosure. Then choose one of two lighting methods:

| | PCB | NeoPixel |
|---|---|---|
| **Light Source** | 6× Common Anode RGB LEDs on a custom PCB | WS2812B NeoPixel Ring (up to 24 LEDs, 66mm) |
| **Soldering** | Through-hole components onto PCB | 3 wires to the ESP32 |
| **Brightness** | Standard | Slightly brighter |

Both options produce nearly identical lamps. Any Linked Lamp can connect to any other Linked Lamp regardless of which method was used.

### Wiring

| Signal | GPIO |
|---|---|
| Touch Sensor (TTP223 IO) | 4 |
| **PCB** — Red / Green / Blue channels | 13 / 14 / 27 |
| **NeoPixel** — Data IN | 27 |

Schematics and PCB Gerber files are in `Circuit/`. 3D-printable enclosure files are in `3D Models/`.

## 🚀 Setup

### Browser-Based Setup (Recommended)

The [Setup Guide](https://linkedlamp.com/setup.html) walks you through the entire process:

1. **Parts** — Choose PCB or NeoPixel, download 3D files, and gather components
2. **Assembly** — Solder, wire, and assemble the lamp (takes less than 30 minutes)
3. **Software** — Flash firmware from your browser (Chrome/Edge) or via PlatformIO

### PlatformIO (Advanced)

For developers who want to modify the firmware or use a custom MQTT broker:

1. Install [VS Code](https://code.visualstudio.com/) + [PlatformIO](https://platformio.org/)
2. Open `firmware/pcb/` or `firmware/neopixel/` depending on your hardware
3. Copy `data/config.example.json` → `data/config.json` and fill in your details:
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
   Set `device_id` to `"A"` for the first lamp and `"B"` for the second. Use the same broker credentials for both.
4. **Upload Filesystem Image** (PlatformIO sidebar → esp32dev → Platform) to push config
5. **Upload** (→ arrow in the bottom bar) to flash firmware
6. Repeat for the second lamp with `device_id` set to `"B"`

### First Boot

On first power-up, the lamp creates a Wi-Fi network called **"Linked Lamp Setup"**. Connect from your phone, select your home network, and enter the password. The lamp will remember it across restarts.

### Web App

The Setup Guide generates personalized Web App URLs for each lamp. Bookmark and share them — all credentials are saved after the first visit.

## 📱 How to Use

| Action | What Happens |
|---|---|
| **Single Tap** | Sends your default color to the other lamp |
| **Double Tap** | Turns off your lamp (if it's on) |
| **Triple Tap** | Resets WiFi settings (only works when lamp is off) |
| **Hold 1.5s+** | Cycles through colors — lift your finger to pick one |

## 🔄 OTA Updates (For Maintainers)

1. Compile in PlatformIO — binary outputs to `firmware/[type]/.pio/build/esp32dev/firmware.bin`
2. Run `python docs/flash/build_template.py` to copy binaries
3. Commit and push to GitHub — GitHub Pages hosts the update files
4. Lamps check for updates every 7 days, or users can tap "Check for Update" in the web app

The ESP32 automatically rolls back if new firmware crashes before reaching `setup()`.

## 📜 License

GNU General Public License v3.0 — see [LICENSE](https://www.gnu.org/licenses/gpl-3.0.html).

## 🙏 Credits

[WiFiManager](https://github.com/tzapu/WiFiManager) · [PubSubClient](https://github.com/knolleary/pubsubclient) · [ArduinoJson](https://github.com/bblanchon/ArduinoJson) · [iro.js](https://iro.js.org/) · [MQTT.js](https://github.com/mqttjs/MQTT.js) · [esptool-js](https://github.com/espressif/esptool-js)
