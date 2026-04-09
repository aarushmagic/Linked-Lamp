/**
 * Linked Lamp — Web Interface Script
 * 
 * Connects to the MQTT broker via WebSockets and manages:
 *   - Sending color signals to the partner lamp
 *   - Managing preset signals (add/edit/delete)
 *   - Configuring daytime/nighttime settings
 *   - Syncing default color with ESP32
 *   - Timezone selection
 *   - OTA update trigger
 * 
 * License: GNU GPLv3
 */

// ==========================================================================
// Configuration
// ==========================================================================
let mqtt_server = "";
let mqtt_user = "";
let mqtt_pass = "";

let mqttClient = null;
let myDeviceId = "A";
let partnerDeviceId = "B";
let partnerName = "Partner";

let isMqttConnected = false;
let myLampOnline = null;       // null = unknown (no status msg received yet)
let partnerLampOnline = null;  // null = unknown

// ==========================================================================
// MQTT Topic Builder
// ==========================================================================
function getTopic(deviceId, suffix) {
    if (mqtt_server.includes("adafruit") && mqtt_user) {
        const cleanSuffix = suffix.replace(/\//g, "_");
        return `${mqtt_user}/f/ll_${deviceId}_${cleanSuffix}`;
    }
    return `linkedlamp/${deviceId}/${suffix}`;
}

// ==========================================================================
// State
// ==========================================================================
let mySettings = {
    defaultColor: "#FF0000",
    dayTimeMin: 5,
    dayBright: 255,
    ambientMode: false,
    ambientColor: "#0000FF",
    nightMode: false,
    nightStart: "22:00",
    nightEnd: "08:00",
    nightTimeMin: 5,
    nightBright: 76,
    timezone: "EST5EDT",
    lastTapTimestamp: 0
};

let presets = [
    { id: "default_love", name: "I Love You", color: "#FF0000" },
    { id: "default_miss", name: "I Miss You", color: "#00FF00" }
];

let editingPresetId = null;

// Color Picker instances (iro.js)
let mainColorPicker = null;
let presetColorPicker = null;
let ambientColorPicker = null;

// ==========================================================================
// Initialization
// ==========================================================================
window.addEventListener("load", () => {
    if (!loadCredentials()) {
        document.getElementById("missingCredentialsModal").style.display = "flex"; // Use flex to center the content using modal's built in styling

        // Show manual override entry ONLY in PWA modes
        const isPWA = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
        if (isPWA) {
            document.getElementById("pwaManualInputBlock").style.display = "block";
        }
        return;
    }

    initColorPickers();
    initSliders(); // Now only handles brightness
    initDurationPickers();
    initDial();
    initAmbientToggle();
    initNightToggle();
    initTimezone();
    renderPresets();
    connectMQTT();

    // Update page title
    document.getElementById("pageTitle").innerText = "My Group";
    document.getElementById("signalSubtitle").innerText = "Tap to turn on " + partnerName + "'s lamp";
});

// Clean MQTT disconnect on page unload
window.addEventListener("beforeunload", () => {
    if (mqttClient) mqttClient.end(true);
});

// ==========================================================================
// Credential Loading (URL params or localStorage)
// ==========================================================================
function loadCredentials() {
    // Try query params first (?key=val), then fall back to hash params (#key=val)
    let params = new URLSearchParams(window.location.search);
    if (!(params.has("s") && params.has("u") && params.has("p") && params.has("id"))) {
        // Try hash params (e.g. #s=broker&u=user&p=pass&id=A)
        const hash = window.location.hash;
        if (hash && hash.length > 1) {
            params = new URLSearchParams(hash.substring(1));
        }
    }

    if (params.has("s") && params.has("u") && params.has("p") && params.has("id")) {
        mqtt_server = params.get("s");
        mqtt_user = params.get("u");
        mqtt_pass = params.get("p");
        myDeviceId = params.get("id").toUpperCase() === "B" ? "B" : "A";
        partnerDeviceId = myDeviceId === "A" ? "B" : "A";

        // Partner name from URL (accept both "name" and "partner")
        const nameVal = params.get("name") || params.get("partner");
        if (nameVal) {
            partnerName = decodeURIComponent(nameVal);
            localStorage.setItem("ll_name", partnerName);
        }

        localStorage.setItem("ll_s", mqtt_server);
        localStorage.setItem("ll_u", mqtt_user);
        localStorage.setItem("ll_p", mqtt_pass);
        localStorage.setItem("ll_id", myDeviceId);

        // Clean the URL
        history.replaceState(null, null, window.location.pathname);
    } else {
        mqtt_server = localStorage.getItem("ll_s");
        mqtt_user = localStorage.getItem("ll_u");
        mqtt_pass = localStorage.getItem("ll_p");
        const id = localStorage.getItem("ll_id");
        if (id) {
            myDeviceId = id;
            partnerDeviceId = myDeviceId === "A" ? "B" : "A";
        }
        const savedName = localStorage.getItem("ll_name");
        if (savedName) partnerName = savedName;
    }

    // Load saved settings & presets
    const saved = localStorage.getItem("ll_settings_" + myDeviceId);
    if (saved) {
        try { mySettings = JSON.parse(saved); } catch (e) { /* use defaults */ }
    }
    const savedPresets = localStorage.getItem("ll_presets_" + myDeviceId);
    if (savedPresets) {
        try { presets = JSON.parse(savedPresets); } catch (e) { /* use defaults */ }
    }

    return !!(mqtt_server && mqtt_user && mqtt_pass);
}

// ==========================================================================
// iOS Sandbox Escape: Manual Credential Load
// ==========================================================================
function saveManualLink() {
    const linkStr = document.getElementById("manualLinkInput").value.trim();
    const errorEl = document.getElementById("manualLinkError");

    if (!linkStr) {
        errorEl.style.display = "block";
        errorEl.innerText = "Please paste a link first.";
        return;
    }

    try {
        const url = new URL(linkStr);
        // Convert query string into a hash string so it safely redirects cleanly 
        // into the app and passes validation without breaking PWA bounds.
        let params = url.search;
        if (!params || params.length < 5) {
            params = url.hash; // Try to extract from hash if it was a hash link
        }

        if (params && params.includes("s=") && params.includes("id=")) {
            window.location.href = window.location.pathname + params;
        } else {
            errorEl.style.display = "block";
            errorEl.innerText = "This link doesn't contain the correct connection data.";
        }
    } catch (e) {
        errorEl.style.display = "block";
        errorEl.innerText = "Invalid URL format.";
    }
}

// ==========================================================================
// MQTT Connection
// ==========================================================================
function connectMQTT() {
    let clean_server = mqtt_server;
    let active_port = 8884; // Default WSS port (HiveMQ)

    if (mqtt_server.includes("adafruit")) {
        active_port = 443; // Adafruit IO WSS port
    }

    if (mqtt_server.includes(":")) {
        const parts = mqtt_server.split(":");
        clean_server = parts[0];
        active_port = parseInt(parts[1]) || active_port;
    }

    const brokerUrl = `wss://${clean_server}:${active_port}/mqtt`;
    const clientId = "Web-" + myDeviceId + "-" + Math.random().toString(16).substring(2, 8);

    mqttClient = mqtt.connect(brokerUrl, {
        clientId,
        username: mqtt_user,
        password: mqtt_pass,
        reconnectPeriod: 5000,
        clean: true
    });

    mqttClient.on("connect", () => {
        console.log("MQTT Connected!");
        isMqttConnected = true;

        mqttClient.subscribe(getTopic(myDeviceId, "status"));
        mqttClient.subscribe(getTopic(partnerDeviceId, "status"));
        mqttClient.subscribe(getTopic(myDeviceId, "settings")); // Pull retained settings
        mqttClient.subscribe(getTopic(myDeviceId, "presets"));  // Pull retained presets

        updateStatusUI();
    });

    // We use a flag to prevent echoing our own settings publishes
    // back into the UI and causing infinite loops
    let isSelfPublishingUi = false;

    // Make publishSettings aware of the flag so we can export it later
    window._setSelfPublishing = (val) => isSelfPublishingUi = val;

    mqttClient.on("message", (topic, message) => {
        const msg = message.toString();

        if (topic === getTopic(myDeviceId, "status")) {
            if (msg.startsWith("ONLINE")) {
                myLampOnline = true;
                const parts = msg.split(":");
                if (parts.length > 1) {
                    localStorage.setItem("ll_hwtype_" + myDeviceId, parts[1]);
                }
            } else {
                myLampOnline = false;
            }
            updateStatusUI();

        } else if (topic === getTopic(partnerDeviceId, "status")) {
            if (msg.startsWith("ONLINE")) {
                partnerLampOnline = true;
            } else {
                partnerLampOnline = false;
            }
            updateStatusUI();

        } else if (topic === getTopic(myDeviceId, "settings")) {
            if (isSelfPublishingUi) return; // Ignore our own publishes

            try {
                const incomingSettings = JSON.parse(msg);
                let changed = false;

                // Merge incoming settings (e.g. from another phone, or from long-pressing the lamp)
                for (let key in incomingSettings) {
                    if (mySettings[key] !== incomingSettings[key]) {
                        mySettings[key] = incomingSettings[key];
                        changed = true;
                    }
                }

                if (changed) {
                    console.log("Applied remote settings from MQTT:", mySettings);
                    // Save to local storage
                    localStorage.setItem("ll_settings_" + myDeviceId, JSON.stringify(mySettings));
                    // Update UI elements visually
                    applySettingsToUI();
                }
            } catch (e) {
                console.error("Failed to parse incoming settings payload:", e);
            }
        } else if (topic === getTopic(myDeviceId, "presets")) {
            if (isSelfPublishingUi) return;

            try {
                const incomingPresets = JSON.parse(msg);
                if (Array.isArray(incomingPresets)) {
                    presets = incomingPresets;
                    localStorage.setItem("ll_presets_" + myDeviceId, JSON.stringify(presets));
                    renderPresets();
                    console.log("Applied remote presets from MQTT.");
                }
            } catch (e) {
                console.error("Failed to parse incoming presets payload:", e);
            }
        }
    });

    mqttClient.on("reconnect", () => console.log("MQTT Reconnecting..."));
    mqttClient.on("error", (err) => console.error("MQTT Error:", err));
    mqttClient.on("offline", () => {
        isMqttConnected = false;
        myLampOnline = null;
        partnerLampOnline = null;
        updateStatusUI();
    });
}

function updateStatusUI() {
    const dot = document.getElementById("connectionDot");
    const text = document.getElementById("connectionText");

    if (!isMqttConnected) {
        dot.className = "dot connecting";
        text.innerText = "Connecting...";
        return;
    }

    // If we haven't received any status messages from firmware yet,
    // just show "Online" based on broker connectivity
    if (myLampOnline === null && partnerLampOnline === null) {
        dot.className = "dot connecting";
        text.innerText = "Connecting";
        return;
    }

    // If we have status info from firmware LWT, show detailed status.
    // Default an unknown (null) lamp to offline to prevent false "Both Online" claims.
    const myStatus = myLampOnline === null ? false : myLampOnline;
    const partnerStatus = partnerLampOnline === null ? false : partnerLampOnline;

    if (myStatus && partnerStatus) {
        dot.className = "dot online";
        text.innerText = "Both Online";
    } else if (myStatus && !partnerStatus) {
        dot.className = "dot partial";
        text.innerText = partnerName + " Offline";
    } else if (!myStatus && partnerStatus) {
        dot.className = "dot partial";
        text.innerText = "Your Lamp Offline";
    } else {
        dot.className = "dot offline";
        text.innerText = "Lamps Offline";
    }
}

// ==========================================================================
// Publishing
// ==========================================================================
function sendSignal(hexColor) {
    if (!mqttClient || !mqttClient.connected) {
        alert("Not connected to your lamp network.");
        return;
    }
    const topic = getTopic(partnerDeviceId, "color_trigger");
    mqttClient.publish(topic, hexColor);
    console.log(`Signal sent: ${hexColor} → ${topic}`);
}

function publishSettings() {
    const payload = JSON.stringify(mySettings);
    localStorage.setItem("ll_settings_" + myDeviceId, payload);

    if (!mqttClient || !mqttClient.connected) return;

    const topic = getTopic(myDeviceId, "settings");

    if (window._setSelfPublishing) window._setSelfPublishing(true);

    mqttClient.publish(topic, payload, { retain: true });
    console.log("Settings published:", payload);

    // Clear the flag shortly after publishing so we can receive external updates again
    setTimeout(() => {
        if (window._setSelfPublishing) window._setSelfPublishing(false);
    }, 1000);
}

function publishPresets() {
    const payload = JSON.stringify(presets);
    localStorage.setItem("ll_presets_" + myDeviceId, payload);

    if (!mqttClient || !mqttClient.connected) return;

    const topic = getTopic(myDeviceId, "presets");

    if (window._setSelfPublishing) window._setSelfPublishing(true);

    mqttClient.publish(topic, payload, { retain: true });
    console.log("Presets published to MQTT.");

    setTimeout(() => {
        if (window._setSelfPublishing) window._setSelfPublishing(false);
    }, 1000);
}


function applySettingsToUI() {
    // Sliders (Brightness only)
    const map = [
        ["dayBrightness", "dayBright", "%", true],
        ["nightBrightness", "nightBright", "%", true]
    ];
    map.forEach(m => {
        const slider = document.getElementById(m[0]);
        const label = document.getElementById(m[0] + "Val");
        if (slider && label) {
            slider.value = mySettings[m[1]];
            label.innerText = formatSliderVal(mySettings[m[1]], m[2], m[3]);
        }
    });

    // Durations
    const dd = document.getElementById("dayDurationDisplay");
    if (dd) dd.innerText = mySettings.dayTimeMin + " min";
    const nd = document.getElementById("nightDurationDisplay");
    if (nd) nd.innerText = mySettings.nightTimeMin + " min";

    // Color Pickers
    if (mainColorPicker) mainColorPicker.color.hexString = mySettings.defaultColor;
    document.getElementById("colorPreview").style.borderLeft = `8px solid ${mySettings.defaultColor}`;
    document.getElementById("colorPreview").style.backgroundColor = mySettings.defaultColor;
    updateMainButton(mySettings.defaultColor);

    // Night Toggle
    const nightToggle = document.getElementById("nightModeToggle");
    const nightSection = document.getElementById("nightSettings");
    if (nightToggle && nightSection) {
        nightToggle.checked = mySettings.nightMode;
        nightSection.classList.toggle("hidden", !mySettings.nightMode);
    }
    
    // Ambient Toggle & color circle
    const ambToggle = document.getElementById("ambientModeToggle");
    const ambCircle = document.getElementById("btnAmbientColorDisplay");
    if (ambToggle) {
        ambToggle.checked = mySettings.ambientMode;
    }
    if (ambCircle) {
        ambCircle.style.display = mySettings.ambientMode ? "block" : "none";
        ambCircle.style.backgroundColor = mySettings.ambientColor;
    }

    // Last Tap display
    const lastTapEl = document.getElementById("lastTapDisplay");
    if (lastTapEl) {
        if (mySettings.lastTapTimestamp > 0) {
            const tapDate = new Date(mySettings.lastTapTimestamp * 1000);
            lastTapEl.innerText = "Last tap: " + tapDate.toLocaleString();
        } else {
            lastTapEl.innerText = "Last tap: Unknown";
        }
    }

    updateTimeDisplay("nightStartDisplay", mySettings.nightStart || "22:00");
    updateTimeDisplay("nightEndDisplay", mySettings.nightEnd || "08:00");

    // Timezone
    const sel = document.getElementById("timezoneSelect");
    if (sel) sel.value = mySettings.timezone;
}

function triggerUpdate() {
    if (!confirm("Push a firmware update to your lamp? It will restart briefly.")) return;
    if (mqttClient && mqttClient.connected) {
        // Construct correct firmware URL based on detected hardware type
        const hwType = localStorage.getItem("ll_hwtype_" + myDeviceId) || "pcb";
        const fwFile = (hwType === "neopixel") ? "firmware-neo.bin" : "firmware.bin";
        const otaUrl = new URL("../flash/" + fwFile, window.location.href).href;

        mqttClient.publish(getTopic(myDeviceId, "system/ota"), otaUrl);
        alert("Update command sent! Your lamp will restart shortly. This could take upto 5 minutes. Please do not restart your device in the meantime even if it goes offline.");
    } else {
        alert("Not connected to your lamp network.");
    }
}

// ==========================================================================
// Tab Navigation
// ==========================================================================
function switchTab(tabId) {
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    document.getElementById("view-" + tabId).classList.add("active");

    document.getElementById("navSend").classList.toggle("active", tabId === "partner");
    document.getElementById("navSettings").classList.toggle("active", tabId === "settings");
    // Update page title based on view
    document.getElementById("pageTitle").innerText = tabId === "partner" ? "My Group" : "My Settings";
}

// ==========================================================================
// Color Pickers
// ==========================================================================
function initColorPickers() {
    // Main default-color picker (settings tab)
    mainColorPicker = new iro.ColorPicker("#colorPickerContainer", {
        width: 200,
        color: mySettings.defaultColor,
        borderWidth: 1,
        borderColor: "#fff",
        layout: [
            { component: iro.ui.Wheel, options: {} },
            { component: iro.ui.Slider, options: { sliderType: "value" } }
        ]
    });

    mainColorPicker.on("color:change", (color) => {
        const hex = color.hexString;
        console.log("Color selected:", hex);
        document.getElementById("colorPreview").style.borderLeft = `8px solid ${hex}`;
        document.getElementById("colorPreview").style.backgroundColor = hex;
        updateMainButton(hex);
        mySettings.defaultColor = hex;
    });

    // Debounce MQTT publish while user drags
    let publishTimer;
    mainColorPicker.on("input:end", () => {
        clearTimeout(publishTimer);
        publishTimer = setTimeout(publishSettings, 400);
    });

    // Preset color picker (modal)
    presetColorPicker = new iro.ColorPicker("#presetColorPickerContainer", {
        width: 220,
        color: "#ffffff",
        borderWidth: 1,
        borderColor: "#ccc",
        layout: [{ component: iro.ui.Wheel, options: {} }]
    });

    // Ambient color picker is lazily initialized inside openAmbientColorModal()

    // Set initial preview
    document.getElementById("colorPreview").style.borderLeft = `8px solid ${mySettings.defaultColor}`;
    document.getElementById("colorPreview").style.backgroundColor = mySettings.defaultColor;
    updateMainButton(mySettings.defaultColor);

    // Bind main send button
    document.getElementById("btnMainSignal").onclick = () => {
        sendSignal(mySettings.defaultColor);
        const btn = document.getElementById("btnMainSignal");
        const sub = document.getElementById("signalSubtitle");
        btn.style.transform = "scale(0.88)";
        sub.innerText = "Signal sent! ✨";
        setTimeout(() => {
            btn.style.transform = "";
            sub.innerText = "Tap to turn on " + partnerName + "'s lamp";
        }, 1500);
    };
}

function getLuminance(hexCode) {
    let hex = hexCode.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function updateMainButton(hex) {
    const btn = document.getElementById("btnMainSignal");
    btn.style.backgroundColor = hex;
    // Dynamic glow based on the color
    btn.style.boxShadow = `0 0 40px ${hex}55, inset 0 0 20px rgba(255,255,255,0.15)`;

    // Adjust text readability based on background brightness
    if (getLuminance(hex) > 0.6) {
        btn.classList.add("dark-text");
        btn.classList.remove("light-text");
    } else {
        btn.classList.add("light-text");
        btn.classList.remove("dark-text");
    }
}

// ==========================================================================
// Settings Sliders & Durations
// ==========================================================================
function initSliders() {
    bindSlider("dayBrightness", "dayBright", "%", true);
    bindSlider("nightBrightness", "nightBright", "%", true);
}

function initDurationPickers() {
    // Init display values
    document.getElementById("dayDurationDisplay").innerText = mySettings.dayTimeMin + " min";
    document.getElementById("nightDurationDisplay").innerText = mySettings.nightTimeMin + " min";

    document.getElementById("btnDayDuration").onclick = () => openTimePicker("dayDuration");
    document.getElementById("btnNightDuration").onclick = () => openTimePicker("nightDuration");
}

function bindSlider(sliderId, settingKey, suffix, isPercent) {
    const slider = document.getElementById(sliderId);
    const label = document.getElementById(sliderId + "Val");
    if (!slider || !label) return;

    slider.value = mySettings[settingKey];
    label.innerText = formatSliderVal(mySettings[settingKey], suffix, isPercent);

    const updateSliderBg = () => {
        const min = Number(slider.min) || 0;
        const max = Number(slider.max) || 100;
        const val = Number(slider.value);
        const percent = ((val - min) / (max - min)) * 100;
        slider.style.background = `linear-gradient(to right, var(--accent) ${percent}%, rgba(255, 255, 255, 0.1) ${percent}%)`;
    };

    updateSliderBg();

    slider.oninput = () => {
        label.innerText = formatSliderVal(parseInt(slider.value), suffix, isPercent);
        updateSliderBg();
    };
    slider.onchange = () => {
        mySettings[settingKey] = parseInt(slider.value);
        publishSettings();
    };
}

function formatSliderVal(val, suffix, isPercent) {
    return isPercent ? Math.round((val / 255) * 100) + suffix : val + suffix;
}

// ==========================================================================
// Ambient Mode Toggle & Color Modal
// ==========================================================================
let ambientColorBeforeEdit = null; // Store color before opening modal for cancel

function initAmbientToggle() {
    const toggle = document.getElementById("ambientModeToggle");
    const circle = document.getElementById("btnAmbientColorDisplay");

    toggle.checked = mySettings.ambientMode;
    circle.style.display = mySettings.ambientMode ? "block" : "none";
    circle.style.backgroundColor = mySettings.ambientColor;

    toggle.onchange = () => {
        mySettings.ambientMode = toggle.checked;
        circle.style.display = toggle.checked ? "block" : "none";
        publishSettings();
    };
}

function openAmbientColorModal() {
    ambientColorBeforeEdit = mySettings.ambientColor;
    document.getElementById("ambientColorModal").style.display = "block";

    // Lazy-init (iro.js needs the container to be visible to render correctly)
    if (!ambientColorPicker) {
        ambientColorPicker = new iro.ColorPicker("#ambientColorPickerContainer", {
            width: 220,
            color: mySettings.ambientColor,
            borderWidth: 1,
            borderColor: "#fff",
            layout: [
                { component: iro.ui.Wheel, options: {} },
                { component: iro.ui.Slider, options: { sliderType: "value" } }
            ]
        });
    } else {
        ambientColorPicker.color.hexString = mySettings.ambientColor;
    }
}

function closeAmbientColorModal() {
    // Cancel — revert to pre-edit color
    if (ambientColorBeforeEdit !== null) {
        mySettings.ambientColor = ambientColorBeforeEdit;
    }
    document.getElementById("ambientColorModal").style.display = "none";
}

function saveAmbientColor() {
    mySettings.ambientColor = ambientColorPicker.color.hexString;
    ambientColorBeforeEdit = null; // Clear so close doesn't revert
    
    // Update the color circle
    const circle = document.getElementById("btnAmbientColorDisplay");
    if (circle) circle.style.backgroundColor = mySettings.ambientColor;
    
    publishSettings();
    document.getElementById("ambientColorModal").style.display = "none";
}

// ==========================================================================
// Night Mode Toggle
// ==========================================================================
function initNightToggle() {
    const toggle = document.getElementById("nightModeToggle");
    const section = document.getElementById("nightSettings");

    toggle.checked = mySettings.nightMode;
    if (mySettings.nightMode) section.classList.remove("hidden");

    toggle.onchange = () => {
        mySettings.nightMode = toggle.checked;
        section.classList.toggle("hidden", !toggle.checked);
        publishSettings();
    };

    // Time picker updates
    updateTimeDisplay("nightStartDisplay", mySettings.nightStart || "22:00");
    updateTimeDisplay("nightEndDisplay", mySettings.nightEnd || "08:00");

    document.getElementById("btnStartTime").onclick = () => openTimePicker("start");
    document.getElementById("btnEndTime").onclick = () => openTimePicker("end");
}

function updateTimeDisplay(elementId, time24) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const parts = time24.split(":");
    let h = parseInt(parts[0]);
    const m = parts[1];
    const ampm = h >= 12 ? "PM" : "AM";
    if (h === 0) h = 12;
    if (h > 12) h -= 12;
    el.innerText = `${h}:${m} ${ampm}`;
}

// ==========================================================================
// Time & Duration Picker Modal Logic
// ==========================================================================
let editingTimeTarget = null; // 'start', 'end', 'dayDuration', 'nightDuration'
let currentPickerMode = 'hour'; // 'hour', 'minute', or 'duration'
let tpTempHour24 = 0;
let tpTempMinute = 0;
let tpTempDuration = 5;

function openTimePicker(target) {
    editingTimeTarget = target;

    const isDuration = (target === 'dayDuration' || target === 'nightDuration');
    currentPickerMode = isDuration ? 'duration' : 'hour';

    document.getElementById("timeDisplayGroup").style.display = isDuration ? "none" : "flex";
    document.getElementById("durationDisplayGroup").style.display = isDuration ? "flex" : "none";

    document.getElementById("clockContainer").style.display = isDuration ? "none" : "flex";
    document.getElementById("dialContainer").style.display = isDuration ? "block" : "none";

    if (isDuration) {
        tpTempDuration = target === 'dayDuration' ? mySettings.dayTimeMin : mySettings.nightTimeMin;
        document.getElementById("timePickerTitle").innerText = "Duration (Minutes)";
        updateTpHeader();
        renderDial();
    } else {
        // Parse current setting
        const currentVal = target === 'start' ? (mySettings.nightStart || "22:00") : (mySettings.nightEnd || "08:00");
        const parts = currentVal.split(":");
        tpTempHour24 = parseInt(parts[0]);
        tpTempMinute = parseInt(parts[1]);
        document.getElementById("timePickerTitle").innerText = target === 'start' ? "Starts At" : "Ends At";
        updateTpHeader();
        renderClockFace();
    }

    document.getElementById("timePickerModal").style.display = "block";

    // Bind AM/PM toggles
    document.getElementById("tpAM").onclick = () => { if (tpTempHour24 >= 12) { tpTempHour24 -= 12; updateTpHeader(); } };
    document.getElementById("tpPM").onclick = () => { if (tpTempHour24 < 12) { tpTempHour24 += 12; updateTpHeader(); } };

    // Bind Hour/Min toggles
    document.getElementById("tpHour").onclick = () => { currentPickerMode = 'hour'; renderClockFace(); };
    document.getElementById("tpMinute").onclick = () => { currentPickerMode = 'minute'; renderClockFace(); };

    updateTpHeader();
    renderClockFace();
}

function closeTimePickerModal() {
    document.getElementById("timePickerModal").style.display = "none";
}

function saveTimePickerModal() {
    if (editingTimeTarget === 'dayDuration' || editingTimeTarget === 'nightDuration') {
        if (editingTimeTarget === 'dayDuration') {
            mySettings.dayTimeMin = tpTempDuration;
            document.getElementById("dayDurationDisplay").innerText = tpTempDuration + " min";
        } else {
            mySettings.nightTimeMin = tpTempDuration;
            document.getElementById("nightDurationDisplay").innerText = tpTempDuration + " min";
        }
    } else {
        const hStr = tpTempHour24.toString().padStart(2, '0');
        const mStr = tpTempMinute.toString().padStart(2, '0');
        const time24 = `${hStr}:${mStr}`;

        if (editingTimeTarget === 'start') {
            mySettings.nightStart = time24;
            updateTimeDisplay("nightStartDisplay", time24);
        } else {
            mySettings.nightEnd = time24;
            updateTimeDisplay("nightEndDisplay", time24);
        }
    }
    publishSettings();
    closeTimePickerModal();
}

function updateTpHeader() {
    if (currentPickerMode === 'duration') {
        document.getElementById("tpDurationVal").innerText = tpTempDuration;
        return;
    }

    let h = tpTempHour24 % 12;
    if (h === 0) h = 12;

    document.getElementById("tpHour").innerText = h;
    document.getElementById("tpMinute").innerText = tpTempMinute.toString().padStart(2, '0');

    document.getElementById("tpAM").className = tpTempHour24 < 12 ? "am-pm-btn active" : "am-pm-btn";
    document.getElementById("tpPM").className = tpTempHour24 >= 12 ? "am-pm-btn active" : "am-pm-btn";

    document.getElementById("tpHour").className = currentPickerMode === 'hour' ? "tp-part active" : "tp-part";
    document.getElementById("tpMinute").className = currentPickerMode === 'minute' ? "tp-part active" : "tp-part";
}

function renderClockFace() {
    updateTpHeader();
    const face = document.getElementById("clockFace");
    const hand = document.getElementById("clockHand");

    // Clear existing numbers
    const numbers = face.querySelectorAll('.clock-number');
    numbers.forEach(n => n.remove());

    const radius = 95; // px from center
    const center = 120; // 240px width / 2

    let activeVal;
    if (currentPickerMode === 'duration') activeVal = tpTempDuration;
    else if (currentPickerMode === 'hour') activeVal = (tpTempHour24 % 12 || 12);
    else activeVal = tpTempMinute;

    // We draw numbers arranged in a circle
    let numCount = 12;
    if (currentPickerMode === 'duration') {
        // Durations 1-30 are mapped around the clock
        numCount = 30;
    }

    for (let i = 1; i <= numCount; i++) {
        let numVal;
        if (currentPickerMode === 'duration') {
            numVal = i;
        } else if (currentPickerMode === 'hour') {
            numVal = i;
        } else {
            numVal = (i === 12 ? 0 : i * 5); // minutes jump 5
            if (i > 12) continue; // For minutes we only draw 12 main markers to prevent clutter
        }

        const deg = i * (360 / numCount);
        const rad = (deg - 90) * (Math.PI / 180);
        const x = center + radius * Math.cos(rad);
        const y = center + radius * Math.sin(rad);

        const el = document.createElement('div');
        el.className = 'clock-number';

        // Make duration numbers smaller to fit 30 of them
        if (currentPickerMode === 'duration') {
            el.style.width = '24px';
            el.style.height = '24px';
            el.style.fontSize = '12px';
            el.style.lineHeight = '24px';
        }

        if (numVal === activeVal) el.classList.add('active');

        el.innerText = (currentPickerMode === 'minute') ? numVal.toString().padStart(2, '0') : numVal;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;

        el.onclick = () => {
            if (currentPickerMode === 'duration') {
                tpTempDuration = numVal;
                renderClockFace();
            } else if (currentPickerMode === 'hour') {
                let isPM = tpTempHour24 >= 12;
                tpTempHour24 = (numVal === 12 ? 0 : numVal) + (isPM ? 12 : 0);
                // Auto switch to minutes
                currentPickerMode = 'minute';
                renderClockFace();
            } else {
                tpTempMinute = numVal;
                renderClockFace();
            }
        };

        face.appendChild(el);
    }

    // Position the hand correctly
    let handDeg;
    if (currentPickerMode === 'duration') {
        handDeg = activeVal * (360 / 30);
    } else {
        handDeg = activeVal * (currentPickerMode === 'hour' ? 30 : 6);
    }
    hand.style.transform = `translateX(-50%) rotate(${handDeg}deg)`;
}

// ==========================================================================
// Rotary Dial Logic (Duration Picker)
// ==========================================================================
let isDialDragging = false;

function initDial() {
    const dialSvg = document.getElementById("durationDial");
    if (!dialSvg) return;

    dialSvg.addEventListener("mousedown", startDialDrag);
    dialSvg.addEventListener("touchstart", startDialDrag, { passive: false });

    document.addEventListener("mousemove", doDialDrag);
    document.addEventListener("touchmove", doDialDrag, { passive: false });

    document.addEventListener("mouseup", stopDialDrag);
    document.addEventListener("touchend", stopDialDrag);
}

function startDialDrag(e) {
    if (currentPickerMode !== 'duration') return;
    isDialDragging = true;
    updateDialFromEvent(e);
}

function doDialDrag(e) {
    if (!isDialDragging) return;
    e.preventDefault(); // prevent scrolling
    updateDialFromEvent(e);
}

function stopDialDrag() {
    isDialDragging = false;
}

function updateDialFromEvent(e) {
    const dialSvg = document.getElementById("durationDial");
    const rect = dialSvg.getBoundingClientRect();

    // Get mouse/touch relative to SVG center (which is 100, 100 in viewbox but we need screen px)
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    let dx = clientX - centerX;
    let dy = clientY - centerY;

    // Calculate angle in radians
    let angleRad = Math.atan2(dy, dx);

    // Convert to degrees (0 to 360, where 0 is 3 o'clock natively)
    let angleDeg = angleRad * (180 / Math.PI);

    // Because we rotated the SVG by -90deg in CSS, visually top is 0deg.
    // The visual top corresponds to dx=0, dy=-radius relative to screen.
    // Let's map it so Top = 0deg, Right = 90deg, Bottom = 180deg, Left = 270deg.
    angleDeg += 90;
    if (angleDeg < 0) angleDeg += 360;

    // Map 0-360 degrees to 1-30 minutes
    // Let's cap at 360 -> 30, and 0 -> 1.
    // 360 degrees / 30 minutes = 12 degrees per minute.
    let minutes = Math.round(angleDeg / 12);
    if (minutes < 1) minutes = 1;
    if (minutes > 30) minutes = 30;

    tpTempDuration = minutes;
    document.getElementById("tpDurationVal").innerText = tpTempDuration;
    renderDial();
}

function renderDial() {
    const minVal = 1;
    const maxVal = 30;
    const radius = 80;
    const center = 100;

    // Calculate progress fraction (0.0 to 1.0)
    let fraction = tpTempDuration / maxVal;

    // Circumference of the circle
    const circumference = 2 * Math.PI * radius;
    // Stroke dasharray creates the filled arc and empty remainder
    const dashVal = fraction * circumference;

    const progressArc = document.getElementById("dialProgress");
    if (progressArc) {
        // We use a clean circle path instead of arc logic for stroke-dasharray
        progressArc.setAttribute("d", `M 100, 20 A 80,80 0 1,1 99.9,20`);
        progressArc.style.strokeDasharray = `${dashVal} ${circumference}`;
        progressArc.style.stroke = "var(--accent)"; // fallback
        // Add purple glow dynamically based on our primary var
        progressArc.style.stroke = "#6b4cff";
    }

    // Position the knob
    // Angle: 0 fraction = 0deg (top), 1.0 fraction = 360deg
    const angleDeg = fraction * 360;
    const angleRad = (angleDeg - 90) * (Math.PI / 180); // -90 because 0deg is naturally 3 o'clock in trig

    const knobX = center + radius * Math.cos(angleRad);
    const knobY = center + radius * Math.sin(angleRad);

    const knob = document.getElementById("dialKnob");
    if (knob) {
        knob.setAttribute("cx", knobX);
        knob.setAttribute("cy", knobY);
    }
}

// ==========================================================================
// Timezone Selector
// ==========================================================================
function initTimezone() {
    const sel = document.getElementById("timezoneSelect");
    if (!sel) return;

    // Try to auto-detect timezone on first visit
    if (!mySettings.timezone) {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        // Map common IANA to POSIX (best-effort)
        const ianaMap = {
            "America/New_York": "EST5EDT",
            "America/Chicago": "CST6CDT",
            "America/Denver": "MST7MDT",
            "America/Los_Angeles": "PST8PDT",
            "America/Anchorage": "AKST9AKDT",
            "Pacific/Honolulu": "HST",
            "Europe/London": "GMT0BST",
            "Europe/Berlin": "CET-1CEST",
            "Europe/Bucharest": "EET-2EEST",
            "Asia/Kolkata": "IST-5:30",
            "Asia/Shanghai": "CST-8",
            "Asia/Tokyo": "JST-9",
            "Australia/Sydney": "AEST-10AEDT",
        };
        mySettings.timezone = ianaMap[tz] || "EST5EDT";
    }

    sel.value = mySettings.timezone;

    sel.onchange = () => {
        mySettings.timezone = sel.value;
        publishSettings();
    };
}

// ==========================================================================
// Preset Management
// ==========================================================================
function renderPresets() {
    const grid = document.getElementById("presetsGrid");
    grid.innerHTML = "";

    presets.forEach(p => {
        const btn = document.createElement("button");
        btn.className = "preset-btn";
        btn.style.setProperty("--preset-color", p.color);

        const nameSpan = document.createElement("span");
        nameSpan.style.flex = "1";
        nameSpan.style.textAlign = "left";
        nameSpan.innerText = p.name;

        const dot = document.createElement("div");
        dot.className = "preset-color-dot";
        dot.style.background = p.color;

        const editIcon = document.createElement("span");
        editIcon.className = "material-icons-round preset-edit-icon";
        editIcon.innerText = "edit";

        btn.appendChild(nameSpan);
        btn.appendChild(dot);
        btn.appendChild(editIcon);

        // Tap the button area = send signal, tap edit icon = edit
        editIcon.onclick = (e) => { e.stopPropagation(); openPresetModal(p.id); };
        btn.onclick = () => sendSignal(p.color);

        grid.appendChild(btn);
    });

    // "Add new" button
    const addBtn = document.createElement("button");
    addBtn.className = "preset-btn add-new";
    addBtn.onclick = () => openPresetModal();
    addBtn.innerHTML = `<span class="material-icons-round">add</span>`;
    grid.appendChild(addBtn);
}

function openPresetModal(presetId = null) {
    editingPresetId = presetId;
    const modal = document.getElementById("presetModal");
    const title = document.getElementById("presetModalTitle");
    const nameInp = document.getElementById("presetName");
    const delBtn = document.getElementById("btnDeletePreset");

    if (presetId) {
        const p = presets.find(x => x.id === presetId);
        if (!p) return;
        title.innerText = "Edit Signal";
        nameInp.value = p.name;
        presetColorPicker.color.hexString = p.color;
        delBtn.classList.remove("hidden");
    } else {
        title.innerText = "New Signal";
        nameInp.value = "";
        presetColorPicker.color.hexString = "#ffffff";
        delBtn.classList.add("hidden");
    }
    modal.style.display = "block";
}

function closePresetModal() {
    document.getElementById("presetModal").style.display = "none";
}

function savePreset() {
    const name = document.getElementById("presetName").value.trim();
    if (!name) { alert("Please enter a name."); return; }
    const color = presetColorPicker.color.hexString;

    if (editingPresetId) {
        const p = presets.find(x => x.id === editingPresetId);
        if (p) { p.name = name; p.color = color; }
    } else {
        presets.push({ id: "p_" + Date.now(), name, color });
    }

    localStorage.setItem("ll_presets_" + myDeviceId, JSON.stringify(presets));
    publishPresets();
    renderPresets();
    closePresetModal();
}

function deleteCurrentPreset() {
    if (!confirm("Delete this signal preset?")) return;
    presets = presets.filter(x => x.id !== editingPresetId);
    localStorage.setItem("ll_presets_" + myDeviceId, JSON.stringify(presets));
    publishPresets();
    renderPresets();
    closePresetModal();
}
