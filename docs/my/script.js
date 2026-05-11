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
let mySupLampOnline = null;    // Supplementary lamp status (null = no supplementary)
let partnerSupLampOnline = null;
let hasMySupLamp = false;      // Whether supplementary status topic exists
let hasPartnerSupLamp = false;

// Read receipt state
let partnerLastTapTimestamp = 0;   // Last known tap timestamp from partner lamp
let pendingReadReceipt = false;    // Whether we're waiting for a delivery confirmation
let readReceiptTimeout = null;     // Timeout ID for read receipt fallback
let signalStatusTimer = null;      // Timer for resetting subtitle text

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
let cycleColorPicker = null;
let ambientColorPicker = null;

// Cycle preset editing state
let currentPresetMode = 'single'; // 'single' or 'cycle'
let cycleColorEntries = [];       // [{hex, hold, trans}, ...]
let selectedCycleIndex = 0;       // Which entry's color is being edited
const MAX_CYCLE_COLORS = 10;

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

        // Primary status topics
        mqttClient.subscribe(getTopic(myDeviceId, "status"));
        mqttClient.subscribe(getTopic(partnerDeviceId, "status"));
        // Supplementary status topics (ll_A2_status, ll_B2_status)
        mqttClient.subscribe(getSupTopic(myDeviceId));
        mqttClient.subscribe(getSupTopic(partnerDeviceId));
        // Settings
        mqttClient.subscribe(getTopic(myDeviceId, "settings"));
        mqttClient.subscribe(getTopic(myDeviceId, "presets"));
        mqttClient.subscribe(getTopic(partnerDeviceId, "settings"));

        updateStatusUI();
        applySettingsToUI();
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

        } else if (topic === getTopic(partnerDeviceId, "settings")) {
            // Read receipt: watch partner lamp's lastTapTimestamp for changes
            try {
                const partnerSettings = JSON.parse(msg);
                const newTimestamp = partnerSettings.lastTapTimestamp || 0;

                if (pendingReadReceipt && newTimestamp > partnerLastTapTimestamp) {
                    console.log("Read receipt confirmed! Partner tap timestamp changed:", partnerLastTapTimestamp, "->", newTimestamp);
                    confirmReadReceipt();
                }

                partnerLastTapTimestamp = newTimestamp;
            } catch (e) {
                console.error("Failed to parse partner settings:", e);
            }

        // Supplementary status topics
        } else if (topic === getSupTopic(myDeviceId)) {
            if (msg.length === 0) {
                // Empty retained message = supplementary doesn't exist
                hasMySupLamp = false;
                mySupLampOnline = null;
            } else if (msg.startsWith("ONLINE")) {
                hasMySupLamp = true;
                mySupLampOnline = true;
            } else {
                hasMySupLamp = true;
                mySupLampOnline = false;
            }
            updateStatusUI();

        } else if (topic === getSupTopic(partnerDeviceId)) {
            if (msg.length === 0) {
                hasPartnerSupLamp = false;
                partnerSupLampOnline = null;
            } else if (msg.startsWith("ONLINE")) {
                hasPartnerSupLamp = true;
                partnerSupLampOnline = true;
            } else {
                hasPartnerSupLamp = true;
                partnerSupLampOnline = false;
            }
            updateStatusUI();
        }
    });

    mqttClient.on("reconnect", () => console.log("MQTT Reconnecting..."));
    mqttClient.on("error", (err) => console.error("MQTT Error:", err));
    mqttClient.on("offline", () => {
        isMqttConnected = false;
        myLampOnline = null;
        partnerLampOnline = null;
        mySupLampOnline = null;
        partnerSupLampOnline = null;
        updateStatusUI();
    });
}

// Helper: supplementary status topic (ll_A2_status / ll_B2_status)
function getSupTopic(deviceId) {
    if (mqtt_server.includes("adafruit") && mqtt_user) {
        return `${mqtt_user}/f/ll_${deviceId}2_status`;
    }
    return `linkedlamp/${deviceId}2/status`;
}

function updateStatusUI() {
    const dot = document.getElementById("connectionDot");
    const text = document.getElementById("connectionText");

    if (!isMqttConnected) {
        dot.className = "dot connecting";
        text.innerText = "Connecting...";
        return;
    }

    if (myLampOnline === null && partnerLampOnline === null) {
        dot.className = "dot connecting";
        text.innerText = "Connecting";
        return;
    }

    // Check if any supplementary lamps exist
    const anySupplementary = hasMySupLamp || hasPartnerSupLamp;

    if (!anySupplementary) {
        // Simple mode: no supplementary lamps, show original status
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
    } else {
        // Multi-lamp mode: count total lamps and offline lamps
        const lamps = [];
        lamps.push({ name: "My Lamp", online: myLampOnline === true, mine: true });
        if (hasMySupLamp) lamps.push({ name: "My Lamp 2", online: mySupLampOnline === true, mine: true });
        lamps.push({ name: partnerName + "'s Lamp", online: partnerLampOnline === true, mine: false });
        if (hasPartnerSupLamp) lamps.push({ name: partnerName + "'s Lamp 2", online: partnerSupLampOnline === true, mine: false });

        const totalLamps = lamps.length;
        const offlineLamps = lamps.filter(l => !l.online);
        const offlineCount = offlineLamps.length;
        const anyMineOffline = offlineLamps.some(l => l.mine);

        if (offlineCount === 0) {
            dot.className = "dot online";
            text.innerText = "All Online";
        } else if (offlineCount === totalLamps) {
            dot.className = "dot offline";
            text.innerText = "All Offline";
        } else if (anyMineOffline) {
            // Orange: at least one of MY lamps is offline
            dot.className = "dot mine-offline";
            text.innerText = offlineCount === 1 ? "One Offline" : offlineCount + " Offline";
        } else {
            // Yellow: only partner lamps offline
            dot.className = "dot partial";
            text.innerText = offlineCount === 1 ? "One Offline" : offlineCount + " Offline";
        }
    }

    // Live update popup if it's open
    const popup = document.getElementById("statusPopup");
    if (popup && popup.style.display === "block") {
        updateStatusPopupContent();
    }
}

// Show or hide detailed status popup
function toggleStatusPopup(e) {
    const popup = document.getElementById("statusPopup");
    
    // If it's already open and the click was on the indicator (not inside the popup itself), close it
    if (popup.style.display === "block" && !popup.contains(e.target)) {
        popup.style.display = "none";
        document.removeEventListener("click", closeStatusPopup);
        return;
    }

    updateStatusPopupContent();
    popup.style.display = "block";

    // Close on click outside
    document.removeEventListener("click", closeStatusPopup);
    setTimeout(() => {
        document.addEventListener("click", closeStatusPopup);
    }, 10);
}

function updateStatusPopupContent() {
    const popup = document.getElementById("statusPopup");
    if (!popup) return;

    // Build lamp list
    const lamps = [];
    lamps.push({ name: "My Lamp", online: myLampOnline === true });
    if (hasMySupLamp) lamps.push({ name: "My Second Lamp", online: mySupLampOnline === true });
    lamps.push({ name: partnerName + "'s Lamp", online: partnerLampOnline === true });
    if (hasPartnerSupLamp) lamps.push({ name: partnerName + "'s Second Lamp", online: partnerSupLampOnline === true });

    let html = '<div class="status-popup-content">';
    html += '<h3>Lamp Status</h3>';
    lamps.forEach(l => {
        const dotClass = l.online ? 'status-dot-green' : 'status-dot-red';
        html += `<div class="status-lamp-row"><span class="status-lamp-dot ${dotClass}"></span><span class="status-lamp-name">${l.name}</span></div>`;
    });
    html += '</div>';

    popup.innerHTML = html;
}

function closeStatusPopup(e) {
    const popup = document.getElementById("statusPopup");
    const indicator = document.getElementById("statusIndicator");
    if (popup && !indicator.contains(e?.target)) {
        popup.style.display = "none";
        document.removeEventListener("click", closeStatusPopup);
    }
}

// ==========================================================================
// Publishing
// ==========================================================================
function sendSignal(hexColorOrPreset) {
    if (!mqttClient || !mqttClient.connected) {
        alert("Not connected to your lamp network.");
        return;
    }
    const topic = getTopic(partnerDeviceId, "color_trigger");

    // If it's a preset object with cycle colors, encode as CC: payload
    if (typeof hexColorOrPreset === 'object' && hexColorOrPreset.type === 'cycle' && hexColorOrPreset.colors) {
        const parts = hexColorOrPreset.colors.map(c => {
            const hex = c.hex.replace('#', '');
            return `${hex},${c.hold},${c.trans}`;
        });
        const payload = 'CC:' + parts.join(';');
        mqttClient.publish(topic, payload);
        console.log(`Cycle signal sent: ${payload} → ${topic}`);
    } else {
        // Plain single color
        mqttClient.publish(topic, hexColorOrPreset);
        console.log(`Signal sent (but waiting receipt confirmation): ${hexColorOrPreset} → ${topic}`);
    }

    // Start read receipt tracking
    startReadReceiptTracking();
}

// ==========================================================================
// Read Receipt (Delivery Confirmation)
// ==========================================================================
function showSignalStatus() {
    const sub = document.getElementById("signalSubtitle");

    // Clear any existing timers
    if (signalStatusTimer) clearTimeout(signalStatusTimer);
    if (readReceiptTimeout) clearTimeout(readReceiptTimeout);

    // Show "Signal Sent!" immediately
    sub.innerText = "Signal Sending...";
    sub.classList.remove("receipt-confirmed");
    sub.classList.add("receipt-pending");
}

function startReadReceiptTracking() {
    pendingReadReceipt = true;
    showSignalStatus();

    // Timeout: if no confirmation within 5 seconds, reset to default text
    readReceiptTimeout = setTimeout(() => {
        if (pendingReadReceipt) {
            pendingReadReceipt = false;
            resetSignalSubtitle();
        }
    }, 5000);
}

function confirmReadReceipt() {
    pendingReadReceipt = false;
    if (readReceiptTimeout) clearTimeout(readReceiptTimeout);

    const sub = document.getElementById("signalSubtitle");
    sub.innerText = "Signal Sent! ✨";
    sub.classList.remove("receipt-pending");
    sub.classList.add("receipt-confirmed");

    // Reset to default after 4 seconds
    signalStatusTimer = setTimeout(() => {
        sub.classList.remove("receipt-confirmed");
        resetSignalSubtitle();
    }, 4000);
}

function resetSignalSubtitle() {
    const sub = document.getElementById("signalSubtitle");
    sub.classList.remove("receipt-pending", "receipt-confirmed");
    sub.innerText = "Tap to turn on " + partnerName + "'s lamp";
}

function publishSettings() {
    const payload = JSON.stringify(mySettings);
    localStorage.setItem("ll_settings_" + myDeviceId, payload);

    if (!mqttClient || !mqttClient.connected) return;

    const topic = getTopic(myDeviceId, "settings");

    if (window._setSelfPublishing) window._setSelfPublishing(true);

    mqttClient.publish(topic, payload, { retain: true, qos: 1 }, (err) => {
        if (err) console.error("Failed to publish settings:", err);
        else console.log("Settings published to MQTT and retained:", payload);
    });

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

    mqttClient.publish(topic, payload, { retain: true, qos: 1 }, (err) => {
        if (err) console.error("Failed to publish presets:", err);
        else console.log("Presets published to MQTT and retained:", payload);
    });

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
            lastTapEl.innerText = "Last Tap Received: " + tapDate.toLocaleString();
        } else {
            lastTapEl.innerText = "Last Tap Received: Unknown";
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

        mqttClient.publish(getTopic(myDeviceId, "color_trigger"), "OTA:" + otaUrl);
        alert("Update command sent! Your lamp will restart shortly. This could take upto 5 minutes. Please do not restart your device in the meantime even if it goes offline.");

        // Clear all browser caches and force a hard reload to pick up new CSS/JS
        forceHardReload();
    } else {
        alert("Not connected to your lamp network.");
    }
}

function forceHardReload() {
    // Clear Cache API (all cached assets)
    if ('caches' in window) {
        caches.keys().then(names => {
            return Promise.all(names.map(name => caches.delete(name)));
        }).then(() => {
            console.log("All caches cleared.");
            // Hard reload bypassing browser cache
            window.location.reload(true);
        });
    } else {
        // Fallback: reload with cache-busting query param
        const url = new URL(window.location.href);
        url.searchParams.set('_cb', Date.now());
        window.location.replace(url.href);
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

    // Preset color picker (modal — single color mode)
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
        // Animate main button press
        const btn = document.getElementById("btnMainSignal");
        btn.style.transform = "scale(0.88)";
        setTimeout(() => { btn.style.transform = ""; }, 200);
    };
}

// ==========================================================================
// Cycle Color Picker (lazy-init for cycle mode)
// ==========================================================================
function ensureCycleColorPicker() {
    if (cycleColorPicker) return;
    cycleColorPicker = new iro.ColorPicker("#cycleColorPickerContainer", {
        width: 200,
        color: "#ffffff",
        borderWidth: 1,
        borderColor: "#ccc",
        layout: [{ component: iro.ui.Wheel, options: {} }]
    });

    cycleColorPicker.on("color:change", (color) => {
        if (selectedCycleIndex >= 0 && selectedCycleIndex < cycleColorEntries.length) {
            cycleColorEntries[selectedCycleIndex].hex = color.hexString;
            // Update just the dot and hex label for the selected entry
            const entry = document.querySelectorAll('.color-entry')[selectedCycleIndex];
            if (entry) {
                const dot = entry.querySelector('.color-entry-dot');
                const hexLabel = entry.querySelector('.color-entry-hex');
                if (dot) dot.style.backgroundColor = color.hexString;
                if (hexLabel) hexLabel.innerText = color.hexString;
            }
        }
    });
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
        const isCycle = p.type === 'cycle' && p.colors && p.colors.length > 0;
        btn.style.setProperty("--preset-color", isCycle ? p.colors[0].hex : p.color);

        const nameSpan = document.createElement("span");
        nameSpan.style.flex = "1";
        nameSpan.style.textAlign = "left";
        nameSpan.innerText = p.name;

        btn.appendChild(nameSpan);

        if (isCycle) {
            // Cycle icon
            const cycleIcon = document.createElement("span");
            cycleIcon.className = "material-icons-round preset-cycle-icon";
            cycleIcon.innerText = "autorenew";
            btn.appendChild(cycleIcon);

            // Multi-dot indicator
            const dotsWrap = document.createElement("div");
            dotsWrap.className = "preset-color-dots";
            const showCount = Math.min(p.colors.length, 5);
            for (let i = 0; i < showCount; i++) {
                const miniDot = document.createElement("div");
                miniDot.className = "mini-dot";
                miniDot.style.backgroundColor = p.colors[i].hex;
                dotsWrap.appendChild(miniDot);
            }
            if (p.colors.length > 5) {
                const overflow = document.createElement("span");
                overflow.className = "dots-overflow";
                overflow.innerText = "+" + (p.colors.length - 5);
                dotsWrap.appendChild(overflow);
            }
            btn.appendChild(dotsWrap);
        } else {
            const dot = document.createElement("div");
            dot.className = "preset-color-dot";
            dot.style.background = p.color;
            btn.appendChild(dot);
        }

        const editIcon = document.createElement("span");
        editIcon.className = "material-icons-round preset-edit-icon";
        editIcon.innerText = "edit";
        btn.appendChild(editIcon);

        // Tap the button area = send signal, tap edit icon = edit
        editIcon.onclick = (e) => { e.stopPropagation(); openPresetModal(p.id); };
        btn.onclick = () => {
            if (isCycle) {
                sendSignal(p); // Pass full preset object for cycle encoding
            } else {
                sendSignal(p.color);
            }
            // Visual feedback on the preset button itself
            btn.style.transform = "scale(0.93)";
            setTimeout(() => { btn.style.transform = ""; }, 200);
        };

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
        delBtn.classList.remove("hidden");

        if (p.type === 'cycle' && p.colors && p.colors.length > 0) {
            cycleColorEntries = p.colors.map(c => ({ ...c }));
            selectedCycleIndex = 0;
            setPresetMode('cycle');
        } else {
            presetColorPicker.color.hexString = p.color;
            setPresetMode('single');
        }
    } else {
        title.innerText = "New Signal";
        nameInp.value = "";
        presetColorPicker.color.hexString = "#ffffff";
        cycleColorEntries = [
            { hex: "#FF0000", hold: 30, trans: 10 },
            { hex: "#0000FF", hold: 30, trans: 10 }
        ];
        selectedCycleIndex = 0;
        delBtn.classList.add("hidden");
        setPresetMode('single');
    }
    modal.style.display = "block";
}

function closePresetModal() {
    document.getElementById("presetModal").style.display = "none";
    currentPresetMode = 'single';
}

function savePreset() {
    const name = document.getElementById("presetName").value.trim();
    if (!name) { alert("Please enter a name."); return; }

    if (currentPresetMode === 'cycle') {
        // Read durations from inputs before saving
        syncCycleDurationsFromUI();

        if (cycleColorEntries.length < 2) {
            alert("A color cycle needs at least 2 colors.");
            return;
        }

        const presetData = {
            id: editingPresetId || ("p_" + Date.now()),
            name,
            color: cycleColorEntries[0].hex,  // First color for backwards compat display
            type: 'cycle',
            colors: cycleColorEntries.map(c => ({ ...c }))
        };

        if (editingPresetId) {
            const idx = presets.findIndex(x => x.id === editingPresetId);
            if (idx >= 0) presets[idx] = presetData;
        } else {
            presets.push(presetData);
        }
    } else {
        const color = presetColorPicker.color.hexString;

        if (editingPresetId) {
            const p = presets.find(x => x.id === editingPresetId);
            if (p) {
                p.name = name;
                p.color = color;
                // Clear cycle data if switching from cycle to single
                delete p.type;
                delete p.colors;
            }
        } else {
            presets.push({ id: "p_" + Date.now(), name, color });
        }
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

// ==========================================================================
// Preset Mode Toggle (Single / Cycle)
// ==========================================================================
function setPresetMode(mode) {
    currentPresetMode = mode;

    const btnSingle = document.getElementById("btnModeSingle");
    const btnCycle = document.getElementById("btnModeCycle");
    const singleSection = document.getElementById("singleColorSection");
    const cycleSection = document.getElementById("cycleColorsSection");

    if (mode === 'cycle') {
        btnSingle.classList.remove('active');
        btnCycle.classList.add('active');
        singleSection.style.display = 'none';
        cycleSection.classList.add('visible');

        ensureCycleColorPicker();
        renderCycleColorEntries();
        selectCycleEntry(selectedCycleIndex);
    } else {
        btnSingle.classList.add('active');
        btnCycle.classList.remove('active');
        singleSection.style.display = 'block';
        cycleSection.classList.remove('visible');
    }
}

// ==========================================================================
// Cycle Color Entry Management
// ==========================================================================
function renderCycleColorEntries() {
    const list = document.getElementById("colorEntryList");
    list.innerHTML = "";

    cycleColorEntries.forEach((entry, idx) => {
        const el = document.createElement("div");
        el.className = "color-entry" + (idx === selectedCycleIndex ? " selected" : "");
        el.onclick = (e) => {
            // Don't select when clicking remove or inputs
            if (e.target.closest('.color-entry-remove') || e.target.tagName === 'INPUT') return;
            selectCycleEntry(idx);
        };

        el.innerHTML = `
            <div class="color-entry-header">
                <div class="color-entry-dot" style="background-color: ${entry.hex}"></div>
                <span class="color-entry-label">Color ${idx + 1}</span>
                <span class="color-entry-hex">${entry.hex}</span>
                ${cycleColorEntries.length > 1 ? `
                    <button class="color-entry-remove" onclick="event.stopPropagation(); removeCycleEntry(${idx})">
                        <span class="material-icons-round" style="font-size:18px;">close</span>
                    </button>
                ` : ''}
            </div>
            <div class="color-entry-durations">
                <div class="duration-field">
                    <label>Hold</label>
                    <div class="duration-input-wrap">
                        <input type="number" min="0.1" max="60" step="0.1"
                            value="${(entry.hold / 10).toFixed(1)}"
                            data-idx="${idx}" data-field="hold"
                            onchange="updateCycleDuration(this)">
                        <span class="unit">sec</span>
                    </div>
                </div>
                <div class="duration-field">
                    <label>Transition</label>
                    <div class="duration-input-wrap">
                        <input type="number" min="0" max="60" step="0.1"
                            value="${(entry.trans / 10).toFixed(1)}"
                            data-idx="${idx}" data-field="trans"
                            onchange="updateCycleDuration(this)">
                        <span class="unit">sec</span>
                    </div>
                </div>
            </div>
        `;

        list.appendChild(el);
    });

    // Update Add button visibility
    const addBtn = document.getElementById("btnAddColor");
    if (addBtn) {
        addBtn.style.display = cycleColorEntries.length >= MAX_CYCLE_COLORS ? 'none' : 'flex';
    }
}

function selectCycleEntry(idx) {
    if (idx < 0 || idx >= cycleColorEntries.length) return;
    selectedCycleIndex = idx;

    // Update visual selection
    document.querySelectorAll('.color-entry').forEach((el, i) => {
        el.classList.toggle('selected', i === idx);
    });

    // Sync the color picker to the selected entry's color
    if (cycleColorPicker) {
        cycleColorPicker.color.hexString = cycleColorEntries[idx].hex;
    }
}

function addCycleColorEntry() {
    if (cycleColorEntries.length >= MAX_CYCLE_COLORS) return;

    // New color defaults: pick a slightly different hue from the last entry
    const lastColor = cycleColorEntries.length > 0
        ? cycleColorEntries[cycleColorEntries.length - 1].hex
        : "#ffffff";
    cycleColorEntries.push({ hex: lastColor, hold: 30, trans: 10 });

    renderCycleColorEntries();
    selectCycleEntry(cycleColorEntries.length - 1);

    // Scroll the new entry into view
    const list = document.getElementById("colorEntryList");
    list.scrollTop = list.scrollHeight;
}

function removeCycleEntry(idx) {
    if (cycleColorEntries.length <= 1) return;
    cycleColorEntries.splice(idx, 1);

    // Adjust selection
    if (selectedCycleIndex >= cycleColorEntries.length) {
        selectedCycleIndex = cycleColorEntries.length - 1;
    }

    renderCycleColorEntries();
    selectCycleEntry(selectedCycleIndex);
}

function updateCycleDuration(inputEl) {
    const idx = parseInt(inputEl.dataset.idx);
    const field = inputEl.dataset.field; // 'hold' or 'trans'
    let val = parseFloat(inputEl.value);

    // Clamp
    if (isNaN(val) || val < 0) val = 0;
    if (field === 'hold' && val < 0.1) val = 0.1;
    if (val > 60) val = 60;

    // Store as tenths of seconds
    cycleColorEntries[idx][field] = Math.round(val * 10);
    inputEl.value = val.toFixed(1);
}

function syncCycleDurationsFromUI() {
    // Read all duration inputs from the DOM into cycleColorEntries
    const inputs = document.querySelectorAll('.color-entry-durations input');
    inputs.forEach(inp => {
        const idx = parseInt(inp.dataset.idx);
        const field = inp.dataset.field;
        if (idx >= 0 && idx < cycleColorEntries.length && field) {
            let val = parseFloat(inp.value);
            if (isNaN(val) || val < 0) val = 0;
            if (field === 'hold' && val < 0.1) val = 0.1;
            if (val > 60) val = 60;
            cycleColorEntries[idx][field] = Math.round(val * 10);
        }
    });
}
