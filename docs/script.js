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
let mqtt_user   = "";
let mqtt_pass   = "";
const mqtt_port = 8884; // HiveMQ WebSockets TLS port

let mqttClient      = null;
let myDeviceId       = "A";
let partnerDeviceId  = "B";
let partnerName      = "Partner";

// ==========================================================================
// State
// ==========================================================================
let mySettings = {
    defaultColor: "#FF0000",
    dayTimeMin:   5,
    dayBright:    255,
    nightMode:    false,
    nightStart:   "22:00",
    nightEnd:     "08:00",
    nightTimeMin: 5,
    nightBright:  76,
    timezone:     "EST5EDT"
};

let presets = [
    { id: "default_love", name: "I Love You",  color: "#FF0000" },
    { id: "default_miss", name: "I Miss You",  color: "#00FF00" }
];

let editingPresetId = null;

// Color Picker instances (iro.js)
let mainColorPicker   = null;
let presetColorPicker = null;

// ==========================================================================
// Initialization
// ==========================================================================
window.addEventListener("load", () => {
    if (!loadCredentials()) {
        alert("Connection details missing.\nPlease open this page via your Lamp's NFC tag or setup link.");
        return;
    }

    initColorPickers();
    initSliders();
    initNightToggle();
    initTimezone();
    renderPresets();
    connectMQTT();

    // Set initial page title with partner name
    document.getElementById("pageTitle").innerText = partnerName + "'s Lamp";
});

// Clean MQTT disconnect on page unload
window.addEventListener("beforeunload", () => {
    if (mqttClient) mqttClient.end(true);
});

// ==========================================================================
// Credential Loading (URL params or localStorage)
// ==========================================================================
function loadCredentials() {
    const params = new URLSearchParams(window.location.search);

    if (params.has("s") && params.has("u") && params.has("p") && params.has("id")) {
        mqtt_server = params.get("s");
        mqtt_user   = params.get("u");
        mqtt_pass   = params.get("p");
        myDeviceId  = params.get("id").toUpperCase() === "B" ? "B" : "A";
        partnerDeviceId = myDeviceId === "A" ? "B" : "A";

        // Partner name from URL
        if (params.has("name")) {
            partnerName = decodeURIComponent(params.get("name"));
            localStorage.setItem("ll_name", partnerName);
        }

        localStorage.setItem("ll_s",  mqtt_server);
        localStorage.setItem("ll_u",  mqtt_user);
        localStorage.setItem("ll_p",  mqtt_pass);
        localStorage.setItem("ll_id", myDeviceId);

        // Clean the URL
        history.replaceState(null, null, window.location.pathname);
    } else {
        mqtt_server = localStorage.getItem("ll_s");
        mqtt_user   = localStorage.getItem("ll_u");
        mqtt_pass   = localStorage.getItem("ll_p");
        const id    = localStorage.getItem("ll_id");
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
// MQTT Connection
// ==========================================================================
function connectMQTT() {
    const brokerUrl = `wss://${mqtt_server}:${mqtt_port}/mqtt`;
    const clientId  = "Web-" + myDeviceId + "-" + Math.random().toString(16).substring(2, 8);

    mqttClient = mqtt.connect(brokerUrl, {
        clientId,
        username: mqtt_user,
        password: mqtt_pass,
        reconnectPeriod: 5000,
        clean: true
    });

    mqttClient.on("connect", () => {
        console.log("MQTT Connected!");
        setConnectionUI(true);
        publishSettings(); // Sync settings on every fresh connect
    });

    mqttClient.on("reconnect", () => console.log("MQTT Reconnecting..."));
    mqttClient.on("error", (err) => console.error("MQTT Error:", err));
    mqttClient.on("offline", () => setConnectionUI(false));
}

function setConnectionUI(online) {
    const dot  = document.getElementById("connectionDot");
    const text = document.getElementById("connectionText");
    dot.className  = online ? "dot online" : "dot offline";
    text.innerText = online ? "Online"     : "Offline";
}

// ==========================================================================
// Publishing
// ==========================================================================
function sendSignal(hexColor) {
    if (!mqttClient || !mqttClient.connected) {
        alert("Not connected to your lamp network.");
        return;
    }
    const topic = `linkedlamp/${partnerDeviceId}/color_trigger`;
    mqttClient.publish(topic, hexColor);
    console.log(`Signal sent: ${hexColor} → ${topic}`);
}

function publishSettings() {
    if (!mqttClient || !mqttClient.connected) return;
    const topic = `linkedlamp/${myDeviceId}/settings`;
    const payload = JSON.stringify(mySettings);
    mqttClient.publish(topic, payload, { retain: true });
    localStorage.setItem("ll_settings_" + myDeviceId, payload);
    console.log("Settings published:", payload);
}

function triggerUpdate() {
    if (!confirm("Push a firmware update to your lamp? It will restart briefly.")) return;
    if (mqttClient && mqttClient.connected) {
        // OTA binary hosted on the same GitHub Pages site
        const baseUrl = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '');
        const otaUrl = baseUrl + "/firmware_" + myDeviceId + ".bin";
        mqttClient.publish(`linkedlamp/${myDeviceId}/system/ota`, otaUrl);
        alert("Update command sent! Your lamp will restart shortly.");
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
    document.getElementById("pageTitle").innerText = tabId === "partner" ? partnerName + "'s Lamp" : "My Settings";
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
        document.getElementById("colorPreview").innerText = hex;
        document.getElementById("colorPreview").style.borderLeft = `8px solid ${hex}`;
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

    // Set initial preview
    document.getElementById("colorPreview").innerText = mySettings.defaultColor;
    document.getElementById("colorPreview").style.borderLeft = `8px solid ${mySettings.defaultColor}`;
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
            sub.innerText = "Tap to turn on their lamp";
        }, 1500);
    };
}

function updateMainButton(hex) {
    const btn = document.getElementById("btnMainSignal");
    btn.style.backgroundColor = hex;
    // Dynamic glow based on the color
    btn.style.boxShadow = `0 0 40px ${hex}55, inset 0 0 20px rgba(255,255,255,0.15)`;
}

// ==========================================================================
// Settings Sliders
// ==========================================================================
function initSliders() {
    bindSlider("dayDuration",    "dayTimeMin",  " min", false);
    bindSlider("dayBrightness",  "dayBright",   "%",    true);
    bindSlider("nightDuration",  "nightTimeMin"," min", false);
    bindSlider("nightBrightness","nightBright",  "%",   true);
}

function bindSlider(sliderId, settingKey, suffix, isPercent) {
    const slider = document.getElementById(sliderId);
    const label  = document.getElementById(sliderId + "Val");
    if (!slider || !label) return;

    slider.value = mySettings[settingKey];
    label.innerText = formatSliderVal(mySettings[settingKey], suffix, isPercent);

    slider.oninput = () => {
        label.innerText = formatSliderVal(parseInt(slider.value), suffix, isPercent);
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
// Night Mode Toggle
// ==========================================================================
function initNightToggle() {
    const toggle  = document.getElementById("nightModeToggle");
    const section = document.getElementById("nightSettings");

    toggle.checked = mySettings.nightMode;
    if (mySettings.nightMode) section.classList.remove("hidden");

    toggle.onchange = () => {
        mySettings.nightMode = toggle.checked;
        section.classList.toggle("hidden", !toggle.checked);
        publishSettings();
    };

    // Time picker changes
    document.getElementById("nightStart").value = mySettings.nightStart || "22:00";
    document.getElementById("nightEnd").value   = mySettings.nightEnd   || "08:00";

    document.getElementById("nightStart").onchange = (e) => {
        mySettings.nightStart = e.target.value;
        publishSettings();
    };
    document.getElementById("nightEnd").onchange = (e) => {
        mySettings.nightEnd = e.target.value;
        publishSettings();
    };
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
            "America/New_York":    "EST5EDT",
            "America/Chicago":     "CST6CDT",
            "America/Denver":      "MST7MDT",
            "America/Los_Angeles": "PST8PDT",
            "America/Anchorage":   "AKST9AKDT",
            "Pacific/Honolulu":    "HST",
            "Europe/London":       "GMT0BST",
            "Europe/Berlin":       "CET-1CEST",
            "Europe/Bucharest":    "EET-2EEST",
            "Asia/Kolkata":        "IST-5:30",
            "Asia/Shanghai":       "CST-8",
            "Asia/Tokyo":          "JST-9",
            "Australia/Sydney":    "AEST-10AEDT",
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
        nameSpan.onclick = () => sendSignal(p.color);
        dot.onclick      = () => sendSignal(p.color);
        editIcon.onclick = (e) => { e.stopPropagation(); openPresetModal(p.id); };
        btn.onclick      = () => sendSignal(p.color);

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
    const modal    = document.getElementById("presetModal");
    const title    = document.getElementById("presetModalTitle");
    const nameInp  = document.getElementById("presetName");
    const delBtn   = document.getElementById("btnDeletePreset");

    if (presetId) {
        const p = presets.find(x => x.id === presetId);
        if (!p) return;
        title.innerText = "Edit Signal";
        nameInp.value   = p.name;
        presetColorPicker.color.hexString = p.color;
        delBtn.classList.remove("hidden");
    } else {
        title.innerText = "New Signal";
        nameInp.value   = "";
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
    renderPresets();
    closePresetModal();
}

function deleteCurrentPreset() {
    if (!confirm("Delete this signal preset?")) return;
    presets = presets.filter(x => x.id !== editingPresetId);
    localStorage.setItem("ll_presets_" + myDeviceId, JSON.stringify(presets));
    renderPresets();
    closePresetModal();
}
