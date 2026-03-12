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
const mqtt_port = 8884; // HiveMQ WebSockets TLS port

let mqttClient = null;
let myDeviceId = "A";
let partnerDeviceId = "B";
let partnerName = "Partner";

let isMqttConnected = false;
let myLampOnline = null;       // null = unknown (no status msg received yet)
let partnerLampOnline = null;  // null = unknown

// ==========================================================================
// State
// ==========================================================================
let mySettings = {
    defaultColor: "#FF0000",
    dayTimeMin: 5,
    dayBright: 255,
    nightMode: false,
    nightStart: "22:00",
    nightEnd: "08:00",
    nightTimeMin: 5,
    nightBright: 76,
    timezone: "EST5EDT"
};

let presets = [
    { id: "default_love", name: "I Love You", color: "#FF0000" },
    { id: "default_miss", name: "I Miss You", color: "#00FF00" }
];

let editingPresetId = null;

// Color Picker instances (iro.js)
let mainColorPicker = null;
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
        mqtt_user = params.get("u");
        mqtt_pass = params.get("p");
        myDeviceId = params.get("id").toUpperCase() === "B" ? "B" : "A";
        partnerDeviceId = myDeviceId === "A" ? "B" : "A";

        // Partner name from URL
        if (params.has("name")) {
            partnerName = decodeURIComponent(params.get("name"));
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
// MQTT Connection
// ==========================================================================
function connectMQTT() {
    const brokerUrl = `wss://${mqtt_server}:${mqtt_port}/mqtt`;
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

        mqttClient.subscribe(`linkedlamp/${myDeviceId}/status`);
        mqttClient.subscribe(`linkedlamp/${partnerDeviceId}/status`);
        mqttClient.subscribe(`linkedlamp/${myDeviceId}/settings`); // Pull retained settings

        updateStatusUI();
    });

    // We use a flag to prevent echoing our own settings publishes
    // back into the UI and causing infinite loops
    let isSelfPublishingUi = false;
    
    // Make publishSettings aware of the flag so we can export it later
    window._setSelfPublishing = (val) => isSelfPublishingUi = val;

    mqttClient.on("message", (topic, message) => {
        const msg = message.toString();
        
        if (topic === `linkedlamp/${myDeviceId}/status`) {
            myLampOnline = (msg === "ONLINE");
            updateStatusUI();
            
        } else if (topic === `linkedlamp/${partnerDeviceId}/status`) {
            partnerLampOnline = (msg === "ONLINE");
            updateStatusUI();
            
        } else if (topic === `linkedlamp/${myDeviceId}/settings`) {
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
        dot.className = "dot offline";
        text.innerText = "Offline";
        return;
    }

    // If we haven't received any status messages from firmware yet,
    // just show "Online" based on broker connectivity
    if (myLampOnline === null && partnerLampOnline === null) {
        dot.className = "dot offline";
        text.innerText = "Offline";
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
    const topic = `linkedlamp/${partnerDeviceId}/color_trigger`;
    mqttClient.publish(topic, hexColor);
    console.log(`Signal sent: ${hexColor} → ${topic}`);
}

function publishSettings() {
    const payload = JSON.stringify(mySettings);
    localStorage.setItem("ll_settings_" + myDeviceId, payload);
    
    if (!mqttClient || !mqttClient.connected) return;
    
    const topic = `linkedlamp/${myDeviceId}/settings`;
    
    if (window._setSelfPublishing) window._setSelfPublishing(true);
    
    mqttClient.publish(topic, payload, { retain: true });
    console.log("Settings published:", payload);
    
    // Clear the flag shortly after publishing so we can receive external updates again
    setTimeout(() => {
        if (window._setSelfPublishing) window._setSelfPublishing(false);
    }, 1000);
}

function applySettingsToUI() {
    // Sliders
    const map = [
        ["dayDuration", "dayTimeMin", " min", false],
        ["dayBrightness", "dayBright", "%", true],
        ["nightDuration", "nightTimeMin", " min", false],
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

    // Color Pickers
    if (mainColorPicker) mainColorPicker.color.hexString = mySettings.defaultColor;
    document.getElementById("colorPreview").innerText = mySettings.defaultColor;
    document.getElementById("colorPreview").style.borderLeft = `8px solid ${mySettings.defaultColor}`;
    updateMainButton(mySettings.defaultColor);

    // Night Toggle
    const toggle = document.getElementById("nightModeToggle");
    const section = document.getElementById("nightSettings");
    if (toggle && section) {
        toggle.checked = mySettings.nightMode;
        section.classList.toggle("hidden", !mySettings.nightMode);
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
        // OTA binary hosted on the same GitHub Pages site
        const baseUrl = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '');
        const otaUrl = baseUrl + "/firmware.bin";
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
// Settings Sliders
// ==========================================================================
function initSliders() {
    bindSlider("dayDuration", "dayTimeMin", " min", false);
    bindSlider("dayBrightness", "dayBright", "%", true);
    bindSlider("nightDuration", "nightTimeMin", " min", false);
    bindSlider("nightBrightness", "nightBright", "%", true);
}

function bindSlider(sliderId, settingKey, suffix, isPercent) {
    const slider = document.getElementById(sliderId);
    const label = document.getElementById(sliderId + "Val");
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
// Time Picker Modal Logic
// ==========================================================================
let editingTimeTarget = null; // 'start' or 'end'
let currentPickerMode = 'hour'; // 'hour' or 'minute'
let tpTempHour24 = 0;
let tpTempMinute = 0;

function openTimePicker(target) {
    editingTimeTarget = target;
    currentPickerMode = 'hour';
    
    // Parse current setting
    const currentVal = target === 'start' ? (mySettings.nightStart || "22:00") : (mySettings.nightEnd || "08:00");
    const parts = currentVal.split(":");
    tpTempHour24 = parseInt(parts[0]);
    tpTempMinute = parseInt(parts[1]);

    document.getElementById("timePickerTitle").innerText = target === 'start' ? "Starts At" : "Ends At";
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
    publishSettings();
    closeTimePickerModal();
}

function updateTpHeader() {
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
    
    let activeVal = currentPickerMode === 'hour' ? (tpTempHour24 % 12 || 12) : tpTempMinute;

    // We draw 12 numbers arranged in a circle
    for (let i = 1; i <= 12; i++) {
        const numVal = currentPickerMode === 'hour' ? i : (i === 12 ? 0 : i * 5);
        
        const deg = i * 30; // 360 / 12 = 30
        const rad = (deg - 90) * (Math.PI / 180);
        const x = center + radius * Math.cos(rad);
        const y = center + radius * Math.sin(rad);
        
        const el = document.createElement('div');
        el.className = 'clock-number';
        if (numVal === activeVal) el.classList.add('active');
        
        el.innerText = currentPickerMode === 'minute' ? numVal.toString().padStart(2, '0') : numVal;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        
        el.onclick = () => {
            if (currentPickerMode === 'hour') {
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
    const handDeg = activeVal * (currentPickerMode === 'hour' ? 30 : 6);
    hand.style.transform = `translateX(-50%) rotate(${handDeg}deg)`;
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
        nameSpan.onclick = () => sendSignal(p.color);
        dot.onclick = () => sendSignal(p.color);
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
