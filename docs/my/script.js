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
let mqtt_delimiter = "/";

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

// Gesture read receipt delivery state
let partnerLastTapTimestamp = 0;   // Last known tap timestamp from partner lamp
let pendingReadReceipt = false;    // Whether we're waiting for a delivery confirmation
let readReceiptTimeout = null;     // Timeout ID for read receipt fallback
let signalStatusTimer = null;      // Timer for resetting subtitle text

// ==========================================================================
// MQTT Topic Builder
// ==========================================================================
function getTopic(deviceId, suffix) {
    if (mqtt_delimiter === "_" && mqtt_user) {
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

// Cached partner settings & Bonfire state
let cachedPartnerSettings = null;
try {
    const savedPSet = localStorage.getItem("ll_partner_settings_" + partnerDeviceId);
    if (savedPSet) cachedPartnerSettings = JSON.parse(savedPSet);
} catch (e) { }

let bonfireState = {
    active: false,
    lastLogEpoch: 0,
    isFlaring: false,
    flareStartTime: 0
};
let bonfireCountdownInterval = null;
let bonfireCanvasAnimId = null;

// Timezone POSIX/Abbreviation to IANA mapping table for exact browser evaluation
const tzToIanaMap = {
    "Pacific/Midway": "Pacific/Midway",
    "HST": "Pacific/Honolulu",
    "America/Anchorage": "America/Anchorage",
    "PST8PDT": "America/Los_Angeles",
    "MST7MDT": "America/Denver",
    "America/Phoenix": "America/Phoenix",
    "CST6CDT": "America/Chicago",
    "EST5EDT": "America/New_York",
    "America/Bogota": "America/Bogota",
    "AST4ADT": "America/Halifax",
    "America/Caracas": "America/Caracas",
    "America/Argentina/Buenos_Aires": "America/Argentina/Buenos_Aires",
    "America/St_Johns": "America/St_Johns",
    "America/Sao_Paulo": "America/Sao_Paulo",
    "Atlantic/Azores": "Atlantic/Azores",
    "GMT0BST": "Europe/London",
    "Europe/Lisbon": "Europe/Lisbon",
    "CET-1CEST": "Europe/Paris",
    "Africa/Johannesburg": "Africa/Johannesburg",
    "EET-2EEST": "Europe/Athens",
    "Asia/Jerusalem": "Asia/Jerusalem",
    "Europe/Moscow": "Europe/Moscow",
    "Asia/Dubai": "Asia/Dubai",
    "Asia/Kabul": "Asia/Kabul",
    "Asia/Karachi": "Asia/Karachi",
    "IST-5:30": "Asia/Kolkata",
    "Asia/Kathmandu": "Asia/Kathmandu",
    "Asia/Dhaka": "Asia/Dhaka",
    "Asia/Yangon": "Asia/Yangon",
    "Asia/Bangkok": "Asia/Bangkok",
    "CST-8": "Asia/Shanghai",
    "Asia/Singapore": "Asia/Singapore",
    "Asia/Tokyo": "Asia/Tokyo",
    "Australia/Adelaide": "Australia/Adelaide",
    "AEST-10AEDT": "Australia/Sydney",
    "Australia/Brisbane": "Australia/Brisbane",
    "Pacific/Noumea": "Pacific/Noumea",
    "Pacific/Auckland": "Pacific/Auckland"
};

let presets = [
    { id: "default_love", name: "I Love You", color: "#FF0000" },
    { id: "default_miss", name: "I Miss You", color: "#00FF00" }
];

let editingPresetId = null;

// Color picker instances (using iro.js)
let mainColorPicker = null;
let presetColorPicker = null;
let cycleColorPicker = null;
let ambientColorPicker = null;

// Cycle preset editing state
let currentPresetMode = 'single'; // 'single' or 'cycle'
let cycleColorEntries = [];       // [{hex, hold, trans}, ...]
let selectedCycleIndex = 0;       // Which entry's color is being edited

// ==========================================================================
// UID Encoding / Decoding (Base64url)
// ==========================================================================
/**
 * Encodes connection parameters into a single URL-safe Base64 string (UID).
 * Format: JSON → UTF-8 → Base64 → URL-safe (+ → -, / → _, strip trailing =)
 * Note: Name is no longer encoded in UIDs — names come from the lamp's MQTT settings topic.
 */
function encodeUID(server, user, pass, deviceId, delimiter) {
    const obj = { s: server, u: user, p: pass, id: deviceId };
    const activeDelim = delimiter || mqtt_delimiter;
    if (activeDelim && activeDelim !== "/") {
        obj.d = activeDelim;
    }
    const json = JSON.stringify(obj);
    // btoa only handles Latin1, so percent-encode unicode first
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decodes a UID string back into connection parameters.
 * Returns { s, u, p, id, name? } or null on failure.
 */
function decodeUID(uid) {
    try {
        // Restore standard Base64 from URL-safe variant
        let b64 = uid.replace(/-/g, '+').replace(/_/g, '/');
        // Pad to multiple of 4
        while (b64.length % 4) b64 += '=';
        const json = decodeURIComponent(escape(atob(b64)));
        const obj = JSON.parse(json);
        if (obj.s && obj.u && obj.p && obj.id) return obj;
        return null;
    } catch (e) {
        console.error("Failed to decode UID:", e);
        return null;
    }
}

// ==========================================================================
// Initialization
// ==========================================================================
window.addEventListener("load", () => {
    // Detect beta tester query param (?beta=true or ?beta=1)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("beta") === "true" || urlParams.get("beta") === "1") {
        localStorage.setItem("ll_beta_tester", "true");
    } else if (urlParams.get("beta") === "false" || urlParams.get("beta") === "0") {
        localStorage.setItem("ll_beta_tester", "false");
    }

    // Check if we should prompt for PWA install (mobile only, browser only)
    checkPWAInstallPrompt();

    if (!loadCredentials()) {
        const initToggle = document.getElementById("betaTesterInitToggle");
        if (initToggle) initToggle.checked = (localStorage.getItem("ll_beta_tester") === "true");
        document.getElementById("missingCredentialsModal").style.display = "flex"; // Use flex to center the content using modal's built in styling
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
    renderConnections();
    setDashboardSignalsMode('signals');
    updateFirmwareUI();
    connectMQTT();

    // Show/hide account switcher button (PWA only)
    initAccountSwitcherButton();

    // Determine the default landing page based on number of accounts & default landing preference (PWA only)
    const accounts = loadAccounts() || [];
    if (accounts.length > 1) {
        const defaultLandingUid = localStorage.getItem("ll_default_landing_uid");
        if (defaultLandingUid) {
            const defaultIdx = accounts.findIndex(a => a.uid === defaultLandingUid);
            if (defaultIdx >= 0) {
                const activeUid = localStorage.getItem("ll_uid");
                if (activeUid !== defaultLandingUid) {
                    switchToAccount(defaultIdx);
                }
                switchTab('partner');
            } else {
                switchTab('groups');
            }
        } else {
            switchTab('groups');
        }
    } else {
        switchTab('partner');
    }

    // Update page title
    document.getElementById("pageTitle").innerText = "My Group";
    document.getElementById("signalSubtitle").innerText = "Tap to turn on " + partnerName + "'s lamp";
});

// Ensure clean socket closing on page unload lifecycle events
window.addEventListener("beforeunload", () => {
    if (mqttClient) mqttClient.end(true);
});

// ==========================================================================
// Load credentials from URL state or localStorage fallback
// ==========================================================================
function loadCredentials() {
    // Try query params first (?key=val), then fall back to hash params (#key=val)
    let params = new URLSearchParams(window.location.search);
    if (!params.has("uid") && !(params.has("s") && params.has("u") && params.has("p") && params.has("id"))) {
        // Try hash params (e.g. #uid=xxx or #s=broker&u=user&p=pass&id=A)
        const hash = window.location.hash;
        if (hash && hash.length > 1) {
            params = new URLSearchParams(hash.substring(1));
        }
    }

    let foundFromUrl = false;

    // --- NEW: Check for single `uid` param first ---
    if (params.has("uid")) {
        const decoded = decodeUID(params.get("uid"));
        if (decoded) {
            mqtt_server = decoded.s;
            mqtt_user = decoded.u;
            mqtt_pass = decoded.p;
            myDeviceId = decoded.id.toUpperCase() === "B" ? "B" : "A";
            partnerDeviceId = myDeviceId === "A" ? "B" : "A";
            mqtt_delimiter = decoded.d || "/";

            const urlName = params.get("name") || params.get("partner");
            if (urlName) decoded.name = urlName;

            if (decoded.name) {
                partnerName = decoded.name;
                localStorage.setItem("ll_name", partnerName);
            }

            localStorage.setItem("ll_s", mqtt_server);
            localStorage.setItem("ll_u", mqtt_user);
            localStorage.setItem("ll_p", mqtt_pass);
            localStorage.setItem("ll_id", myDeviceId);
            localStorage.setItem("ll_delim", mqtt_delimiter);
            // Store the UID itself for account management
            localStorage.setItem("ll_uid", params.get("uid"));

            foundFromUrl = true;
        }
    }

    // --- LEGACY: Check for individual s/u/p/id params ---
    if (!foundFromUrl && params.has("s") && params.has("u") && params.has("p") && params.has("id")) {
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
        // Generate and store UID from legacy params for future use (name no longer encoded)
        localStorage.setItem("ll_uid", encodeUID(mqtt_server, mqtt_user, mqtt_pass, myDeviceId));

        foundFromUrl = true;
    }

    if (foundFromUrl) {
        // Sanitize window location parameters
        history.replaceState(null, null, window.location.pathname);

        // PWA installation profile migration handler
        migrateCurrentToAccounts();
    } else {
        mqtt_server = localStorage.getItem("ll_s");
        mqtt_user = localStorage.getItem("ll_u");
        mqtt_pass = localStorage.getItem("ll_p");
        mqtt_delimiter = localStorage.getItem("ll_delim") || "/";
        const id = localStorage.getItem("ll_id");
        if (id) {
            myDeviceId = id;
            partnerDeviceId = myDeviceId === "A" ? "B" : "A";
        }
        const savedName = localStorage.getItem("ll_name");
        if (savedName) partnerName = savedName;
    }

    // Generate missing UID for legacy clients
    if (mqtt_server && mqtt_user && mqtt_pass && !localStorage.getItem("ll_uid")) {
        const uid = encodeUID(mqtt_server, mqtt_user, mqtt_pass, myDeviceId, mqtt_delimiter);
        localStorage.setItem("ll_uid", uid);
    }

    // Run migration to copy legacy settings/presets to the UID-based keys
    migrateCurrentToAccounts();

    // Load saved settings & presets
    const activeUid = localStorage.getItem("ll_uid");
    const saved = activeUid ? localStorage.getItem("ll_settings_" + activeUid) : null;
    if (saved) {
        try { mySettings = JSON.parse(saved); } catch (e) { /* use defaults */ }
    } else {
        mySettings = {
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
    }
    const savedPresets = activeUid ? localStorage.getItem("ll_presets_" + activeUid) : null;
    if (savedPresets) {
        try { presets = JSON.parse(savedPresets); } catch (e) { /* use defaults */ }
    } else {
        presets = [
            { id: "default_love", name: "I Love You", color: "#FF0000" },
            { id: "default_miss", name: "I Miss You", color: "#00FF00" }
        ];
    }

    return !!(mqtt_server && mqtt_user && mqtt_pass);
}

// ==========================================================================
// Connect via UID Input (replaces old manual link paste)
// ==========================================================================
function connectWithUID() {
    const inputEl = document.getElementById("uidInput");
    const errorEl = document.getElementById("uidInputError");
    const raw = inputEl.value.trim();

    if (!raw) {
        errorEl.style.display = "block";
        errorEl.innerText = "Please enter your Unique ID.";
        return;
    }

    // Try decoding as a UID first
    let decoded = decodeUID(raw);

    // If that fails, try to parse as a full URL (backwards compat)
    if (!decoded) {
        try {
            const url = new URL(raw);
            let searchParams = new URLSearchParams(url.search);
            if (!searchParams.has("uid") && !searchParams.has("s")) {
                searchParams = new URLSearchParams(url.hash.substring(1));
            }
            if (searchParams.has("uid")) {
                decoded = decodeUID(searchParams.get("uid"));
            } else if (searchParams.has("s") && searchParams.has("u") && searchParams.has("p") && searchParams.has("id")) {
                decoded = {
                    s: searchParams.get("s"),
                    u: searchParams.get("u"),
                    p: searchParams.get("p"),
                    id: searchParams.get("id"),
                    name: searchParams.get("name") || searchParams.get("partner") || null
                };
            }
        } catch (e) {
            // Not a URL, that's fine — UID decode already failed
        }
    }

    if (!decoded) {
        errorEl.style.display = "block";
        errorEl.innerText = "Invalid ID. Please check and try again.";
        return;
    }

    // Save credentials to localStorage
    localStorage.setItem("ll_s", decoded.s);
    localStorage.setItem("ll_u", decoded.u);
    localStorage.setItem("ll_p", decoded.p);
    localStorage.setItem("ll_id", decoded.id.toUpperCase() === "B" ? "B" : "A");
    localStorage.setItem("ll_delim", decoded.d || "/");
    if (decoded.name) localStorage.setItem("ll_name", decoded.name);

    // Generate and store UID
    const uid = encodeUID(decoded.s, decoded.u, decoded.p, decoded.id, decoded.d || "/");
    localStorage.setItem("ll_uid", uid);

    // Save Beta Tester Program choice for this lamp
    const initToggle = document.getElementById("betaTesterInitToggle");
    const isBeta = initToggle ? initToggle.checked : false;
    localStorage.setItem("ll_beta_tester", isBeta ? "true" : "false");
    localStorage.setItem("ll_beta_tester_" + uid, isBeta ? "true" : "false");

    // Migrate to accounts
    migrateCurrentToAccounts();

    // Reload the page to pick up the new credentials
    window.location.reload();
}

// ==========================================================================
// MQTT Connection
// ==========================================================================
function connectMQTT() {
    let clean_server = mqtt_server;
    let active_port = 8084; // Default WSS port (EMQX, HiveMQ)

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

        // Bonfire State Topics
        mqttClient.subscribe(getTopic(myDeviceId, "bonfire"));
        mqttClient.subscribe(getTopic(partnerDeviceId, "bonfire"));

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

                if (incomingSettings.fwVersion) {
                    localStorage.setItem("ll_fw_version_" + myDeviceId, incomingSettings.fwVersion);
                } else {
                    delete mySettings.fwVersion;
                    localStorage.removeItem("ll_fw_version_" + myDeviceId);
                }

                if (changed) {
                    console.log("Applied remote settings from MQTT:", mySettings);
                    // Save to local storage
                    const activeUid = localStorage.getItem("ll_uid");
                    if (activeUid) localStorage.setItem("ll_settings_" + activeUid, JSON.stringify(mySettings));
                    localStorage.setItem("ll_settings_" + myDeviceId, JSON.stringify(mySettings));
                    // Update UI elements visually
                    applySettingsToUI();
                } else {
                    updateFirmwareUI();
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
                    const activeUid = localStorage.getItem("ll_uid");
                    if (activeUid) localStorage.setItem("ll_presets_" + activeUid, JSON.stringify(presets));
                    localStorage.setItem("ll_presets_" + myDeviceId, JSON.stringify(presets));
                    renderPresets();
                    console.log("Applied remote presets from MQTT.");
                }
            } catch (e) {
                console.error("Failed to parse incoming presets payload:", e);
            }

        } else if (topic === getTopic(partnerDeviceId, "settings")) {
            // Read receipt: watch partner lamp's lastTapTimestamp for changes
            // Also extract partner's ownerName from their lamp's settings topic
            try {
                const partnerSettings = JSON.parse(msg);
                cachedPartnerSettings = partnerSettings;
                localStorage.setItem("ll_partner_settings_" + partnerDeviceId, msg);
                const newTimestamp = partnerSettings.lastTapTimestamp || 0;

                if (pendingReadReceipt && newTimestamp > partnerLastTapTimestamp) {
                    console.log("Read receipt confirmed! Partner tap timestamp changed:", partnerLastTapTimestamp, "->", newTimestamp);
                    confirmReadReceipt();
                }

                partnerLastTapTimestamp = newTimestamp;

                // Auto-discover partner name from their lamp's settings (ownerName field)
                if (partnerSettings.ownerName && partnerSettings.ownerName !== partnerName) {
                    partnerName = partnerSettings.ownerName;
                    localStorage.setItem("ll_name", partnerName);
                    console.log("Partner name updated from MQTT settings:", partnerName);
                    // Update UI elements that show the partner's name
                    const sub = document.getElementById("signalSubtitle");
                    if (sub) sub.innerText = "Tap to turn on " + partnerName + "'s lamp";
                    updateStatusUI();

                    // Also update the account name in the switcher list
                    const currentUid = localStorage.getItem("ll_uid");
                    const accounts = loadAccounts();
                    if (accounts && currentUid) {
                        const acct = accounts.find(a => a.uid === currentUid);
                        if (acct) {
                            acct.name = partnerName;
                            saveAccounts(accounts);
                        }
                    }
                }
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
        } else if (topic === getTopic(myDeviceId, "bonfire") || topic === getTopic(partnerDeviceId, "bonfire")) {
            handleIncomingBonfireMessage(msg);
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
    if (mqtt_delimiter === "_" && mqtt_user) {
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
    lamps.push({ id: 'primary', name: "My Lamp", online: myLampOnline === true, mine: true });
    if (hasMySupLamp) lamps.push({ id: 'secondary', name: "My Second Lamp", online: mySupLampOnline === true, mine: true });
    lamps.push({ id: 'partner_primary', name: partnerName + "'s Lamp", online: partnerLampOnline === true, mine: false });
    if (hasPartnerSupLamp) lamps.push({ id: 'partner_secondary', name: partnerName + "'s Second Lamp", online: partnerSupLampOnline === true, mine: false });

    let html = '<div class="status-popup-content">';
    html += '<h3>Lamp Status</h3>';
    lamps.forEach(l => {
        const dotClass = l.online ? 'status-dot-green' : 'status-dot-red';
        let rowHtml = `<div class="status-lamp-row"`;

        if (!l.online && l.mine) {
            rowHtml += ` onclick="promptRemoveLamp('${l.id}', '${l.name}')" style="cursor: pointer;" title="Click to remove offline lamp"`;
        }

        rowHtml += `><span class="status-lamp-dot ${dotClass}"></span><span class="status-lamp-name">${l.name}</span></div>`;
        html += rowHtml;
    });
    html += '</div>';

    popup.innerHTML = html;
}

window.promptRemoveLamp = function (lampId, lampName) {
    if (confirm(`Do you wish to remove ${lampName} from your group?`)) {
        let topic = "";
        if (lampId === 'primary') {
            topic = getTopic(myDeviceId, "status");
        } else if (lampId === 'secondary') {
            topic = getSupTopic(myDeviceId);
        }

        if (topic && mqttClient && mqttClient.connected) {
            mqttClient.publish(topic, "", { retain: true, qos: 1 }, (err) => {
                if (err) console.error("Failed to clear lamp status:", err);
                else console.log(`Cleared status topic: ${topic}`);
            });
        }
    }
};

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
    // If Bonfire is active, sending any signal counts as adding a log to the fire!
    if (bonfireState.active) {
        handleAddLogFromUI();
        return;
    }

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
    sub.innerText = "Signal Sent!";
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
    const activeUid = localStorage.getItem("ll_uid");
    const payload = JSON.stringify(mySettings);
    if (activeUid) localStorage.setItem("ll_settings_" + activeUid, payload);
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
    const activeUid = localStorage.getItem("ll_uid");
    const payload = JSON.stringify(presets);
    if (activeUid) localStorage.setItem("ll_presets_" + activeUid, payload);
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
    // Brightness slider interface mappings
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
            slider.dispatchEvent(new Event("input"));
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

    // Ambient Toggle & mode pill
    const ambToggle = document.getElementById("ambientModeToggle");
    if (ambToggle) {
        ambToggle.checked = mySettings.ambientMode;
    }
    updateAmbientPill();

    // Bonfire Toggle
    const bonfireToggle = document.getElementById("bonfireToggle");
    if (bonfireToggle) {
        bonfireToggle.checked = bonfireState.active;
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

    // Firmware Version & Beta Program UI
    updateFirmwareUI();
}

function handleBetaTesterToggle(isChecked) {
    localStorage.setItem("ll_beta_tester", isChecked ? "true" : "false");
    const activeUid = localStorage.getItem("ll_uid");
    if (activeUid) {
        localStorage.setItem("ll_beta_tester_" + activeUid, isChecked ? "true" : "false");
    }
    const initToggle = document.getElementById("betaTesterInitToggle");
    if (initToggle) initToggle.checked = isChecked;
    updateFirmwareUI();
}

function parseSemVer(v) {
    if (!v) return { major: 0, minor: 0, patch: 0, isBeta: false, beta: null };
    const clean = String(v).trim().replace(/^v/i, "");
    const [base, betaPart] = clean.split("-");
    const parts = (base || "").split(".").map(Number);
    let betaNum = null;
    if (betaPart && betaPart.startsWith("beta.")) {
        betaNum = parseInt(betaPart.replace("beta.", ""), 10) || 0;
    }
    return {
        major: parts[0] || 0,
        minor: parts[1] || 0,
        patch: parts[2] || 0,
        isBeta: betaPart !== undefined,
        beta: betaNum
    };
}

function compareVersions(v1, v2) {
    const a = parseSemVer(v1);
    const b = parseSemVer(v2);

    if (a.major !== b.major) return a.major > b.major ? 1 : -1;
    if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
    if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;

    // Same base (M.m.p): Stable > Beta
    if (!a.isBeta && b.isBeta) return 1;  // 1.2.4 > 1.2.4-beta.5
    if (a.isBeta && !b.isBeta) return -1; // 1.2.4-beta.5 < 1.2.4
    if (a.isBeta && b.isBeta) {
        if (a.beta !== b.beta) return a.beta > b.beta ? 1 : -1;
    }
    return 0;
}

function updateFirmwareUI() {
    const versions = window.LINKED_LAMP_VERSIONS || { stable: "1.0.0", beta: null };
    const activeUid = localStorage.getItem("ll_uid");
    const isBetaTester = (activeUid && localStorage.getItem("ll_beta_tester_" + activeUid) !== null)
        ? (localStorage.getItem("ll_beta_tester_" + activeUid) === "true")
        : (localStorage.getItem("ll_beta_tester") === "true");

    const initToggle = document.getElementById("betaTesterInitToggle");
    if (initToggle) initToggle.checked = isBetaTester;

    // Determine target version for this user
    let targetVersion = versions.stable;
    if (isBetaTester && versions.beta && compareVersions(versions.beta, versions.stable) > 0) {
        targetVersion = versions.beta;
    }

    // Check if the lamp has reported a firmware version.
    // If no firmware version is reported by the lamp (e.g. running older unversioned firmware),
    // it is NOT up to date and must show the update button!
    const reportedFw = mySettings.fwVersion || localStorage.getItem("ll_fw_version_" + myDeviceId);
    const updateAvailable = !reportedFw || (compareVersions(targetVersion, reportedFw) > 0);

    const updateCard = document.getElementById("firmwareUpdateCard");
    const updateBtn = document.getElementById("btnCheckUpdate");
    const fwFooterText = document.getElementById("fwVersionFooterText");

    if (updateAvailable) {
        if (updateCard) updateCard.style.display = "block";
        if (updateBtn) {
            updateBtn.innerHTML = `<span class="material-icons-round">system_update</span> Update to v${targetVersion}${targetVersion.includes("beta") ? " (Beta)" : ""}`;
            updateBtn.onclick = () => triggerUpdate(targetVersion);
        }
        if (fwFooterText) fwFooterText.style.display = "none";
    } else {
        // Fully updated: Hide update button!
        if (updateCard) updateCard.style.display = "none";
        // Show light small text at the bottom of settings page
        if (fwFooterText) {
            fwFooterText.style.display = "block";
            fwFooterText.textContent = `Firmware v${reportedFw} (Up to date)`;
        }
    }
}

function triggerUpdate(targetVersion) {
    const versionLabel = targetVersion ? ` to v${targetVersion}` : "";
    if (!confirm(`Push a firmware update${versionLabel} to your lamp? It will restart briefly.`)) return;
    if (mqttClient && mqttClient.connected) {
        // Send only the base URL to allow the lamp to decipher its correct firmware file (PCB vs NeoPixel)
        let otaUrl = new URL("../", window.location.href).href;
        if (targetVersion && targetVersion.includes("beta")) {
            otaUrl += "?beta=1";
        }

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
    // Reset scroll position of the content area to the top instantly (bypassing smooth scroll conflicts)
    const contentArea = document.querySelector(".content-area");
    if (contentArea) {
        const prevBehavior = contentArea.style.scrollBehavior;
        contentArea.style.scrollBehavior = "auto";
        contentArea.scrollTop = 0;
        contentArea.offsetHeight; // Force layout reflow
        contentArea.style.scrollBehavior = prevBehavior;
    }

    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    document.getElementById("view-" + tabId).classList.add("active");

    const bottomNav = document.querySelector(".bottom-nav");
    const appHeader = document.querySelector(".app-header");

    if (tabId === "groups") {
        if (bottomNav) bottomNav.style.display = "none";
        if (appHeader) appHeader.style.display = "none";
        renderGroupsPage();
    } else {
        if (bottomNav) bottomNav.style.display = "flex";
        if (appHeader) appHeader.style.display = "flex";
        document.getElementById("navSend").classList.toggle("active", tabId === "partner");
        document.getElementById("navSettings").classList.toggle("active", tabId === "settings");
        document.getElementById("pageTitle").innerText = tabId === "partner" ? (bonfireState.active ? "Virtual Bonfire" : "My Group") : "My Settings";
        if (tabId === "partner") {
            setDashboardSignalsMode('signals');
        }
        if (tabId === "settings") {
            updateFirmwareUI();
        }
    }
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

    // Ambient color picker is lazily initialized inside selectAmbientMode() / openAmbientSettingsModal()

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
// Ambient Lighting Modes & Modal
// ==========================================================================
const AMBIENT_MODES = {
    SOLID: {
        label: "Solid Color",
        icon: "palette",
        desc: "A constant glow in a color of your choice."
    },
    FIRE: {
        label: "Fireplace",
        icon: "local_fire_department",
        desc: "Warm, flickering campfire glow."
    },
    BREATH: {
        label: "Breathe",
        icon: "air",
        desc: "A soft lavender glow that slowly rises and falls."
    },
    LAVA: {
        label: "Lava Lamp",
        icon: "bubble_chart",
        desc: "Drifts between coral and amber over about a minute."
    },
    RAIN: {
        label: "Rain",
        icon: "water_drop",
        desc: "Dim slate blue with an occasional soft flicker."
    },
    AURORA: {
        label: "Aurora",
        icon: "waves",
        desc: "Slowly shifts through greens, teals, and violets."
    }
};

let ambientColorBeforeEdit = null;
let selectedAmbientModeCode = "SOLID";

function getAmbientModeCode(val) {
    if (!val) return "SOLID";
    const v = String(val).trim().toUpperCase();
    if (v === "FIRE" || v === "BREATH" || v === "LAVA" || v === "RAIN" || v === "AURORA") {
        return v;
    }
    return "SOLID";
}

function updateAmbientPill() {
    const pill = document.getElementById("btnAmbientModePill");
    const icon = document.getElementById("ambientPillIcon");

    if (!pill) return;

    if (!mySettings.ambientMode) {
        pill.style.display = "none";
        return;
    }

    pill.style.display = "inline-flex";
    const modeCode = getAmbientModeCode(mySettings.ambientColor);
    const modeInfo = AMBIENT_MODES[modeCode] || AMBIENT_MODES.SOLID;

    pill.title = modeInfo.label;

    if (modeCode === "SOLID") {
        const hex = mySettings.ambientColor && mySettings.ambientColor.startsWith("#")
            ? mySettings.ambientColor
            : "#FFAA00";
        pill.classList.remove("mode-animated");
        pill.classList.add("mode-solid");
        pill.style.backgroundColor = hex;
        if (icon) {
            icon.style.display = "none";
            icon.textContent = "";
        }
    } else {
        pill.classList.remove("mode-solid");
        pill.classList.add("mode-animated");
        pill.style.backgroundColor = "";
        if (icon) {
            icon.style.display = "inline-block";
            icon.textContent = modeInfo.icon;
        }
    }
}

function initAmbientToggle() {
    const toggle = document.getElementById("ambientModeToggle");
    if (!toggle) return;

    toggle.checked = mySettings.ambientMode;
    updateAmbientPill();

    toggle.onchange = () => {
        mySettings.ambientMode = toggle.checked;
        updateAmbientPill();
        publishSettings();
    };
}

// ==========================================================================
// High-Fidelity Borderless Canvas Simulation Engine for Ambient Lighting
// ==========================================================================
class AmbientCanvasRenderer {
    constructor(canvasId) {
        this.canvasId = canvasId;
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas ? this.canvas.getContext("2d") : null;
        this.animId = null;
        this.currentMode = null;
        this.lastTime = 0;
        this.elapsed = 0;

        // Particle systems & states
        this.fireParticles = [];
        this.fireSparks = [];
        this.raindrops = [];
        this.ripples = [];
        this.splashes = [];
        this.lightningTime = 0;
        this.auroraStars = [];
        this.breatheMotes = [];
        this.lavaBlobs = [];

        this.initStaticElements();
    }

    initStaticElements() {
        // Star canopy for Aurora
        this.auroraStars = [];
        for (let i = 0; i < 90; i++) {
            this.auroraStars.push({
                x: Math.random() * 800,
                y: Math.random() * 300,
                r: Math.random() * 1.6 + 0.6,
                phase: Math.random() * Math.PI * 2,
                speed: Math.random() * 2 + 1.2,
                alpha: Math.random() * 0.7 + 0.3
            });
        }

        // Stardust motes for Breathe
        this.breatheMotes = [];
        for (let i = 0; i < 35; i++) {
            this.breatheMotes.push({
                x: 400 + (Math.random() - 0.5) * 440,
                y: 220 + (Math.random() - 0.5) * 320,
                vx: (Math.random() - 0.5) * 0.45,
                vy: (Math.random() - 0.5) * 0.45,
                r: Math.random() * 1.8 + 0.8,
                phase: Math.random() * Math.PI * 2,
                alpha: Math.random() * 0.6 + 0.2
            });
        }

        // Rain setup
        this.initRain();

        // Lava blobs
        this.initLavaBlobs();
    }

    initRain() {
        this.raindrops = [];
        for (let i = 0; i < 150; i++) {
            this.raindrops.push(this.createRaindrop(true));
        }
        this.ripples = [];
        this.splashes = [];
        // Natural thunderstorm pacing: first strike at ~4.5s so user sees it quickly, then 14-22s intervals
        this.nextLightningTime = 4.5 + Math.random() * 2.0;
        this.lightningActive = false;
        this.lightningStartTime = 0;
        this.lightningBolt = null;
    }

    createRaindrop(randomY = false) {
        // Natural 3D depth layer: z from 0.25 (distant) to 1.0 (foreground)
        const z = Math.random() * 0.75 + 0.25;
        const speed = (18 + Math.random() * 14) * z;
        const length = (22 + Math.random() * 26) * z;
        const thickness = (0.8 + Math.random() * 1.4) * z;
        const alpha = (0.2 + Math.random() * 0.7) * z;
        return {
            x: Math.random() * 960 - 80,
            y: randomY ? Math.random() * 460 : -Math.random() * 60 - 20,
            z: z,
            vx: -Math.tan(14 * Math.PI / 180) * speed, // natural 14° wind slant
            vy: speed,
            length: length,
            thickness: thickness,
            alpha: alpha
        };
    }

    createLightningBolt(startX, startY, endX, endY) {
        const segments = [];
        let curX = startX;
        let curY = startY;
        const steps = 14;
        const dy = (endY - startY) / steps;

        for (let i = 0; i < steps; i++) {
            const nextY = curY + dy;
            const deviation = (Math.random() - 0.5) * 48;
            const nextX = curX + deviation + (endX - curX) * 0.12;
            segments.push({ x1: curX, y1: curY, x2: nextX, y2: nextY, isMain: true });

            // Forked branches
            if (Math.random() < 0.38 && i > 2 && i < steps - 2) {
                let branchX = nextX;
                let branchY = nextY;
                const branchSteps = 3 + Math.floor(Math.random() * 4);
                const branchDir = Math.random() < 0.5 ? -1 : 1;
                for (let b = 0; b < branchSteps; b++) {
                    const bNextX = branchX + branchDir * (14 + Math.random() * 20);
                    const bNextY = branchY + (10 + Math.random() * 16);
                    segments.push({ x1: branchX, y1: branchY, x2: bNextX, y2: bNextY, isMain: false });
                    branchX = bNextX;
                    branchY = bNextY;
                }
            }

            curX = nextX;
            curY = nextY;
        }
        return segments;
    }

    initLavaBlobs() {
        // Authentic retro lava lamp: 2-3 persistent droplets with genuine fluid physics & collision merging
        this.lavaBlobs = [
            {
                id: 0,
                curX: 400,
                y: 280,
                r: 24,
                baseR: 24,
                vy: -15, // buoyant rise
                state: "RISING",
                dwellTimer: 0,
                dwellTotal: 3.5,
                driftSpeed: 0.5,
                phase: 0.2,
                wobble: 0,
                active: true,
                mergedInto: -1,
                mergedTimer: 0
            },
            {
                id: 1,
                curX: 400,
                y: 165,
                r: 20,
                baseR: 20,
                vy: 14, // cool sinking
                state: "SINKING",
                dwellTimer: 0,
                dwellTotal: 3.8,
                driftSpeed: 0.65,
                phase: 3.1,
                wobble: 0,
                active: true,
                mergedInto: -1,
                mergedTimer: 0
            },
            {
                id: 2,
                curX: 400,
                y: 350,
                r: 16,
                baseR: 16,
                vy: -12,
                state: "DWELL_BOTTOM",
                dwellTimer: 2.2, // will erupt after 2.2s
                dwellTotal: 3.6,
                driftSpeed: 0.42,
                phase: 1.6,
                wobble: 0,
                active: true,
                mergedInto: -1,
                mergedTimer: 0
            }
        ];
        this.bottomRecoil = 0;
        this.topRecoil = 0;
    }

    start(mode) {
        this.stop();
        if (!this.canvas) {
            this.canvas = document.getElementById(this.canvasId);
            if (this.canvas) this.ctx = this.canvas.getContext("2d");
        }
        if (!this.ctx) return;

        this.currentMode = mode;
        this.lastTime = performance.now();
        this.elapsed = 0;
        this.fireParticles = [];
        this.fireSparks = [];

        if (mode === "RAIN") this.initRain();
        if (mode === "LAVA") this.initLavaBlobs();

        const loop = (now) => {
            const dt = Math.min((now - this.lastTime) / 1000, 0.08);
            this.lastTime = now;
            this.elapsed += dt;

            this.render(dt);
            this.animId = requestAnimationFrame(loop);
        };
        this.animId = requestAnimationFrame(loop);
    }

    stop() {
        if (this.animId) {
            cancelAnimationFrame(this.animId);
            this.animId = null;
        }
        if (this.ctx) {
            this.ctx.clearRect(0, 0, 800, 480);
        }
        this.currentMode = null;
    }

    render(dt) {
        const ctx = this.ctx;
        if (!ctx) return;

        // Completely transparent clear - NO BOX!
        ctx.clearRect(0, 0, 800, 480);

        switch (this.currentMode) {
            case "FIRE":
                this.renderFireplace(ctx, dt);
                break;
            case "BREATH":
                this.renderBreathe(ctx, dt);
                break;
            case "LAVA":
                this.renderLavaLamp(ctx, dt);
                break;
            case "RAIN":
                this.renderRain(ctx, dt);
                break;
            case "AURORA":
                this.renderAurora(ctx, dt);
                break;
        }
    }

    // =========================================================================
    // 1. Realistic Fireplace Simulation
    // =========================================================================
    renderFireplace(ctx, dt) {
        ctx.save();

        // 1. Background Warmth Radials (borderless natural ambient glow)
        const flicker = Math.sin(this.elapsed * 4.5) * 0.04 + Math.sin(this.elapsed * 9.2) * 0.02;
        const ambientAlpha = 0.22 + flicker;
        const ambientGrad = ctx.createRadialGradient(400, 390, 20, 400, 390, 300);
        ambientGrad.addColorStop(0, `rgba(255, 90, 0, ${ambientAlpha})`);
        ambientGrad.addColorStop(0.5, `rgba(255, 45, 0, ${ambientAlpha * 0.5})`);
        ambientGrad.addColorStop(1, "rgba(255, 30, 0, 0)");
        ctx.fillStyle = ambientGrad;
        ctx.beginPath();
        ctx.arc(400, 390, 300, 0, Math.PI * 2);
        ctx.fill();

        // 2. Realistic Charred Firewood Logs & Incandescent Coals
        // Charcoal coals bed
        const coalHeat = 0.75 + 0.25 * Math.sin(this.elapsed * 3.8);
        const coalGrad = ctx.createRadialGradient(400, 410, 10, 400, 410, 140);
        coalGrad.addColorStop(0, `rgba(255, 120, 0, ${coalHeat})`);
        coalGrad.addColorStop(0.4, `rgba(255, 40, 0, ${coalHeat * 0.8})`);
        coalGrad.addColorStop(0.8, "rgba(60, 12, 4, 0.9)");
        coalGrad.addColorStop(1, "rgba(20, 4, 2, 0)");
        ctx.fillStyle = coalGrad;
        ctx.beginPath();
        ctx.ellipse(400, 412, 130, 24, 0, 0, Math.PI * 2);
        ctx.fill();

        // Rear log
        ctx.save();
        ctx.translate(400, 385);
        ctx.rotate(-0.04);
        const rearLogGrad = ctx.createLinearGradient(-100, -12, 100, 12);
        rearLogGrad.addColorStop(0, "#120603");
        rearLogGrad.addColorStop(0.5, "#250d06");
        rearLogGrad.addColorStop(1, "#120603");
        ctx.fillStyle = rearLogGrad;
        ctx.beginPath();
        ctx.roundRect(-95, -12, 190, 24, 8);
        ctx.fill();
        ctx.restore();

        // Front left log
        ctx.save();
        ctx.translate(345, 405);
        ctx.rotate(0.18);
        const leftLogGrad = ctx.createLinearGradient(-60, -14, 60, 14);
        leftLogGrad.addColorStop(0, "#190804");
        leftLogGrad.addColorStop(0.45, "#3b160b");
        leftLogGrad.addColorStop(1, "#150603");
        ctx.fillStyle = leftLogGrad;
        ctx.beginPath();
        ctx.roundRect(-60, -14, 120, 28, 8);
        ctx.fill();
        // Glowing ember fissures on log
        ctx.strokeStyle = `rgba(255, 140, 0, ${0.6 + coalHeat * 0.35})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(-35, 0); ctx.lineTo(25, -2);
        ctx.stroke();
        ctx.restore();

        // Front right log
        ctx.save();
        ctx.translate(455, 405);
        ctx.rotate(-0.18);
        const rightLogGrad = ctx.createLinearGradient(-60, -14, 60, 14);
        rightLogGrad.addColorStop(0, "#150603");
        rightLogGrad.addColorStop(0.5, "#35140a");
        rightLogGrad.addColorStop(1, "#190804");
        ctx.fillStyle = rightLogGrad;
        ctx.beginPath();
        ctx.roundRect(-60, -14, 120, 28, 8);
        ctx.fill();
        // Ember crack
        ctx.strokeStyle = `rgba(255, 120, 0, ${0.55 + coalHeat * 0.35})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(-20, -2); ctx.lineTo(35, 1);
        ctx.stroke();
        ctx.restore();

        // 3. Thermal Fluid Flame Particles (Buoyant Convection Physics)
        // Spawn new buoyant flame particles
        for (let i = 0; i < 5; i++) {
            this.fireParticles.push({
                x: 400 + (Math.random() - 0.5) * 85,
                y: 400 + (Math.random() - 0.5) * 18,
                vx: (Math.random() - 0.5) * 0.9,
                vy: -Math.random() * 2.8 - 2.4,
                size: Math.random() * 26 + 22,
                maxLife: Math.random() * 0.65 + 0.45,
                life: 0,
                turbulence: Math.random() * 100
            });
        }

        // Draw flames with additive blending for true white-hot luminescence
        ctx.globalCompositeOperation = "screen";
        for (let i = this.fireParticles.length - 1; i >= 0; i--) {
            const p = this.fireParticles[i];
            p.life += dt;
            if (p.life >= p.maxLife) {
                this.fireParticles.splice(i, 1);
                continue;
            }

            p.vy -= 6.5 * dt; // upward thermal acceleration
            p.x += Math.sin(p.turbulence + p.y * 0.035 + this.elapsed * 8) * 1.8 + p.vx;
            p.y += p.vy;

            const t = p.life / p.maxLife; // 0 (birth) to 1 (death)
            const r = p.size * (1 - t * 0.72);
            if (r <= 0.5) continue;

            const fGrad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
            if (t < 0.22) {
                // White-yellow blazing core
                fGrad.addColorStop(0, "rgba(255, 255, 240, 0.95)");
                fGrad.addColorStop(0.35, "rgba(255, 210, 80, 0.85)");
                fGrad.addColorStop(0.7, "rgba(255, 120, 0, 0.5)");
                fGrad.addColorStop(1, "rgba(255, 40, 0, 0)");
            } else if (t < 0.6) {
                // Golden amber flame mantle
                fGrad.addColorStop(0, "rgba(255, 220, 80, 0.88)");
                fGrad.addColorStop(0.4, "rgba(255, 140, 0, 0.75)");
                fGrad.addColorStop(0.8, "rgba(240, 50, 0, 0.4)");
                fGrad.addColorStop(1, "rgba(200, 20, 0, 0)");
            } else {
                // Cooling scarlet crimson tips
                const alpha = (1 - t) / 0.4;
                fGrad.addColorStop(0, `rgba(255, 110, 0, ${alpha * 0.7})`);
                fGrad.addColorStop(0.5, `rgba(220, 30, 0, ${alpha * 0.5})`);
                fGrad.addColorStop(1, "rgba(100, 10, 0, 0)");
            }

            ctx.fillStyle = fGrad;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fill();
        }

        // 4. Ascending Sparks & Micro-Embers
        if (Math.random() < 0.35 && this.fireSparks.length < 25) {
            this.fireSparks.push({
                x: 400 + (Math.random() - 0.5) * 80,
                y: 390 + (Math.random() - 0.5) * 15,
                vx: (Math.random() - 0.5) * 1.5,
                vy: -Math.random() * 4.5 - 3.0,
                r: Math.random() * 1.8 + 1.0,
                maxLife: Math.random() * 1.2 + 0.8,
                life: 0,
                swirl: Math.random() * 50
            });
        }

        for (let i = this.fireSparks.length - 1; i >= 0; i--) {
            const spk = this.fireSparks[i];
            spk.life += dt;
            if (spk.life >= spk.maxLife) {
                this.fireSparks.splice(i, 1);
                continue;
            }
            spk.vy -= 1.8 * dt;
            spk.x += Math.sin(spk.swirl + this.elapsed * 7) * 2.2 + spk.vx;
            spk.y += spk.vy;

            const alpha = 1 - spk.life / spk.maxLife;
            ctx.fillStyle = `rgba(255, 235, 180, ${alpha})`;
            ctx.shadowColor = "#ff7700";
            ctx.shadowBlur = 6;
            ctx.beginPath();
            ctx.arc(spk.x, spk.y, spk.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
        }

        ctx.restore();
    }

    // =========================================================================
    // 2. Realistic, Bug-Free Breathe Simulation (Lavender Harmonic Pulse)
    // =========================================================================
    renderBreathe(ctx, dt) {
        ctx.save();
        const centerX = 400;
        const centerY = 220;

        // Smooth mathematical sinusoidal respiratory cycle
        const cycle = (Math.sin(this.elapsed * 1.15) + 1) * 0.5;
        const smoothCycle = cycle * cycle * (3 - 2 * cycle); // smoothstep ease-in-out

        // 1. Concentric Harmonic Wavefronts
        for (let i = 0; i < 3; i++) {
            const progress = ((this.elapsed * 0.22 + i * 0.33) % 1);
            const ringR = 55 + progress * 175;
            const ringAlpha = Math.sin(progress * Math.PI) * (0.22 + smoothCycle * 0.32);
            ctx.strokeStyle = `rgba(199, 125, 255, ${ringAlpha})`;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.arc(centerX, centerY, ringR, 0, Math.PI * 2);
            ctx.stroke();
        }

        // 2. Volumetric Celestial Corona Glow
        const coronaR = 120 + smoothCycle * 85;
        const coronaGrad = ctx.createRadialGradient(centerX, centerY, 20, centerX, centerY, coronaR);
        coronaGrad.addColorStop(0, `rgba(224, 170, 255, ${0.45 + smoothCycle * 0.35})`);
        coronaGrad.addColorStop(0.35, `rgba(157, 78, 221, ${0.25 + smoothCycle * 0.22})`);
        coronaGrad.addColorStop(0.7, `rgba(90, 24, 154, ${0.08 + smoothCycle * 0.12})`);
        coronaGrad.addColorStop(1, "rgba(36, 0, 70, 0)");
        ctx.fillStyle = coronaGrad;
        ctx.beginPath();
        ctx.arc(centerX, centerY, coronaR, 0, Math.PI * 2);
        ctx.fill();

        // 3. Subsurface Scattering Celestial Core Orb
        const orbR = 46 + smoothCycle * 26;
        const orbGrad = ctx.createRadialGradient(centerX - 16, centerY - 16, 4, centerX, centerY, orbR);
        orbGrad.addColorStop(0, "#FFFFFF");
        orbGrad.addColorStop(0.25, "#F3E8FF");
        orbGrad.addColorStop(0.65, "#C77DFF");
        orbGrad.addColorStop(0.9, "#7B2CBF");
        orbGrad.addColorStop(1, "#3C096C");
        ctx.fillStyle = orbGrad;
        ctx.beginPath();
        ctx.arc(centerX, centerY, orbR, 0, Math.PI * 2);
        ctx.fill();

        // Spherical glass sheen highlight
        ctx.fillStyle = `rgba(255, 255, 255, ${0.45 + (1 - smoothCycle) * 0.3})`;
        ctx.beginPath();
        ctx.ellipse(centerX - 14, centerY - 14, orbR * 0.32, orbR * 0.17, -0.42, 0, Math.PI * 2);
        ctx.fill();

        // 4. Floating Celestial Stardust Motes
        for (const m of this.breatheMotes) {
            m.x += m.vx;
            m.y += m.vy;
            if (m.x < 150) m.x = 650;
            if (m.x > 650) m.x = 150;
            if (m.y < 50) m.y = 390;
            if (m.y > 390) m.y = 50;

            const moteAlpha = (0.25 + 0.55 * Math.sin(m.phase + this.elapsed * 2.2)) * (0.6 + smoothCycle * 0.4);
            ctx.fillStyle = `rgba(224, 170, 255, ${Math.max(0, moteAlpha)})`;
            ctx.beginPath();
            ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }

    // =========================================================================
    // Helper: Viscous Liquid Surface Tension Bridge (Metaball Neck)
    // =========================================================================
    // Helper: Viscous Liquid Surface Tension Bridge (Metaball Meniscus Neck)
    // =========================================================================
    drawViscousBridge(ctx, x1, y1, r1, x2, y2, r2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const dist = Math.hypot(dx, dy);
        const maxDist = (r1 + r2) * 1.55;
        if (dist <= 0 || dist >= maxDist || dist <= Math.abs(r1 - r2) * 0.75) return;

        const angle = Math.atan2(dy, dx);
        const tension = Math.pow(Math.max(0, 1 - dist / maxDist), 1.15);
        const spread = (Math.PI * 0.44) * tension;

        const a1 = angle + spread;
        const a2 = angle - spread;
        const a3 = angle + Math.PI - spread;
        const a4 = angle + Math.PI + spread;

        const p1x = x1 + Math.cos(a1) * r1;
        const p1y = y1 + Math.sin(a1) * r1;
        const p2x = x2 + Math.cos(a3) * r2;
        const p2y = y2 + Math.sin(a3) * r2;
        const p3x = x2 + Math.cos(a4) * r2;
        const p3y = y2 + Math.sin(a4) * r2;
        const p4x = x1 + Math.cos(a2) * r1;
        const p4y = y1 + Math.sin(a2) * r1;

        const midX = (x1 + x2) * 0.5;
        const midY = (y1 + y2) * 0.5;
        const normX = -dy / dist;
        const normY = dx / dist;
        const pinch = dist * 0.26 * (1 - tension * 0.38);

        // Fluid meniscus gradient - seamlessly blends into the molten crimson/orange wax
        const bridgeGrad = ctx.createLinearGradient(x1, y1, x2, y2);
        bridgeGrad.addColorStop(0, "#D01200");
        bridgeGrad.addColorStop(0.35, "#FF5000");
        bridgeGrad.addColorStop(0.65, "#FF5000");
        bridgeGrad.addColorStop(1, "#D01200");

        ctx.fillStyle = bridgeGrad;
        ctx.beginPath();
        ctx.moveTo(p1x, p1y);
        ctx.quadraticCurveTo(midX + normX * pinch, midY + normY * pinch, p2x, p2y);
        ctx.lineTo(p3x, p3y);
        ctx.quadraticCurveTo(midX - normX * pinch, midY - normY * pinch, p4x, p4y);
        ctx.closePath();
        ctx.fill();
    }

    renderDroplet(ctx, blob) {
        if (!blob.active) return;
        const isRising = (blob.state === "RISING" || blob.state === "SEPARATING_BOTTOM");
        const isSinking = (blob.state === "SINKING" || blob.state === "SEPARATING_TOP");

        let stretchY = 1.0;
        let stretchX = 1.0;
        if (blob.state === "SEPARATING_BOTTOM") {
            stretchY = 1.28;
            stretchX = 0.82;
        } else if (blob.state === "SEPARATING_TOP") {
            stretchY = 1.28;
            stretchX = 0.82;
        } else if (isRising) {
            stretchY = 1.12;
            stretchX = 0.92;
        } else if (isSinking) {
            stretchY = 0.92;
            stretchX = 1.08;
        }

        // Viscoelastic wobble relaxation
        if (blob.wobble > 0.01) {
            const wobbleWave = Math.sin(this.elapsed * 12) * blob.wobble * 0.18;
            stretchY += wobbleWave;
            stretchX -= wobbleWave;
        }

        const rx = blob.r * stretchX;
        const ry = blob.r * stretchY;

        // Rich molten wax body gradient (Constant across entire lamp, never shifts color!)
        const waxGrad = ctx.createRadialGradient(
            blob.curX - rx * 0.25, blob.y - ry * 0.28, Math.max(1, rx * 0.08),
            blob.curX, blob.y, Math.max(rx, ry) * 1.05
        );
        waxGrad.addColorStop(0, "#FFBA00");    // molten incandescent golden core
        waxGrad.addColorStop(0.32, "#FF5000"); // fiery lava orange
        waxGrad.addColorStop(0.72, "#D01200"); // rich molten crimson body
        waxGrad.addColorStop(0.94, "#800200"); // deep ruby boundary rim
        waxGrad.addColorStop(1, "#500000");    // soft ambient edge falloff

        ctx.fillStyle = waxGrad;
        ctx.beginPath();
        ctx.ellipse(blob.curX, blob.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();

        // 3D Spherical Specular Glass / Wax Sheen Highlight
        const specGrad = ctx.createRadialGradient(
            blob.curX - rx * 0.32, blob.y - ry * 0.32, 1,
            blob.curX - rx * 0.32, blob.y - ry * 0.32, rx * 0.45
        );
        specGrad.addColorStop(0, "rgba(255, 255, 255, 0.44)");
        specGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = specGrad;
        ctx.beginPath();
        ctx.ellipse(blob.curX - rx * 0.32, blob.y - ry * 0.32, rx * 0.36, ry * 0.28, -0.25, 0, Math.PI * 2);
        ctx.fill();
    }

    checkPoolRelease(parentBlob, poolType) {
        // If parent blob absorbed another, release it in this pool with independence
        for (const child of this.lavaBlobs) {
            if (!child.active && child.mergedInto === parentBlob.id) {
                child.active = true;
                child.mergedInto = -1;
                child.r = child.baseR;
                parentBlob.r = parentBlob.baseR;
                if (poolType === "TOP") {
                    child.state = "DWELL_TOP";
                    child.dwellTimer = 2.0;
                    child.y = 100;
                } else {
                    child.state = "DWELL_BOTTOM";
                    child.dwellTimer = 2.0;
                    child.y = 352;
                }
            }
        }
    }

    // =========================================================================
    // 3. Authentic Retro Rocket Lava Lamp (Graceful Separation & Collision Merging)
    // =========================================================================
    renderLavaLamp(ctx, dt) {
        ctx.save();
        const cx = 400;

        // Subtle ambient backglow in the room
        const bgGlow = ctx.createRadialGradient(cx, 240, 10, cx, 240, 220);
        bgGlow.addColorStop(0, "rgba(255, 75, 0, 0.22)");
        bgGlow.addColorStop(0.55, "rgba(255, 35, 0, 0.07)");
        bgGlow.addColorStop(1, "rgba(255, 20, 0, 0)");
        ctx.fillStyle = bgGlow;
        ctx.beginPath();
        ctx.arc(cx, 240, 220, 0, Math.PI * 2);
        ctx.fill();

        // Helper path function for the contoured glass vessel interior
        const traceGlassProfile = () => {
            ctx.beginPath();
            ctx.moveTo(cx - 38, 88);
            ctx.bezierCurveTo(cx - 40, 135, cx - 48, 195, cx - 58, 255);
            ctx.bezierCurveTo(cx - 67, 305, cx - 68, 345, cx - 64, 368);
            ctx.lineTo(cx + 64, 368);
            ctx.bezierCurveTo(cx + 68, 345, cx + 67, 305, cx + 58, 255);
            ctx.bezierCurveTo(cx + 48, 195, cx + 40, 135, cx + 38, 88);
            ctx.closePath();
        };

        // 1. Clip EVERYTHING inside the glass vessel to guarantee zero bleed outside
        ctx.save();
        traceGlassProfile();
        ctx.clip();

        // Liquid Suspension Medium (Deep jewel-tone royal amethyst to warm ruby)
        const liquidGrad = ctx.createLinearGradient(0, 88, 0, 368);
        liquidGrad.addColorStop(0, "#16021c");
        liquidGrad.addColorStop(0.45, "#380528");
        liquidGrad.addColorStop(0.85, "#580830");
        liquidGrad.addColorStop(1, "#300318");
        ctx.fillStyle = liquidGrad;
        ctx.fill();

        // Heating Coil Radiant Bulb Glow at base
        const bulbGlow = ctx.createRadialGradient(cx, 368, 5, cx, 368, 95);
        bulbGlow.addColorStop(0, "rgba(255, 200, 70, 0.95)");
        bulbGlow.addColorStop(0.35, "rgba(255, 110, 10, 0.65)");
        bulbGlow.addColorStop(0.7, "rgba(255, 40, 0, 0.2)");
        bulbGlow.addColorStop(1, "rgba(255, 20, 0, 0)");
        ctx.fillStyle = bulbGlow;
        ctx.fill();

        // Coiled metallic spring loops at bottom of bottle
        ctx.strokeStyle = "rgba(255, 215, 140, 0.75)";
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        for (let s = -48; s <= 48; s += 8) {
            ctx.arc(cx + s, 362 + Math.sin((s + this.elapsed * 2) * 0.4) * 2.2, 3.8, 0, Math.PI * 2);
        }
        ctx.stroke();

        // 2. Physics & Fluid Lifecycle Simulation
        // Decay reservoir recoils
        this.bottomRecoil = Math.max(0, this.bottomRecoil - dt * 2.2);
        this.topRecoil = Math.max(0, this.topRecoil - dt * 2.2);

        // Update each droplet's physics & state machine
        for (const blob of this.lavaBlobs) {
            blob.wobble = Math.max(0, blob.wobble - dt * 1.2);

            // Centered convection drift (strictly within cx ± 5px)
            const maxDrift = (blob.y < 140) ? 3.8 : 5.0;
            blob.curX = cx + Math.sin(blob.phase + this.elapsed * blob.driftSpeed) * maxDrift;

            if (blob.state === "DWELL_BOTTOM") {
                blob.y = 352 + Math.sin(this.elapsed * 1.6 + blob.phase) * 1.5;
                blob.dwellTimer -= dt;
                if (blob.dwellTimer <= 0) {
                    blob.state = "SEPARATING_BOTTOM";
                    blob.vy = -12;
                }
            } else if (blob.state === "SEPARATING_BOTTOM") {
                blob.y += blob.vy * dt;
                // Graceful pinch-off at threshold
                if (blob.y <= 308) {
                    blob.state = "RISING";
                    blob.vy = -16 - Math.random() * 3;
                    blob.wobble = 0.8;
                    this.bottomRecoil = 1.0;
                }
            } else if (blob.state === "RISING") {
                blob.y += blob.vy * dt;
                // Arrival at top pool
                if (blob.y <= 135) {
                    blob.state = "MERGING_TOP";
                    blob.vy = -8;
                }
            } else if (blob.state === "MERGING_TOP") {
                blob.y += blob.vy * dt;
                if (blob.y <= 104) {
                    blob.y = 104;
                    blob.state = "DWELL_TOP";
                    blob.dwellTimer = blob.dwellTotal;
                    this.topRecoil = 1.0;
                    this.checkPoolRelease(blob, "TOP");
                }
            } else if (blob.state === "DWELL_TOP") {
                blob.y = 102 + Math.sin(this.elapsed * 1.4 + blob.phase) * 1.5;
                blob.dwellTimer -= dt;
                if (blob.dwellTimer <= 0) {
                    blob.state = "SEPARATING_TOP";
                    blob.vy = 12;
                }
            } else if (blob.state === "SEPARATING_TOP") {
                blob.y += blob.vy * dt;
                // Graceful pinch-off at threshold
                if (blob.y >= 148) {
                    blob.state = "SINKING";
                    blob.vy = 15 + Math.random() * 3;
                    blob.wobble = 0.8;
                    this.topRecoil = 1.0;
                }
            } else if (blob.state === "SINKING") {
                blob.y += blob.vy * dt;
                // Arrival at bottom pool
                if (blob.y >= 315) {
                    blob.state = "MERGING_BOTTOM";
                    blob.vy = 8;
                }
            } else if (blob.state === "MERGING_BOTTOM") {
                blob.y += blob.vy * dt;
                if (blob.y >= 348) {
                    blob.y = 348;
                    blob.state = "DWELL_BOTTOM";
                    blob.dwellTimer = blob.dwellTotal;
                    this.bottomRecoil = 1.0;
                    this.checkPoolRelease(blob, "BOTTOM");
                }
            }
        }

        // Check for collisions between active free droplets floating in the chamber
        for (let i = 0; i < this.lavaBlobs.length; i++) {
            for (let j = i + 1; j < this.lavaBlobs.length; j++) {
                const b1 = this.lavaBlobs[i];
                const b2 = this.lavaBlobs[j];
                if (!b1.active || !b2.active) continue;
                if ((b1.state !== "RISING" && b1.state !== "SINKING") ||
                    (b2.state !== "RISING" && b2.state !== "SINKING")) continue;

                const dist = Math.hypot(b1.curX - b2.curX, b1.y - b2.y);
                if (dist < (b1.r + b2.r) * 0.95) {
                    // Droplets collide! Merge smaller into larger
                    const parent = (b1.r >= b2.r) ? b1 : b2;
                    const child = (b1.r >= b2.r) ? b2 : b1;

                    child.active = false;
                    child.mergedInto = parent.id;
                    // Combined volume: R = cbrt(r1^3 + r2^3)
                    parent.r = Math.min(30, Math.cbrt(Math.pow(parent.r, 3) + Math.pow(child.r, 3)));
                    parent.wobble = 1.0;
                    parent.mergedTimer = 6.0;
                    // Momentum transfer
                    parent.vy = (parent.vy * 0.6) + (child.vy * 0.4);
                    if (Math.abs(parent.vy) < 6) parent.vy = parent.state === "RISING" ? -12 : 12;
                }
            }
        }

        // If a merged blob stays in column, cleave back into two droplets
        for (const parent of this.lavaBlobs) {
            if (parent.active && parent.r > parent.baseR * 1.1) {
                parent.mergedTimer -= dt;
                if (parent.mergedTimer <= 0 && (parent.state === "RISING" || parent.state === "SINKING")) {
                    for (const child of this.lavaBlobs) {
                        if (!child.active && child.mergedInto === parent.id) {
                            child.active = true;
                            child.mergedInto = -1;
                            child.r = child.baseR;
                            parent.r = parent.baseR;
                            child.curX = parent.curX;
                            child.y = parent.y + (parent.state === "RISING" ? 18 : -18);
                            child.state = parent.state === "RISING" ? "SINKING" : "RISING";
                            child.vy = parent.state === "RISING" ? 14 : -14;
                            parent.wobble = 0.9;
                            child.wobble = 0.9;
                            break;
                        }
                    }
                }
            }
        }

        // 3. Render Top Cooling Wax Pool (Meniscus reservoir with dynamic recoil)
        const topRecoilOffset = Math.sin(this.elapsed * 8) * this.topRecoil * 3.5;
        const topPoolH = 16 + Math.sin(this.elapsed * 1.2) * 2.0 + topRecoilOffset;
        const topWaxGrad = ctx.createLinearGradient(0, 88, 0, 88 + topPoolH);
        topWaxGrad.addColorStop(0, "#600000");
        topWaxGrad.addColorStop(0.3, "#B01000");
        topWaxGrad.addColorStop(0.75, "#FF5000");
        topWaxGrad.addColorStop(1, "#FF9E00");
        ctx.fillStyle = topWaxGrad;
        ctx.beginPath();
        ctx.moveTo(cx - 38, 88);
        ctx.bezierCurveTo(cx - 28, 88 + topPoolH * 1.2, cx + 28, 88 + topPoolH * 1.2, cx + 38, 88);
        ctx.closePath();
        ctx.fill();

        // 4. Render Bottom Heated Molten Reservoir (Molten dome over coil with dynamic recoil)
        const botRecoilOffset = Math.sin(this.elapsed * 8) * this.bottomRecoil * 4.0;
        const baseMoundH = 30 + Math.sin(this.elapsed * 1.4) * 2.5 + botRecoilOffset;
        const baseWaxGrad = ctx.createRadialGradient(
            cx, 368, 6,
            cx, 368 - baseMoundH * 0.4, baseMoundH * 1.4
        );
        baseWaxGrad.addColorStop(0, "#FFC020");   // bright molten gold directly above coil
        baseWaxGrad.addColorStop(0.35, "#FF5000"); // fiery orange
        baseWaxGrad.addColorStop(0.75, "#D01200"); // molten crimson
        baseWaxGrad.addColorStop(1, "#750000");   // deep ruby
        ctx.fillStyle = baseWaxGrad;
        ctx.beginPath();
        ctx.moveTo(cx - 64, 368);
        ctx.bezierCurveTo(cx - 48, 368 - baseMoundH * 1.3, cx + 48, 368 - baseMoundH * 1.3, cx + 64, 368);
        ctx.closePath();
        ctx.fill();

        // 5. Draw Viscous Meniscus Bridges (Metaball Merging and Detaching)
        // A. Viscous neck to bottom pool (graceful separation when rising, smooth merging when sinking)
        for (const blob of this.lavaBlobs) {
            if (blob.active && (blob.state === "SEPARATING_BOTTOM" || blob.state === "MERGING_BOTTOM" || blob.y > 275)) {
                this.drawViscousBridge(ctx, blob.curX, blob.y, blob.r, cx, 368 - baseMoundH * 0.5, 48);
            }
        }

        // B. Viscous neck to top pool (smooth merging on arrival, graceful separation on departure)
        for (const blob of this.lavaBlobs) {
            if (blob.active && (blob.state === "SEPARATING_TOP" || blob.state === "MERGING_TOP" || blob.y < 165)) {
                this.drawViscousBridge(ctx, blob.curX, blob.y, blob.r, cx, 88 + topPoolH * 0.5, 34);
            }
        }

        // C. Viscous neck when droplets pass or are in close proximity in the column
        for (let i = 0; i < this.lavaBlobs.length; i++) {
            for (let j = i + 1; j < this.lavaBlobs.length; j++) {
                const b1 = this.lavaBlobs[i];
                const b2 = this.lavaBlobs[j];
                if (b1.active && b2.active) {
                    this.drawViscousBridge(ctx, b1.curX, b1.y, b1.r, b2.curX, b2.y, b2.r);
                }
            }
        }

        // 6. Render Individual Droplets with constant wax gradient & 3D specular sheen
        for (const blob of this.lavaBlobs) {
            this.renderDroplet(ctx, blob);
        }

        ctx.restore(); // remove clip

        // 3. Glass Highlights & Outer Vessel Reflections
        traceGlassProfile();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
        ctx.lineWidth = 1.6;
        ctx.stroke();

        // Primary curved specular glass highlight on left flank
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx - 34, 105);
        ctx.bezierCurveTo(cx - 36, 160, cx - 44, 240, cx - 56, 335);
        ctx.bezierCurveTo(cx - 58, 350, cx - 57, 360, cx - 52, 365);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.48)";
        ctx.lineWidth = 3.4;
        ctx.lineCap = "round";
        ctx.stroke();

        // Secondary subtle specular highlight on right flank
        ctx.beginPath();
        ctx.moveTo(cx + 34, 115);
        ctx.bezierCurveTo(cx + 36, 170, cx + 46, 250, cx + 58, 345);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
        ctx.lineWidth = 1.6;
        ctx.lineCap = "round";
        ctx.stroke();
        ctx.restore();

        // 4. Vintage Brushed Aluminum Top Cap & Flared Pedestal Base
        // Top Cap (Classic pointed cone)
        const capGrad = ctx.createLinearGradient(cx - 40, 0, cx + 40, 0);
        capGrad.addColorStop(0, "#282933");
        capGrad.addColorStop(0.28, "#5E6175");
        capGrad.addColorStop(0.5, "#9EA3BD");
        capGrad.addColorStop(0.72, "#4B4D5E");
        capGrad.addColorStop(1, "#21222A");
        ctx.fillStyle = capGrad;
        ctx.beginPath();
        ctx.moveTo(cx - 14, 44);
        ctx.bezierCurveTo(cx - 4, 38, cx + 4, 38, cx + 14, 44);
        ctx.lineTo(cx + 39, 88);
        ctx.lineTo(cx - 39, 88);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Bottom Pedestal Base (Classic trumpet flare)
        const baseGrad = ctx.createLinearGradient(cx - 90, 0, cx + 90, 0);
        baseGrad.addColorStop(0, "#202129");
        baseGrad.addColorStop(0.26, "#525567");
        baseGrad.addColorStop(0.5, "#9297B0");
        baseGrad.addColorStop(0.74, "#424453");
        baseGrad.addColorStop(1, "#181920");
        ctx.fillStyle = baseGrad;
        ctx.beginPath();
        ctx.moveTo(cx - 66, 368);
        ctx.lineTo(cx + 66, 368);
        ctx.bezierCurveTo(cx + 64, 388, cx + 58, 396, cx + 64, 412);
        ctx.bezierCurveTo(cx + 74, 432, cx + 86, 442, cx + 90, 446);
        ctx.lineTo(cx - 90, 446);
        ctx.bezierCurveTo(cx - 86, 442, cx - 74, 432, cx - 64, 412);
        ctx.bezierCurveTo(cx - 58, 396, cx - 64, 388, cx - 66, 368);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
        ctx.stroke();

        // Pedestal base ventilation louvers
        ctx.fillStyle = "#0d0e14";
        for (let s = -32; s <= 32; s += 16) {
            ctx.fillRect(cx + s - 5, 420, 10, 3.5);
        }

        // Tabletop ambient glow puddle
        const tableGlow = ctx.createRadialGradient(cx, 448, 10, cx, 448, 140);
        tableGlow.addColorStop(0, "rgba(255, 100, 20, 0.32)");
        tableGlow.addColorStop(0.6, "rgba(255, 60, 0, 0.1)");
        tableGlow.addColorStop(1, "rgba(255, 30, 0, 0)");
        ctx.fillStyle = tableGlow;
        ctx.fillRect(cx - 150, 446, 300, 28);

        ctx.restore();
    }

    // =========================================================================
    // 4. Realistic Thunderstorm Rain Simulation (Branched Lightning & Pacing)
    // =========================================================================
    renderRain(ctx, dt) {
        ctx.save();

        // 1. Thunderstorm Lightning Engine (Authentic 14-22s intervals, multi-pulse physics)
        if (this.elapsed >= this.nextLightningTime && !this.lightningActive) {
            this.lightningActive = true;
            this.lightningStartTime = this.elapsed;
            // Next strike naturally spaced by 14-22 seconds
            this.nextLightningTime = this.elapsed + 14.0 + Math.random() * 8.0;
            const boltStartX = 220 + Math.random() * 360;
            const boltEndX = boltStartX + (Math.random() - 0.5) * 140;
            this.lightningBolt = this.createLightningBolt(boltStartX, 15, boltEndX, 415);
        }

        let flash = 0;
        if (this.lightningActive) {
            const timeSince = this.elapsed - this.lightningStartTime;
            if (timeSince < 0.44) {
                if (timeSince < 0.05) {
                    // Stepped leader (initial ionizing flash)
                    flash = (timeSince / 0.05) * 0.32;
                } else if (timeSince < 0.09) {
                    // Inter-stroke dark pause
                    flash = 0.06;
                } else if (timeSince < 0.21) {
                    // Primary return stroke (instantaneous blinding discharge)
                    const t = (timeSince - 0.09) / 0.12;
                    flash = 0.95 * Math.exp(-t * 2.8);
                } else if (timeSince < 0.28) {
                    // Secondary return stroke (re-strike)
                    const t = (timeSince - 0.21) / 0.07;
                    flash = 0.58 * Math.sin(t * Math.PI);
                } else {
                    // Cloud diffusion & rumble roll-off
                    const t = (timeSince - 0.28) / 0.16;
                    flash = 0.22 * (1 - t) * (1 - t);
                }
            } else {
                this.lightningActive = false;
                this.lightningBolt = null;
            }
        }

        // Draw lightning sky flash, storm clouds, and branched bolt
        if (flash > 0) {
            // Ambient sky illumination
            ctx.fillStyle = `rgba(215, 238, 255, ${flash * 0.36})`;
            ctx.fillRect(0, 0, 800, 480);

            // Backlit thundercloud silhouettes at top
            ctx.save();
            const cloudGrad = ctx.createLinearGradient(0, 0, 0, 110);
            cloudGrad.addColorStop(0, `rgba(180, 210, 240, ${flash * 0.55})`);
            cloudGrad.addColorStop(0.7, `rgba(120, 150, 180, ${flash * 0.3})`);
            cloudGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
            ctx.fillStyle = cloudGrad;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(800, 0);
            ctx.lineTo(800, 50);
            ctx.bezierCurveTo(720, 85, 620, 45, 520, 75);
            ctx.bezierCurveTo(420, 105, 320, 60, 220, 80);
            ctx.bezierCurveTo(120, 100, 50, 65, 0, 75);
            ctx.closePath();
            ctx.fill();
            ctx.restore();

            // Branched forked lightning bolt (during active return strokes)
            if (this.lightningBolt && flash > 0.22) {
                ctx.save();
                // Atmospheric electric cyan glow
                ctx.strokeStyle = `rgba(140, 215, 255, ${flash * 0.45})`;
                ctx.lineWidth = 14;
                ctx.lineCap = "round";
                ctx.lineJoin = "bevel";
                ctx.beginPath();
                for (const seg of this.lightningBolt) {
                    ctx.moveTo(seg.x1, seg.y1);
                    ctx.lineTo(seg.x2, seg.y2);
                }
                ctx.stroke();

                // Luminous ionization channel
                ctx.strokeStyle = `rgba(210, 245, 255, ${flash * 0.85})`;
                ctx.lineWidth = 4.5;
                ctx.stroke();

                // Blinding white filament core
                ctx.strokeStyle = `rgba(255, 255, 255, ${flash})`;
                ctx.lineWidth = 1.8;
                ctx.stroke();
                ctx.restore();
            }
        }

        // 2. Natural Randomized Raindrops
        for (const drop of this.raindrops) {
            drop.x += drop.vx * dt * 60;
            drop.y += drop.vy * dt * 60;

            // When raindrop hits the ground/water horizon
            if (drop.y >= 430) {
                // Impact water ripple
                if (this.ripples.length < 35 && Math.random() < 0.6) {
                    this.ripples.push({
                        x: drop.x,
                        y: 430 + (1 - drop.z) * 20,
                        r: 2,
                        maxR: (16 + Math.random() * 16) * drop.z,
                        alpha: 0.75 * drop.z
                    });
                }

                // Upward micro-splashes
                if (this.splashes.length < 50 && drop.z > 0.5) {
                    for (let s = 0; s < 2; s++) {
                        this.splashes.push({
                            x: drop.x,
                            y: 430,
                            vx: (Math.random() - 0.5) * 2.8,
                            vy: -Math.random() * 3.2 - 1.2,
                            r: Math.random() * 1.2 + 0.6,
                            life: 0.25,
                            alpha: drop.alpha
                        });
                    }
                }

                // Reset drop to top with randomized position
                drop.x = Math.random() * 960 - 80;
                drop.y = -Math.random() * 50 - 10;
            }

            // Draw raindrop motion streak
            const tailX = drop.x - drop.vx * (drop.length / drop.vy);
            const tailY = drop.y - drop.length;

            const streakGrad = ctx.createLinearGradient(tailX, tailY, drop.x, drop.y);
            const boost = flash > 0 ? 0.35 : 0;
            streakGrad.addColorStop(0, "rgba(200, 230, 255, 0)");
            streakGrad.addColorStop(0.7, `rgba(215, 238, 255, ${(drop.alpha + boost) * 0.45})`);
            streakGrad.addColorStop(1, `rgba(255, 255, 255, ${Math.min(1, drop.alpha + boost)})`);

            ctx.strokeStyle = streakGrad;
            ctx.lineWidth = drop.thickness;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(tailX, tailY);
            ctx.lineTo(drop.x, drop.y);
            ctx.stroke();
        }

        // 3. Ground Water Horizon Sheen
        const horizonGrad = ctx.createLinearGradient(0, 425, 0, 480);
        horizonGrad.addColorStop(0, flash > 0 ? `rgba(180, 220, 250, ${0.4 + flash * 0.4})` : "rgba(36, 52, 66, 0.4)");
        horizonGrad.addColorStop(1, "rgba(16, 24, 32, 0.7)");
        ctx.fillStyle = horizonGrad;
        ctx.fillRect(0, 425, 800, 55);

        ctx.strokeStyle = flash > 0 ? "rgba(230, 245, 255, 0.8)" : "rgba(186, 230, 253, 0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, 426);
        ctx.lineTo(800, 426);
        ctx.stroke();

        // 4. Expanding Water Surface Ripples
        for (let i = this.ripples.length - 1; i >= 0; i--) {
            const rip = this.ripples[i];
            rip.r += 32 * dt;
            rip.alpha -= 1.6 * dt;

            if (rip.alpha <= 0 || rip.r >= rip.maxR) {
                this.ripples.splice(i, 1);
                continue;
            }

            const ripAlpha = Math.max(0, rip.alpha);
            ctx.strokeStyle = `rgba(186, 230, 253, ${flash > 0 ? Math.min(1, ripAlpha * 1.6) : ripAlpha})`;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.ellipse(rip.x, rip.y, rip.r, rip.r * 0.32, 0, 0, Math.PI * 2);
            ctx.stroke();
        }

        // 5. Upward Bouncing Micro-Splashes
        for (let i = this.splashes.length - 1; i >= 0; i--) {
            const sp = this.splashes[i];
            sp.x += sp.vx * dt * 60;
            sp.y += sp.vy * dt * 60;
            sp.vy += 14 * dt;
            sp.life -= dt;

            if (sp.life <= 0 || sp.y > 440) {
                this.splashes.splice(i, 1);
                continue;
            }

            ctx.fillStyle = `rgba(224, 242, 254, ${sp.alpha * (sp.life / 0.25)})`;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, sp.r, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }

    // =========================================================================
    // 5. Realistic Aurora Borealis Simulation (Silky Undulating Curtains & Fjord)
    // =========================================================================
    renderAurora(ctx, dt) {
        ctx.save();

        // 1. Arctic Night Starry Canopy & Cosmic Dust
        const dustGrad = ctx.createLinearGradient(0, 0, 800, 240);
        dustGrad.addColorStop(0, "rgba(40, 20, 70, 0.15)");
        dustGrad.addColorStop(0.5, "rgba(10, 50, 70, 0.18)");
        dustGrad.addColorStop(1, "rgba(30, 15, 60, 0.1)");
        ctx.fillStyle = dustGrad;
        ctx.fillRect(0, 0, 800, 260);

        for (const s of this.auroraStars) {
            const twinkle = 0.4 + 0.6 * Math.sin(s.phase + this.elapsed * s.speed);
            ctx.fillStyle = `rgba(255, 255, 255, ${s.alpha * twinkle})`;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fill();
        }

        // 2. Continuous Silky Northern Lights Curtains (Additive Screen Blending)
        ctx.globalCompositeOperation = "screen";

        // Curtain 1: Vibrant Emerald Green (Atomic oxygen 557.7nm emission)
        this.drawContinuousAuroraCurtain(ctx, {
            baseY: 205,
            height: 135,
            k1: 0.006,
            k2: 0.014,
            k3: 0.003,
            s1: 0.55,
            s2: -0.35,
            s3: 0.2,
            a1: 38,
            a2: 18,
            a3: 24,
            alpha: 0.8,
            colorR: 0,
            colorG: 255,
            colorB: 136
        });

        // Curtain 2: Electric Cyan-Teal Mid-Layer
        this.drawContinuousAuroraCurtain(ctx, {
            baseY: 185,
            height: 120,
            k1: 0.008,
            k2: 0.017,
            k3: 0.004,
            s1: -0.45,
            s2: 0.38,
            s3: -0.25,
            a1: 32,
            a2: 16,
            a3: 20,
            alpha: 0.7,
            colorR: 0,
            colorG: 235,
            colorB: 255
        });

        // Curtain 3: Royal Violet & Magenta High-Altitude Corona
        this.drawContinuousAuroraCurtain(ctx, {
            baseY: 165,
            height: 110,
            k1: 0.005,
            k2: 0.011,
            k3: 0.002,
            s1: 0.3,
            s2: -0.25,
            s3: 0.15,
            a1: 44,
            a2: 20,
            a3: 28,
            alpha: 0.6,
            colorR: 168,
            colorG: 70,
            colorB: 255
        });

        ctx.globalCompositeOperation = "source-over";

        // 3. Arctic Mountain Horizon Silhouette
        ctx.fillStyle = "#06070d";
        ctx.beginPath();
        ctx.moveTo(0, 480);
        ctx.lineTo(0, 418);
        ctx.lineTo(55, 392);
        ctx.lineTo(125, 412);
        ctx.lineTo(205, 382);
        ctx.lineTo(285, 408);
        ctx.lineTo(385, 376);
        ctx.lineTo(475, 410);
        ctx.lineTo(575, 372);
        ctx.lineTo(665, 402);
        ctx.lineTo(735, 382);
        ctx.lineTo(800, 412);
        ctx.lineTo(800, 480);
        ctx.closePath();
        ctx.fill();

        // Craggy mountain snow ridges catching soft auroral glow
        ctx.strokeStyle = "rgba(0, 255, 136, 0.15)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(180, 405);
        ctx.lineTo(205, 382);
        ctx.lineTo(225, 400);
        ctx.moveTo(360, 402);
        ctx.lineTo(385, 376);
        ctx.lineTo(410, 398);
        ctx.moveTo(550, 396);
        ctx.lineTo(575, 372);
        ctx.lineTo(600, 395);
        ctx.stroke();

        // 4. Calm Fjord Water Reflection with Undulating Ripples
        const waterGlow = ctx.createLinearGradient(0, 420, 0, 480);
        waterGlow.addColorStop(0, "rgba(0, 255, 136, 0.24)");
        waterGlow.addColorStop(0.4, "rgba(0, 229, 255, 0.18)");
        waterGlow.addColorStop(0.8, "rgba(124, 77, 255, 0.12)");
        waterGlow.addColorStop(1, "rgba(4, 6, 12, 0.85)");
        ctx.fillStyle = waterGlow;
        ctx.fillRect(0, 420, 800, 60);

        // Water horizontal ripple shimmer
        ctx.lineWidth = 1;
        for (let wy = 426; wy < 475; wy += 5) {
            const waveOffset = Math.sin(wy * 0.28 + this.elapsed * 2.5) * 8;
            const ripAlpha = (0.15 + 0.12 * Math.sin(wy * 0.4 + this.elapsed * 3)) * (1 - (wy - 420) / 60);
            ctx.strokeStyle = `rgba(180, 255, 230, ${Math.max(0, ripAlpha)})`;
            ctx.beginPath();
            ctx.moveTo(50 + waveOffset, wy);
            ctx.lineTo(750 + waveOffset, wy);
            ctx.stroke();
        }

        ctx.restore();
    }

    drawContinuousAuroraCurtain(ctx, opt) {
        const step = 3;
        for (let x = -20; x <= 820; x += step) {
            const waveY = opt.baseY + 
                Math.sin(x * opt.k1 + this.elapsed * opt.s1) * opt.a1 +
                Math.sin(x * opt.k2 + this.elapsed * opt.s2) * opt.a2 +
                Math.cos(x * opt.k3 + this.elapsed * opt.s3) * opt.a3;

            // Optical line-of-sight fold amplification
            const slope = (Math.sin((x + 6) * opt.k1 + this.elapsed * opt.s1) * opt.a1 - 
                           Math.sin((x - 6) * opt.k1 + this.elapsed * opt.s1) * opt.a1) / 12;
            const foldFactor = 1.0 + 1.35 * Math.min(1.2, slope * slope * 2.8);

            // Shimmering vertical ray striations
            const ray = 0.68 + 0.32 * Math.sin(x * 0.075 + this.elapsed * 1.8) * Math.cos(x * 0.035 - this.elapsed * 0.85);
            const colAlpha = opt.alpha * foldFactor * ray;
            const curtainH = opt.height * (0.82 + 0.18 * Math.sin(x * 0.025 + this.elapsed * 0.65));

            const rayGrad = ctx.createLinearGradient(x, waveY + 8, x, waveY - curtainH);
            rayGrad.addColorStop(0, `rgba(${opt.colorR}, ${opt.colorG}, ${opt.colorB}, 0)`);
            rayGrad.addColorStop(0.12, `rgba(${opt.colorR}, ${opt.colorG}, ${opt.colorB}, ${Math.min(1, colAlpha * 0.95)})`);
            rayGrad.addColorStop(0.48, `rgba(${opt.colorR}, ${opt.colorG}, ${opt.colorB}, ${colAlpha * 0.55})`);
            rayGrad.addColorStop(0.82, `rgba(180, 100, 255, ${colAlpha * 0.35})`);
            rayGrad.addColorStop(1, "rgba(160, 60, 255, 0)");

            ctx.fillStyle = rayGrad;
            // 4.2px width with 3px step ensures continuous, silky smooth curtain coverage without any bar lines
            ctx.fillRect(x, waveY - curtainH, 4.2, curtainH + 8);
        }
    }
}

let ambientCanvasEngine = null;

function getAmbientCanvasEngine() {
    if (!ambientCanvasEngine) {
        ambientCanvasEngine = new AmbientCanvasRenderer("ambientCanvas");
    }
    return ambientCanvasEngine;
}

let lavaSvgAnimId = null;
let lavaSvgStartTime = 0;

function startLavaSvgAnimation() {
    stopLavaSvgAnimation();
    const svg = document.getElementById("ambientLavaSvg");
    if (!svg) return;
    svg.style.display = "block";

    // Replicate Luke Smetham's TimelineMax lava lamp logic with yoyo, repeatDelay, timeScale(2), and seek(120)
    // 5 blobs moving along y: 260 with organic random durations
    const blobConfigs = [
        { id: "blob0", duration: 16.0, delay: 1.2, offset: 5.0 },
        { id: "blob1", duration: 22.0, delay: 1.8, offset: 16.0 },
        { id: "blob2", duration: 30.0, delay: 1.0, offset: 27.5 },
        { id: "blob3", duration: 19.0, delay: 1.5, offset: 10.0 },
        { id: "blob4", duration: 34.0, delay: 1.0, offset: 21.0 }
    ];

    const elements = blobConfigs.map(c => ({
        el: document.getElementById(c.id),
        duration: c.duration,
        delay: c.delay,
        offset: c.offset,
        period: 2 * (c.duration + c.delay),
        range: 260
    }));

    lavaSvgStartTime = performance.now();

    const loop = (now) => {
        // Luke Smetham's timeScale(2) for realistic molten tempo
        const speed = 1.85;
        const elapsed = ((now - lavaSvgStartTime) / 1000) * speed + 120;

        // Smooth sinusoidal easing for organic wax buoyancy acceleration and deceleration
        const ease = (p) => 0.5 - 0.5 * Math.cos(p * Math.PI);

        for (const b of elements) {
            if (!b.el) continue;
            const t = (elapsed + b.offset) % b.period;
            let y = 0;

            if (t < b.duration) {
                // Smoothly floating down and detaching from top
                y = b.range * ease(t / b.duration);
            } else if (t < b.duration + b.delay) {
                // Dwell and merge at warm base pool
                y = b.range;
            } else if (t < 2 * b.duration + b.delay) {
                // Smoothly rising up toward the cool cap (yoyo)
                const prog = (t - (b.duration + b.delay)) / b.duration;
                y = b.range * (1 - ease(prog));
            } else {
                // Dwell and cool at top cap
                y = 0;
            }

            b.el.setAttribute("transform", `translate(0, ${y.toFixed(2)})`);
        }

        lavaSvgAnimId = requestAnimationFrame(loop);
    };

    lavaSvgAnimId = requestAnimationFrame(loop);
}

function stopLavaSvgAnimation() {
    if (lavaSvgAnimId) {
        cancelAnimationFrame(lavaSvgAnimId);
        lavaSvgAnimId = null;
    }
    const svg = document.getElementById("ambientLavaSvg");
    if (svg) svg.style.display = "none";
}

function selectAmbientMode(code) {
    selectedAmbientModeCode = code;

    // Update active tile in grid
    const tiles = document.querySelectorAll(".ambient-mode-tile");
    tiles.forEach(tile => {
        const isCurrent = tile.id.toLowerCase().includes(code.toLowerCase()) || 
                          (code === "SOLID" && tile.id === "ambientTileSolid");
        tile.classList.toggle("active", isCurrent);
    });

    const pickerContainer = document.getElementById("ambientColorPickerContainer");
    const descContainer = document.getElementById("ambientModeDescContainer");
    const descText = document.getElementById("ambientModeDesc");
    const canvas = document.getElementById("ambientCanvas");
    const engine = getAmbientCanvasEngine();

    if (code === "SOLID") {
        if (engine) engine.stop();
        stopLavaSvgAnimation();
        if (descContainer) descContainer.style.display = "none";
        if (pickerContainer) pickerContainer.style.display = "flex";

        // Retrieve last saved solid color or fallback
        const lastSolid = localStorage.getItem("ll_ambient_solid_" + myDeviceId) ||
                          (mySettings.ambientColor && mySettings.ambientColor.startsWith("#") ? mySettings.ambientColor : "#FFAA00");

        if (!ambientColorPicker) {
            ambientColorPicker = new iro.ColorPicker("#ambientIroWheelMount", {
                width: 220,
                color: lastSolid,
                borderWidth: 1,
                borderColor: "#fff",
                layout: [
                    { component: iro.ui.Wheel, options: {} },
                    { component: iro.ui.Slider, options: { sliderType: "value" } }
                ]
            });
        } else {
            ambientColorPicker.color.hexString = lastSolid;
        }
    } else {
        if (pickerContainer) pickerContainer.style.display = "none";
        if (descContainer) descContainer.style.display = "flex";
        if (descText && AMBIENT_MODES[code]) {
            descText.textContent = AMBIENT_MODES[code].desc;
        }

        if (code === "LAVA") {
            if (engine) engine.stop();
            if (canvas) canvas.style.display = "none";
            startLavaSvgAnimation();
        } else {
            stopLavaSvgAnimation();
            if (canvas) canvas.style.display = "block";
            if (engine) engine.start(code);
        }
    }
}

function openAmbientSettingsModal() {
    ambientColorBeforeEdit = mySettings.ambientColor;
    const modal = document.getElementById("ambientSettingsModal");
    if (modal) modal.style.display = "block";

    const currentCode = getAmbientModeCode(mySettings.ambientColor);
    selectAmbientMode(currentCode);
}

function closeAmbientSettingsModal() {
    if (ambientColorBeforeEdit !== null) {
        mySettings.ambientColor = ambientColorBeforeEdit;
    }
    const engine = getAmbientCanvasEngine();
    if (engine) engine.stop();
    stopLavaSvgAnimation();

    const modal = document.getElementById("ambientSettingsModal");
    if (modal) modal.style.display = "none";
}

function saveAmbientSettings() {
    if (selectedAmbientModeCode === "SOLID") {
        const chosenHex = ambientColorPicker ? ambientColorPicker.color.hexString.toUpperCase() : "#FFAA00";
        mySettings.ambientColor = chosenHex;
        localStorage.setItem("ll_ambient_solid_" + myDeviceId, chosenHex);
    } else {
        mySettings.ambientColor = selectedAmbientModeCode;
    }

    ambientColorBeforeEdit = null;
    updateAmbientPill();
    publishSettings();

    const engine = getAmbientCanvasEngine();
    if (engine) engine.stop();
    stopLavaSvgAnimation();

    const modal = document.getElementById("ambientSettingsModal");
    if (modal) modal.style.display = "none";
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

    // Align clock hand rotations to selected timeline segments
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

    // Map angular rotation degrees to minute increments
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

    // Scale current progress value as a fraction
    let fraction = tpTempDuration / maxVal;

    // Compute visual arc boundaries
    const circumference = 2 * Math.PI * radius;
    // Modulate circle stroke offsets to represent filled arc
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

    // Align circular dial progress handle position
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

    // Detect and map user local timezone on first startup
    if (!mySettings.timezone) {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        // Map standard IANA timezone keys to POSIX equivalents
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
// Dashboard View Toggle & Connections Management
// ==========================================================================
const HARDCODED_CONNECTIONS = [
    {
        id: "bonfire",
        name: "Virtual Bonfire",
        color: "#ff5722",
        icon: "local_fire_department",
        action: () => triggerBonfireConnection()
    }
];

let currentDashboardSignalsMode = 'signals';

function setDashboardSignalsMode(mode) {
    currentDashboardSignalsMode = mode;
    const presetsGrid = document.getElementById("presetsGrid");
    const connectionsGrid = document.getElementById("connectionsGrid");
    const pillBtnSignals = document.getElementById("btnPillSignals");
    const pillBtnConnections = document.getElementById("btnPillConnections");
    const sectionTitle = document.getElementById("signalsSectionTitle");

    if (mode === 'connections') {
        if (presetsGrid) presetsGrid.style.display = "none";
        if (connectionsGrid) {
            connectionsGrid.style.display = "grid";
            renderConnections();
        }
        if (pillBtnSignals) {
            pillBtnSignals.classList.remove("active");
            pillBtnSignals.setAttribute("aria-selected", "false");
        }
        if (pillBtnConnections) {
            pillBtnConnections.classList.add("active");
            pillBtnConnections.setAttribute("aria-selected", "true");
        }
        if (sectionTitle) {
            sectionTitle.innerText = "Connections";
        }
    } else {
        if (connectionsGrid) connectionsGrid.style.display = "none";
        if (presetsGrid) presetsGrid.style.display = "grid";
        if (pillBtnSignals) {
            pillBtnSignals.classList.add("active");
            pillBtnSignals.setAttribute("aria-selected", "true");
        }
        if (pillBtnConnections) {
            pillBtnConnections.classList.remove("active");
            pillBtnConnections.setAttribute("aria-selected", "false");
        }
        if (sectionTitle) {
            sectionTitle.innerText = "Quick Signals";
        }
    }
}

function renderConnections() {
    const grid = document.getElementById("connectionsGrid");
    if (!grid) return;
    grid.innerHTML = "";

    HARDCODED_CONNECTIONS.forEach(conn => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "preset-btn connection-btn";
        btn.style.setProperty("--preset-color", conn.color);
        btn.dataset.id = conn.id;

        const nameSpan = document.createElement("span");
        nameSpan.className = "preset-name";
        nameSpan.innerText = conn.name;
        btn.appendChild(nameSpan);

        if (conn.icon) {
            const iconSpan = document.createElement("span");
            iconSpan.className = "material-icons-round connection-icon";
            iconSpan.innerText = conn.icon;
            btn.appendChild(iconSpan);
        }

        btn.onclick = () => {
            btn.style.transform = "scale(0.93)";
            setTimeout(() => { btn.style.transform = ""; }, 200);
            if (typeof conn.action === 'function') {
                conn.action();
            }
        };

        grid.appendChild(btn);
    });
}

// ==========================================================================
// Preset Management
// ==========================================================================
function renderPresets() {
    const grid = document.getElementById("presetsGrid");
    grid.innerHTML = "";

    let touchTimer = null;
    let isTouchDragging = false;
    let dragEl = null;

    presets.forEach((p, idx) => {
        const btn = document.createElement("button");
        btn.className = "preset-btn";
        btn.draggable = true;
        btn.dataset.id = p.id;
        btn.dataset.index = idx;

        const isCycle = p.type === 'cycle' && p.colors && p.colors.length > 0;
        btn.style.setProperty("--preset-color", isCycle ? p.colors[0].hex : p.color);

        const nameSpan = document.createElement("span");
        nameSpan.className = "preset-name";
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

        // Tap edit icon = edit
        editIcon.onclick = (e) => { e.stopPropagation(); openPresetModal(p.id); };

        // Tap the button area = send signal
        btn.onclick = () => {
            if (isTouchDragging) return; // Prevent tap while dragging
            if (isCycle) {
                sendSignal(p); // Pass full preset object for cycle encoding
            } else {
                sendSignal(p.color);
            }
            // Visual feedback on the preset button itself
            btn.style.transform = "scale(0.93)";
            setTimeout(() => { btn.style.transform = ""; }, 200);
        };

        // Desktop Drag and Drop reordering
        btn.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", p.id);
            btn.classList.add("dragging");
            dragEl = btn;
        });

        btn.addEventListener("dragend", () => {
            btn.classList.remove("dragging");
            dragEl = null;
        });

        btn.addEventListener("dragover", (e) => {
            e.preventDefault();
            const draggingBtn = grid.querySelector(".dragging");
            if (!draggingBtn) return;
            const siblings = [...grid.querySelectorAll(".preset-btn:not(.dragging):not(.add-new)")];
            let nextSibling = siblings.find(sibling => {
                const box = sibling.getBoundingClientRect();
                return e.clientX < box.left + box.width / 2 && e.clientY < box.bottom;
            });
            const addBtn = grid.querySelector(".add-new");
            grid.insertBefore(draggingBtn, nextSibling || addBtn);
        });

        btn.addEventListener("drop", (e) => {
            e.preventDefault();
            saveNewPresetsOrder();
        });

        // Mobile Touch long press to drag reordering
        btn.addEventListener("touchstart", (e) => {
            touchTimer = setTimeout(() => {
                isTouchDragging = true;
                btn.classList.add("dragging");
                if (navigator.vibrate) navigator.vibrate(50);
            }, 300); // 300ms hold to drag
        }, { passive: true });

        btn.addEventListener("touchmove", (e) => {
            if (!isTouchDragging) {
                clearTimeout(touchTimer);
                return;
            }
            e.preventDefault(); // Prevent scrolling
            const touch = e.touches[0];
            const siblings = [...grid.querySelectorAll(".preset-btn:not(.dragging):not(.add-new)")];
            let nextSibling = siblings.find(sibling => {
                const box = sibling.getBoundingClientRect();
                return touch.clientX < box.left + box.width / 2 && touch.clientY < box.bottom;
            });
            const addBtn = grid.querySelector(".add-new");
            grid.insertBefore(btn, nextSibling || addBtn);
        }, { passive: false });

        btn.addEventListener("touchend", () => {
            clearTimeout(touchTimer);
            if (isTouchDragging) {
                btn.classList.remove("dragging");
                // Reset dragging state after a tiny delay so the click event doesn't fire
                setTimeout(() => { isTouchDragging = false; }, 50);
                saveNewPresetsOrder();
            }
        });

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
        presetColorPicker.color.hexString = mySettings.defaultColor || "#ffffff";
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

    const activeUid = localStorage.getItem("ll_uid");
    if (activeUid) localStorage.setItem("ll_presets_" + activeUid, JSON.stringify(presets));
    localStorage.setItem("ll_presets_" + myDeviceId, JSON.stringify(presets));
    publishPresets();
    renderPresets();
    closePresetModal();
}

function deleteCurrentPreset() {
    if (!confirm("Delete this signal preset?")) return;
    presets = presets.filter(x => x.id !== editingPresetId);
    const activeUid = localStorage.getItem("ll_uid");
    if (activeUid) localStorage.setItem("ll_presets_" + activeUid, JSON.stringify(presets));
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
let touchDragColorEl = null;

function renderCycleColorEntries() {
    const list = document.getElementById("colorEntryList");
    list.innerHTML = "";

    cycleColorEntries.forEach((entry, idx) => {
        const el = document.createElement("div");
        el.className = "color-entry" + (idx === selectedCycleIndex ? " selected" : "");
        el.dataset.idx = idx;
        el.draggable = true;

        el.onclick = (e) => {
            // Don't select when clicking remove, inputs, or drag handle
            if (e.target.closest('.color-entry-remove') || e.target.closest('.color-entry-drag-handle') || e.target.tagName === 'INPUT') return;
            selectCycleEntry(idx);
        };

        el.innerHTML = `
            <div class="color-entry-header">
                <div class="color-entry-drag-handle" style="cursor: grab; display: flex; align-items: center; color: var(--text-dim); margin-right: 4px; user-select: none;">
                    <span class="material-icons-round" style="font-size: 18px;">drag_indicator</span>
                </div>
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

        // Desktop Drag and Drop listeners
        el.addEventListener("dragstart", (e) => {
            if (e.target.closest('.color-entry-remove') || e.target.tagName === 'INPUT') {
                e.preventDefault();
                return;
            }
            e.dataTransfer.setData("text/plain", idx);
            el.classList.add("dragging");
        });

        el.addEventListener("dragend", () => {
            el.classList.remove("dragging");
            saveNewCycleColorsOrder();
        });

        el.addEventListener("dragover", (e) => {
            e.preventDefault();
            const draggingEl = list.querySelector(".color-entry.dragging");
            if (!draggingEl) return;

            const siblings = [...list.querySelectorAll(".color-entry:not(.dragging)")];
            let nextSibling = siblings.find(sibling => {
                const box = sibling.getBoundingClientRect();
                const offset = e.clientY - box.top - box.height / 2;
                return offset < 0;
            });

            list.insertBefore(draggingEl, nextSibling);
        });

        el.addEventListener("drop", (e) => {
            e.preventDefault();
        });

        // Mobile touch drag handle binding
        const handle = el.querySelector(".color-entry-drag-handle");
        if (handle) {
            handle.addEventListener("touchstart", (e) => {
                touchDragColorEl = el;
                el.classList.add("dragging");
            }, { passive: true });
        }

        list.appendChild(el);
    });

    // Mobile touch move/end listeners on parent list
    if (!list.dataset.touchBound) {
        list.dataset.touchBound = "true";

        list.addEventListener("touchmove", (e) => {
            if (!touchDragColorEl) return;
            const touch = e.touches[0];
            const entries = [...list.querySelectorAll(".color-entry:not(.dragging)")];

            let nextSibling = entries.find(sibling => {
                const box = sibling.getBoundingClientRect();
                return touch.clientY < box.top + box.height / 2;
            });

            list.insertBefore(touchDragColorEl, nextSibling);
            e.preventDefault(); // prevent scrolling
        }, { passive: false });

        list.addEventListener("touchend", () => {
            if (!touchDragColorEl) return;
            touchDragColorEl.classList.remove("dragging");
            touchDragColorEl = null;
            saveNewCycleColorsOrder();
        });
    }

    // Update Add button visibility
    const addBtn = document.getElementById("btnAddColor");
    if (addBtn) {
        addBtn.style.display = cycleColorEntries.length >= 50 ? 'none' : 'flex';
    }
}

function saveNewCycleColorsOrder() {
    // Sync UI inputs before reordering
    syncCycleDurationsFromUI();

    const list = document.getElementById("colorEntryList");
    const entries = [...list.querySelectorAll(".color-entry")];

    const newOrder = entries.map(el => {
        const idx = parseInt(el.dataset.idx);
        return cycleColorEntries[idx];
    });

    cycleColorEntries = newOrder;

    const newSelectedIndex = entries.findIndex(el => el.classList.contains("selected"));
    selectedCycleIndex = newSelectedIndex >= 0 ? newSelectedIndex : 0;

    renderCycleColorEntries();
    selectCycleEntry(selectedCycleIndex);
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
    if (cycleColorEntries.length >= 50) return;

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

// ==========================================================================
// PWA Install Prompt (Mobile Browser Only)
// ==========================================================================
let deferredInstallPrompt = null; // Captured beforeinstallprompt event

// Capture the beforeinstallprompt event (Android Chrome, Edge, etc.)
window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
});

function checkPWAInstallPrompt() {
    const isPWA = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isPWA) return; // Already running as PWA

    // Only show on phones (not tablets/desktops)
    const isMobile = /Android|iPhone|iPod/i.test(navigator.userAgent) && window.innerWidth < 768;
    if (!isMobile) return;

    // Check if user previously dismissed
    if (localStorage.getItem("ll_skip_pwa_prompt") === "true") return;

    // Show the overlay
    const overlay = document.getElementById("pwaInstallOverlay");
    if (!overlay) return;

    // Detect OS/browser for contextual instructions
    const isIOS = /iPhone|iPod/.test(navigator.userAgent);
    const isSafari = isIOS && /Safari/i.test(navigator.userAgent) && !/CriOS|FxiOS|OPiOS/i.test(navigator.userAgent);
    const isAndroid = /Android/i.test(navigator.userAgent);
    const isChrome = /Chrome/i.test(navigator.userAgent) && !/Edge|OPR|Samsung/i.test(navigator.userAgent);
    const isSamsung = /SamsungBrowser/i.test(navigator.userAgent);
    const isFirefox = /Firefox|FxiOS/i.test(navigator.userAgent);

    const instructionsEl = document.getElementById("pwaInstallInstructions");
    let steps = "";

    if (isIOS && isSafari) {
        steps = `
            <div class="pwa-step"><span class="pwa-step-num">1</span><span>Tap the <strong>Share</strong> button <span class="material-icons-round" style="font-size:18px; vertical-align:middle;">ios_share</span> at the bottom of your screen</span></div>
            <div class="pwa-step"><span class="pwa-step-num">2</span><span>Scroll down and tap <strong>"Add to Home Screen"</strong></span></div>
            <div class="pwa-step"><span class="pwa-step-num">3</span><span>Tap <strong>"Add"</strong> in the top right</span></div>
        `;
    } else if (isIOS && !isSafari) {
        steps = `
            <div class="pwa-step"><span class="pwa-step-num">1</span><span>Open this page in <strong>Safari</strong> for the best experience</span></div>
            <div class="pwa-step"><span class="pwa-step-num">2</span><span>Tap the <strong>Share</strong> button <span class="material-icons-round" style="font-size:18px; vertical-align:middle;">ios_share</span></span></div>
            <div class="pwa-step"><span class="pwa-step-num">3</span><span>Tap <strong>"Add to Home Screen"</strong></span></div>
        `;
    } else if (isAndroid && isChrome) {
        steps = `
            <div class="pwa-step"><span class="pwa-step-num">1</span><span>Tap the <strong>⋮ menu</strong> in the top right corner</span></div>
            <div class="pwa-step"><span class="pwa-step-num">2</span><span>Tap <strong>"Add to Home screen"</strong> or <strong>"Install app"</strong></span></div>
            <div class="pwa-step"><span class="pwa-step-num">3</span><span>Tap <strong>"Install"</strong> to confirm</span></div>
        `;
    } else if (isAndroid && isSamsung) {
        steps = `
            <div class="pwa-step"><span class="pwa-step-num">1</span><span>Tap the <strong>☰ menu</strong> at the bottom right</span></div>
            <div class="pwa-step"><span class="pwa-step-num">2</span><span>Tap <strong>"Add page to"</strong> → <strong>"Home screen"</strong></span></div>
            <div class="pwa-step"><span class="pwa-step-num">3</span><span>Tap <strong>"Add"</strong> to confirm</span></div>
        `;
    } else if (isAndroid && isFirefox) {
        steps = `
            <div class="pwa-step"><span class="pwa-step-num">1</span><span>Tap the <strong>⋮ menu</strong> in the top right</span></div>
            <div class="pwa-step"><span class="pwa-step-num">2</span><span>Tap <strong>"Install"</strong></span></div>
            <div class="pwa-step"><span class="pwa-step-num">3</span><span>Confirm the installation</span></div>
        `;
    } else {
        steps = `
            <div class="pwa-step"><span class="pwa-step-num">1</span><span>Open your browser's <strong>menu</strong></span></div>
            <div class="pwa-step"><span class="pwa-step-num">2</span><span>Look for <strong>"Add to Home Screen"</strong> or <strong>"Install"</strong></span></div>
            <div class="pwa-step"><span class="pwa-step-num">3</span><span>Confirm to add the app</span></div>
        `;
    }

    instructionsEl.innerHTML = steps;

    // Show/hide native install button for browsers that support beforeinstallprompt
    const nativeBtn = document.getElementById("pwaInstallNativeBtn");
    if (deferredInstallPrompt && nativeBtn) {
        nativeBtn.style.display = "flex";
    }

    overlay.style.display = "flex";
}

function triggerNativePWAInstall() {
    if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice.then((result) => {
            if (result.outcome === 'accepted') {
                dismissPWAPrompt();
            }
            deferredInstallPrompt = null;
        });
    }
}

function dismissPWAPrompt() {
    localStorage.setItem("ll_skip_pwa_prompt", "true");
    const overlay = document.getElementById("pwaInstallOverlay");
    if (overlay) overlay.style.display = "none";
}

// ==========================================================================
// Multi-Account Switcher (PWA Only)
// ==========================================================================
function isPWA() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
}

function loadAccounts() {
    try {
        const raw = localStorage.getItem("ll_accounts");
        if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return null;
}

function saveAccounts(accounts) {
    localStorage.setItem("ll_accounts", JSON.stringify(accounts));
}

/**
 * On first use with the new system, convert the existing single-account
 * localStorage entries into the accounts array.
 */
function migrateCurrentToAccounts() {
    const accounts = loadAccounts();
    const currentUID = localStorage.getItem("ll_uid");
    if (!currentUID) return;

    if (accounts) {
        // Check if this UID already exists
        const exists = accounts.some(a => a.uid === currentUID);
        if (!exists) {
            // New UID from URL — add as new account and set active
            accounts.forEach(a => a.active = false);
            const name = localStorage.getItem("ll_name") || "Partner";
            accounts.push({ uid: currentUID, name: name, active: true });
            saveAccounts(accounts);
        }
        return;
    }

    // No accounts array yet — create one from current credentials
    const name = localStorage.getItem("ll_name") || "Partner";
    saveAccounts([{ uid: currentUID, name: name, active: true }]);

    // Migrate legacy settings & presets to the new UID key
    const myId = localStorage.getItem("ll_id") || "A";
    const legacySettings = localStorage.getItem("ll_settings_" + myId);
    if (legacySettings && !localStorage.getItem("ll_settings_" + currentUID)) {
        localStorage.setItem("ll_settings_" + currentUID, legacySettings);
    }
    const legacyPresets = localStorage.getItem("ll_presets_" + myId);
    if (legacyPresets && !localStorage.getItem("ll_presets_" + currentUID)) {
        localStorage.setItem("ll_presets_" + currentUID, legacyPresets);
    }
}

function initAccountSwitcherButton() {
    const btn = document.getElementById("btnSwitchAccounts");
    const card = document.getElementById("accountSwitcherCard");
    if (!btn || !card) return;

    if (isPWA()) {
        btn.style.display = "flex";
        card.style.display = "block";
        // Also ensure current account is in the accounts list
        migrateCurrentToAccounts();
    } else {
        btn.style.display = "none";
        card.style.display = "none";
    }
}

function openAccountSwitcher() {
    const modal = document.getElementById("accountSwitcherModal");
    if (!modal) return;

    renderAccountList();
    modal.style.display = "flex";
}

function closeAccountSwitcher() {
    const modal = document.getElementById("accountSwitcherModal");
    if (modal) modal.style.display = "none";

    // Hide the add-account input if it was open
    const addSection = document.getElementById("addAccountSection");
    if (addSection) addSection.style.display = "none";
}

function renderAccountList() {
    const list = document.getElementById("accountList");
    if (!list) return;

    const accounts = loadAccounts() || [];
    list.innerHTML = "";

    accounts.forEach((acct, idx) => {
        const item = document.createElement("div");
        item.className = "account-item" + (acct.active ? " active" : "");
        item.onclick = () => { if (!acct.active) switchToAccount(idx); };

        const info = document.createElement("div");
        info.className = "account-info";

        const name = document.createElement("span");
        name.className = "account-name";
        name.innerText = acct.name + "'s Group";

        const badge = document.createElement("span");
        badge.className = "account-badge";
        badge.innerText = acct.active ? "Active" : "";

        info.appendChild(name);
        info.appendChild(badge);

        const actions = document.createElement("div");
        actions.className = "account-actions";

        if (accounts.length > 1) {
            const delBtn = document.createElement("button");
            delBtn.className = "account-delete-btn";
            delBtn.innerHTML = '<span class="material-icons-round" style="font-size:18px;">delete_outline</span>';
            delBtn.onclick = (e) => { e.stopPropagation(); deleteAccount(idx); };
            actions.appendChild(delBtn);
        }

        item.appendChild(info);
        item.appendChild(actions);
        list.appendChild(item);
    });
}

function switchToAccount(index) {
    const accounts = loadAccounts();
    if (!accounts || index < 0 || index >= accounts.length) return;

    const target = accounts[index];
    const decoded = decodeUID(target.uid);
    if (!decoded) {
        alert("This account's data appears to be corrupted. Please re-add it.");
        return;
    }

    // Mark new account as active
    accounts.forEach(a => a.active = false);
    accounts[index].active = true;
    saveAccounts(accounts);

    // Update localStorage credentials
    localStorage.setItem("ll_s", decoded.s);
    localStorage.setItem("ll_u", decoded.u);
    localStorage.setItem("ll_p", decoded.p);
    const deviceId = decoded.id.toUpperCase() === "B" ? "B" : "A";
    localStorage.setItem("ll_id", deviceId);

    if (decoded.name) {
        localStorage.setItem("ll_name", decoded.name);
    } else {
        localStorage.setItem("ll_name", target.name || "Partner");
    }
    localStorage.setItem("ll_uid", target.uid);
    localStorage.setItem("ll_delim", decoded.d || "/");

    // Update in-memory state
    mqtt_server = decoded.s;
    mqtt_user = decoded.u;
    mqtt_pass = decoded.p;
    myDeviceId = deviceId;
    partnerDeviceId = myDeviceId === "A" ? "B" : "A";
    partnerName = decoded.name || "Partner";
    mqtt_delimiter = decoded.d || "/";

    // Load settings & presets for the new account
    const saved = localStorage.getItem("ll_settings_" + target.uid);
    if (saved) {
        try { mySettings = JSON.parse(saved); } catch (e) { /* use defaults */ }
    } else {
        // Reset to defaults
        mySettings = {
            defaultColor: "#FF0000", dayTimeMin: 5, dayBright: 255,
            ambientMode: false, ambientColor: "#0000FF",
            nightMode: false, nightStart: "22:00", nightEnd: "08:00",
            nightTimeMin: 5, nightBright: 76, timezone: "EST5EDT", lastTapTimestamp: 0
        };
    }
    const savedPresets = localStorage.getItem("ll_presets_" + target.uid);
    if (savedPresets) {
        try { presets = JSON.parse(savedPresets); } catch (e) {
            presets = [
                { id: "default_love", name: "I Love You", color: "#FF0000" },
                { id: "default_miss", name: "I Miss You", color: "#00FF00" }
            ];
        }
    } else {
        presets = [
            { id: "default_love", name: "I Love You", color: "#FF0000" },
            { id: "default_miss", name: "I Miss You", color: "#00FF00" }
        ];
    }

    // Disconnect and reconnect MQTT
    if (mqttClient) {
        mqttClient.end(true);
        mqttClient = null;
    }
    isMqttConnected = false;
    myLampOnline = null;
    partnerLampOnline = null;
    mySupLampOnline = null;
    partnerSupLampOnline = null;
    hasMySupLamp = false;
    hasPartnerSupLamp = false;

    connectMQTT();
    applySettingsToUI();
    renderPresets();
    renderConnections();
    setDashboardSignalsMode('signals');

    // Update page title
    document.getElementById("pageTitle").innerText = "My Group";
    document.getElementById("signalSubtitle").innerText = "Tap to turn on " + partnerName + "'s lamp";

    closeAccountSwitcher();
    renderAccountList();
    renderGroupsPage();
}

function showAddAccountInput() {
    const section = document.getElementById("addAccountSection");
    if (section) {
        section.style.display = "block";
        document.getElementById("newAccountUidInput").value = "";
        document.getElementById("newAccountError").style.display = "none";
        document.getElementById("newAccountUidInput").focus();
    }
}

function addNewAccount() {
    const input = document.getElementById("newAccountUidInput");
    const errorEl = document.getElementById("newAccountError");
    const raw = input.value.trim();

    if (!raw) {
        errorEl.style.display = "block";
        errorEl.innerText = "Please enter a Unique ID.";
        return;
    }

    let decoded = decodeUID(raw);

    // Also try parsing as a full URL
    if (!decoded) {
        try {
            const url = new URL(raw);
            let searchParams = new URLSearchParams(url.search);
            if (!searchParams.has("uid") && !searchParams.has("s")) {
                searchParams = new URLSearchParams(url.hash.substring(1));
            }
            if (searchParams.has("uid")) {
                decoded = decodeUID(searchParams.get("uid"));
                const urlName = searchParams.get("name") || searchParams.get("partner");
                if (decoded && urlName) decoded.name = urlName;
            } else if (searchParams.has("s") && searchParams.has("u") && searchParams.has("p") && searchParams.has("id")) {
                decoded = {
                    s: searchParams.get("s"), u: searchParams.get("u"),
                    p: searchParams.get("p"), id: searchParams.get("id"),
                    name: searchParams.get("name") || searchParams.get("partner") || null
                };
            }
        } catch (e) { /* not a URL */ }
    }

    if (!decoded) {
        errorEl.style.display = "block";
        errorEl.innerText = "Invalid ID. Please check and try again.";
        return;
    }

    const uid = encodeUID(decoded.s, decoded.u, decoded.p, decoded.id, decoded.d || "/");
    const accounts = loadAccounts() || [];

    // Check for duplicates
    if (accounts.some(a => a.uid === uid)) {
        errorEl.style.display = "block";
        errorEl.innerText = "This account is already added.";
        return;
    }

    const name = decoded.name || "Partner";
    accounts.push({ uid: uid, name: name, active: false });
    saveAccounts(accounts);

    // Save beta opt-in for this new account
    const betaToggle = document.getElementById("newAccountBetaToggle");
    if (betaToggle) {
        localStorage.setItem("ll_beta_tester_" + uid, betaToggle.checked ? "true" : "false");
        betaToggle.checked = false;
    }

    // Hide input, re-render list
    document.getElementById("addAccountSection").style.display = "none";
    renderAccountList();
}

function deleteAccount(index) {
    const accounts = loadAccounts();
    if (!accounts || accounts.length <= 1) return;

    const target = accounts[index];
    if (!confirm(`Remove ${target.name}'s Group?`)) return;

    const wasActive = target.active;
    if (target && target.uid) {
        localStorage.removeItem("ll_beta_tester_" + target.uid);
    }
    accounts.splice(index, 1);

    // If deleted the active account, switch to the first remaining
    if (wasActive && accounts.length > 0) {
        accounts[0].active = true;
        saveAccounts(accounts);
        switchToAccount(0);
        return;
    }

    saveAccounts(accounts);
    renderAccountList();
}

// ==========================================================================
// QR Scanner for PWA Login
// ==========================================================================
let html5QrCode = null;
let qrTargetAction = 'login'; // 'login' or 'addAccount'
let cameraDevices = [];
let currentCameraIndex = 0;

function openQRScanner(actionType = 'login') {
    qrTargetAction = actionType;
    document.getElementById("qrScannerModal").style.display = "flex";

    if (!html5QrCode) {
        html5QrCode = new Html5Qrcode("qr-reader");
    }

    // Automatically query available cameras
    Html5Qrcode.getCameras().then(devices => {
        cameraDevices = devices || [];
        const switchBtn = document.getElementById("switchCameraBtn");
        if (cameraDevices.length > 1) {
            if (switchBtn) switchBtn.style.display = "inline-flex";
            // Default to back/rear camera index
            const backIdx = cameraDevices.findIndex(device =>
                device.label.toLowerCase().includes("back") ||
                device.label.toLowerCase().includes("environment") ||
                device.label.toLowerCase().includes("rear")
            );
            currentCameraIndex = backIdx >= 0 ? backIdx : 0;
        } else {
            if (switchBtn) switchBtn.style.display = "none";
        }
        startCamera();
    }).catch(err => {
        console.warn("Error listing cameras, falling back to facingMode:", err);
        startCameraWithFacingMode();
    });
}

function startCamera() {
    if (cameraDevices.length === 0) {
        startCameraWithFacingMode();
        return;
    }
    const deviceId = cameraDevices[currentCameraIndex].id;
    html5QrCode.start(
        deviceId,
        { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
        onScanSuccess,
        onScanFailure
    ).then(() => {
        setupZoomSlider();
    }).catch(err => {
        console.warn("Failed to start camera by ID, falling back to facingMode:", err);
        startCameraWithFacingMode();
    });
}

function startCameraWithFacingMode() {
    html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
        onScanSuccess,
        onScanFailure
    ).then(() => {
        setupZoomSlider();
    }).catch(err => {
        console.error("Error starting QR scanner:", err);
        alert("Could not start camera. Please ensure permissions are granted.");
        closeQRScanner();
    });
}

function switchCamera() {
    if (cameraDevices.length <= 1) return;
    if (html5QrCode && html5QrCode.isScanning) {
        html5QrCode.stop().then(() => {
            currentCameraIndex = (currentCameraIndex + 1) % cameraDevices.length;
            startCamera();
        }).catch(err => {
            console.error("Error stopping camera for switch:", err);
        });
    }
}

function setupZoomSlider() {
    const slider = document.getElementById("zoomSlider");
    const container = document.getElementById("zoomContainer");
    if (!slider || !container) return;

    // Reset transform constraints on any running video element
    const video = document.querySelector("#qr-reader video");
    if (video) {
        video.style.transform = "";
        video.style.transition = "transform 0.15s ease-out";
    }

    let nativeZoomSupported = false;
    let capabilities = null;
    try {
        capabilities = html5QrCode.getRunningTrackCapabilities();
        if (capabilities && capabilities.zoom) {
            nativeZoomSupported = true;
        }
    } catch (e) {
        console.warn("Failed to get track capabilities:", e);
    }

    container.style.display = "flex";

    if (nativeZoomSupported && capabilities.zoom) {
        slider.min = capabilities.zoom.min;
        slider.max = capabilities.zoom.max;
        slider.step = capabilities.zoom.step || 0.1;
        slider.value = capabilities.zoom.min || 1;

        slider.oninput = (e) => {
            const zoomVal = parseFloat(e.target.value);
            html5QrCode.applyVideoConstraints({
                advanced: [{ zoom: zoomVal }]
            }).catch(err => console.error("Error applying native zoom:", err));
        };
    } else {
        // CSS Digital Zoom fallback (e.g. for iOS Safari)
        slider.min = 1;
        slider.max = 3.5;
        slider.step = 0.1;
        slider.value = 1;

        slider.oninput = (e) => {
            const zoomVal = parseFloat(e.target.value);
            const videoElement = document.querySelector("#qr-reader video");
            if (videoElement) {
                videoElement.style.transform = `scale(${zoomVal})`;
                videoElement.style.transformOrigin = "center";
            }
        };
    }
}

function closeQRScanner() {
    if (html5QrCode && html5QrCode.isScanning) {
        html5QrCode.stop().then(() => {
            html5QrCode.clear();
        }).catch(error => {
            console.error("Failed to stop html5QrCode. ", error);
        });
    }
    document.getElementById("qrScannerModal").style.display = "none";
    document.getElementById("zoomContainer").style.display = "none";
    const switchBtn = document.getElementById("switchCameraBtn");
    if (switchBtn) switchBtn.style.display = "none";
}

function onScanSuccess(decodedText, decodedResult) {
    try {
        const url = new URL(decodedText);
        // Only accept linkedlamp.com/my/ links
        if (url.hostname.includes("linkedlamp.com") && url.pathname.includes("/my")) {
            let searchParams = new URLSearchParams(url.search);
            // Handle hash based routing fallback
            if (!searchParams.has("uid") && url.hash.includes("uid=")) {
                searchParams = new URLSearchParams(url.hash.substring(1));
            }

            if (searchParams.has("uid")) {
                const uid = searchParams.get("uid");

                if (qrTargetAction === 'login') {
                    document.getElementById("uidInput").value = uid;
                    closeQRScanner();
                    connectWithUID();
                } else if (qrTargetAction === 'addAccount') {
                    document.getElementById("newAccountUidInput").value = uid;
                    closeQRScanner();
                    addNewAccount();
                } else if (qrTargetAction === 'inlineAddAccount') {
                    document.getElementById("inlineNewAccountUidInput").value = uid;
                    closeQRScanner();
                    addInlineNewAccount();
                }
            }
        }
    } catch (e) {
        // Not a valid URL, ignore it and keep scanning silently
    }
}

function onScanFailure(error) {
    // html5-qrcode calls this on every frame that doesn't have a code.
    // We ignore it to let the scanner keep looking.
}

// ==========================================================================
// My Groups Page Management
// ==========================================================================
let isGroupsEditMode = false;
let backgroundMqttClients = {}; // uid -> state object

function formatTime12h(time24) {
    if (!time24) return "";
    const parts = time24.split(":");
    if (parts.length < 2) return time24;
    let h = parseInt(parts[0]);
    const m = parts[1];
    const ampm = h >= 12 ? "PM" : "AM";
    if (h === 0) h = 12;
    if (h > 12) h -= 12;
    return `${h}:${m} ${ampm}`;
}

function formatLastTapDate(timestamp) {
    if (!timestamp || timestamp <= 0) return "Unknown";
    const date = new Date(timestamp * 1000);
    const testDate = new Date(2026, 11, 31);
    const formattedTest = testDate.toLocaleDateString();
    const monthFirst = formattedTest.indexOf("12") < formattedTest.indexOf("31");

    const m = String(date.getMonth() + 1);
    const d = String(date.getDate());

    let h = date.getHours();
    const min = String(date.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    h = h ? h : 12;

    const timeStr = `${h}:${min} ${ampm}`;
    const dateStr = monthFirst ? `${m}/${d}` : `${d}/${m}`;

    return `${dateStr}, ${timeStr}`;
}

function renderGroupsPage() {
    const list = document.getElementById("groupsList");
    if (!list) return;

    const accounts = loadAccounts() || [];
    list.innerHTML = "";

    // If no accounts exist, make sure active one is initialized
    if (accounts.length === 0) {
        migrateCurrentToAccounts();
    }

    const updatedAccounts = loadAccounts() || [];

    // Edit button / Add icon logic
    const editBtn = document.getElementById("btnGroupsEdit");
    const editIcon = document.getElementById("groupsEditIcon");
    const addContainer = document.getElementById("groupsAddContainer");

    if (updatedAccounts.length <= 1) {
        // If only 1 account, show add icon instead of edit
        if (editIcon) editIcon.innerText = "add";
        if (editBtn) editBtn.onclick = () => {
            isGroupsEditMode = false; // Turn off edit mode
            showInlineAddGroup();
        };
        if (addContainer) addContainer.style.display = "none";
    } else {
        if (editIcon) {
            editIcon.innerText = isGroupsEditMode ? "check" : "edit";
        }
        if (editBtn) editBtn.onclick = () => toggleGroupsEdit();
        if (addContainer) {
            addContainer.style.display = isGroupsEditMode ? "block" : "none";
        }
    }

    updatedAccounts.forEach((acct, idx) => {
        // Load cached settings
        const settings = {
            defaultColor: "#FF0000",
            dayBright: 255,
            dayTimeMin: 5,
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
        try {
            const saved = localStorage.getItem("ll_settings_" + acct.uid);
            if (saved) {
                const parsed = JSON.parse(saved);
                Object.assign(settings, parsed);
            }
        } catch (e) { }

        const card = document.createElement("div");
        card.className = "group-card";
        card.dataset.uid = acct.uid;
        card.dataset.index = idx;

        const decoded = decodeUID(acct.uid);
        let partnerNameVal = acct.name;
        if (acct.active) {
            partnerNameVal = localStorage.getItem("ll_name") || acct.name;
        }
        if (!partnerNameVal) {
            partnerNameVal = decoded ? decoded.name || "Partner" : "Partner";
        }

        let displayName = partnerNameVal;
        if (!displayName.toLowerCase().includes("lamp")) {
            displayName = `${displayName}'s Lamp`;
        }

        // Load presets for this group, take top 2
        let acctPresets = [
            { id: "default_love", name: "I Love You", color: "#FF0000" },
            { id: "default_miss", name: "I Miss You", color: "#00FF00" }
        ];
        try {
            const savedPresets = localStorage.getItem("ll_presets_" + acct.uid);
            if (savedPresets) acctPresets = JSON.parse(savedPresets);
        } catch (e) { }
        const topPresets = acctPresets.slice(0, 2);

        const defaultLandingUid = localStorage.getItem("ll_default_landing_uid");
        const isDefault = acct.uid === defaultLandingUid;

        const bgState = backgroundMqttClients[acct.uid];
        const isCurrentActive = acct.uid === localStorage.getItem("ll_uid");
        const hasBonfire = (isCurrentActive && bonfireState.active) || (bgState && bgState.bonfireActive);

        let circleHtml = '';
        let presetsHtml = '';

        if (hasBonfire) {
            circleHtml = `
                <div class="group-bonfire-circle" onclick="if(!isGroupsEditMode) handleGroupBonfireTap('${acct.uid}')" title="Virtual Bonfire Active (Tap to add log)">
                    <span class="material-icons-round flame-icon">local_fire_department</span>
                </div>
            `;
            presetsHtml = `
                <div class="group-presets-row" style="display: flex; gap: 10px; width: 100%; margin-top: 15px;">
                    <button class="action-btn secondary-btn group-preset-btn group-bonfire-log-btn" style="flex: 1; display: inline-flex; align-items: center; justify-content: center; padding: 10px 14px; border-radius: 8px; cursor: pointer;" onclick="handleGroupAddLog('${acct.uid}', event)">
                        <span class="material-icons-round" style="font-size: 18px; margin-right: 6px; color: #ff9800;">local_fire_department</span>
                        <span>Add Log</span>
                    </button>
                    <button class="action-btn secondary-btn group-preset-btn group-bonfire-extinguish-btn" style="flex: 1; display: inline-flex; align-items: center; justify-content: center; padding: 10px 14px; border-radius: 8px; cursor: pointer;" onclick="handleGroupExtinguish('${acct.uid}', event)">
                        <span class="material-icons-round" style="font-size: 18px; margin-right: 6px; color: #54a0ff;">water_drop</span>
                        <span>Put Out Fire</span>
                    </button>
                </div>
            `;
        } else {
            circleHtml = `
                <div class="group-color-circle ${getLuminance(settings.defaultColor) > 0.6 ? 'dark-text' : 'light-text'}" style="background-color: ${settings.defaultColor};" onclick="if(!isGroupsEditMode) handleGroupTileTap('${acct.uid}')" title="Tap to send signal">
                    <span class="material-icons-round">send</span>
                </div>
            `;
            presetsHtml = `
                <div class="group-presets-row" style="display: flex; gap: 10px; width: 100%; margin-top: 15px;">
                    ${topPresets.map(p => `
                        <button class="action-btn secondary-btn group-preset-btn" style="flex: 1; display: inline-flex; align-items: center; justify-content: flex-start; padding: 10px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); color: var(--text); font-weight: 500; cursor: pointer; background: rgba(255,255,255,0.05); --preset-color: ${p.type === 'cycle' && p.colors && p.colors.length > 0 ? p.colors[0].hex : p.color};" onclick="handleGroupPresetTap('${acct.uid}', ${JSON.stringify(p).replace(/"/g, '&quot;')}, event)">
                            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; width: 100%;">${p.name}</span>
                        </button>
                    `).join('')}
                </div>
            `;
        }

        card.innerHTML = `
            <div class="group-card-top" style="display: flex; width: 100%; align-items: center; gap: 16px; position: relative;">
                <div class="group-drag-handle" style="display: ${isGroupsEditMode ? 'flex' : 'none'};">
                    <span class="material-icons-round">drag_indicator</span>
                </div>
                ${circleHtml}
                <div class="group-details" style="flex: 1; min-width: 0;">
                    <h3 class="group-title">${displayName}</h3>
                    <div class="group-settings-row">
                        <span class="group-setting-item" title="Day Brightness & Duration">
                            <span class="material-icons-round">wb_sunny</span>
                            <span>${Math.round((settings.dayBright / 255) * 100)}% (${settings.dayTimeMin}m)</span>
                        </span>
                        ${settings.ambientMode ? `
                        <span class="group-setting-item active" style="color: var(--accent);" title="Ambient Mode On">
                            <span class="material-icons-round">wb_twilight</span>
                            <span>On</span>
                        </span>
                        ` : ''}
                        ${settings.nightMode ? `
                        <span class="group-setting-item" title="Night Mode Timings">
                            <span class="material-icons-round">nights_stay</span>
                            <span>${formatTime12h(settings.nightStart)} - ${formatTime12h(settings.nightEnd)}</span>
                        </span>
                        ` : ''}
                    </div>
                    <div class="group-last-tap" id="lastTap-${acct.uid}" style="margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%;">
                        Last Tap: ${formatLastTapDate(settings.lastTapTimestamp)}
                    </div>
                </div>
                <div class="group-actions" style="display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; align-self: stretch;">
                    <div class="group-status" id="status-${acct.uid}">
                        <span class="dot connecting"></span>
                        <span class="status-text" style="display: none !important;">Connecting</span>
                    </div>
                    <button class="icon-btn group-page-btn" onclick="navigateToGroup('${acct.uid}')" style="display: ${isGroupsEditMode ? 'none' : 'flex'}; margin-top: auto;" title="View Group Details">
                        <span class="material-icons-round">description</span>
                    </button>
                    ${isGroupsEditMode ? `
                    <div style="display: flex; gap: 12px; margin-top: auto; align-items: center;">
                        <button class="icon-btn" onclick="toggleDefaultGroup('${acct.uid}', event)" style="color: ${isDefault ? '#f1c40f' : 'var(--text-dim)'}; filter: ${isDefault ? 'drop-shadow(0 0 4px rgba(241,196,15,0.4))' : 'none'};" title="${isDefault ? 'Default Landing Group' : 'Make Default Landing'}">
                            <span class="material-icons-round">${isDefault ? 'star' : 'star_border'}</span>
                        </button>
                        <button class="icon-btn group-delete-btn" onclick="deleteGroup('${acct.uid}')" style="color: var(--danger);" title="Delete Group">
                            <span class="material-icons-round">delete</span>
                        </button>
                    </div>
                    ` : ''}
                </div>
            </div>
            ${presetsHtml}
        `;

        list.appendChild(card);
    });

    // Initialize/sync background MQTT clients
    initBackgroundMqtt();

    // Make reorder dragging work
    if (isGroupsEditMode) {
        makeGroupCardsDraggable();
        makeGroupCardsTouchDraggable();
    }
}

function toggleGroupsEdit() {
    isGroupsEditMode = !isGroupsEditMode;

    // Hide inline add group input if exiting edit mode
    if (!isGroupsEditMode) {
        const addSection = document.getElementById("inlineAddGroupSection");
        if (addSection) addSection.style.display = "none";
    }

    renderGroupsPage();
}

function showInlineAddGroup() {
    const section = document.getElementById("inlineAddGroupSection");
    if (section) {
        section.style.display = section.style.display === "block" ? "none" : "block";
        document.getElementById("inlineNewAccountUidInput").value = "";
        document.getElementById("inlineNewAccountError").style.display = "none";
        document.getElementById("inlineNewAccountUidInput").focus();
    }
}

function addInlineNewAccount() {
    const input = document.getElementById("inlineNewAccountUidInput");
    const errorEl = document.getElementById("inlineNewAccountError");
    const raw = input.value.trim();

    if (!raw) {
        errorEl.style.display = "block";
        errorEl.innerText = "Please enter a Unique ID.";
        return;
    }

    let decoded = decodeUID(raw);

    if (!decoded) {
        try {
            const url = new URL(raw);
            let searchParams = new URLSearchParams(url.search);
            if (!searchParams.has("uid") && !searchParams.has("s")) {
                searchParams = new URLSearchParams(url.hash.substring(1));
            }
            if (searchParams.has("uid")) {
                decoded = decodeUID(searchParams.get("uid"));
                const urlName = searchParams.get("name") || searchParams.get("partner");
                if (decoded && urlName) decoded.name = urlName;
            } else if (searchParams.has("s") && searchParams.has("u") && searchParams.has("p") && searchParams.has("id")) {
                decoded = {
                    s: searchParams.get("s"), u: searchParams.get("u"),
                    p: searchParams.get("p"), id: searchParams.get("id"),
                    name: searchParams.get("name") || searchParams.get("partner") || null
                };
            }
        } catch (e) { }
    }

    if (!decoded) {
        errorEl.style.display = "block";
        errorEl.innerText = "Invalid ID. Please check and try again.";
        return;
    }

    const uid = encodeUID(decoded.s, decoded.u, decoded.p, decoded.id, decoded.d || "/");
    const accounts = loadAccounts() || [];

    if (accounts.some(a => a.uid === uid)) {
        errorEl.style.display = "block";
        errorEl.innerText = "This account is already added.";
        return;
    }

    const name = decoded.name || "Partner";
    accounts.push({ uid: uid, name: name, active: false });
    saveAccounts(accounts);

    // Save beta opt-in for this new account
    const betaToggle = document.getElementById("inlineNewAccountBetaToggle");
    if (betaToggle) {
        localStorage.setItem("ll_beta_tester_" + uid, betaToggle.checked ? "true" : "false");
        betaToggle.checked = false;
    }

    // Hide input, re-render list
    document.getElementById("inlineAddGroupSection").style.display = "none";
    renderGroupsPage();
}

function deleteGroup(uid) {
    if (localStorage.getItem("ll_default_landing_uid") === uid) {
        localStorage.removeItem("ll_default_landing_uid");
    }

    const accounts = loadAccounts() || [];
    const idx = accounts.findIndex(a => a.uid === uid);
    if (idx < 0) return;

    const target = accounts[idx];
    if (!confirm(`Remove ${target.name}'s Group?`)) return;

    const wasActive = target.active;

    // Disconnect and clean up background client
    if (backgroundMqttClients[uid]) {
        try {
            backgroundMqttClients[uid].client.end(true);
        } catch (e) { }
        delete backgroundMqttClients[uid];
    }

    localStorage.removeItem("ll_beta_tester_" + uid);
    accounts.splice(idx, 1);
    saveAccounts(accounts);

    if (accounts.length === 0) {
        // Clear all active credentials since no groups are left
        localStorage.removeItem("ll_s");
        localStorage.removeItem("ll_u");
        localStorage.removeItem("ll_p");
        localStorage.removeItem("ll_name");
        localStorage.removeItem("ll_id");
        localStorage.removeItem("ll_uid");
        localStorage.removeItem("ll_delim");
        localStorage.removeItem("ll_beta_tester");

        // Disconnect main MQTT client
        if (mqttClient) {
            mqttClient.end(true);
            mqttClient = null;
        }
        isMqttConnected = false;
    } else if (wasActive) {
        accounts[0].active = true;
        saveAccounts(accounts);

        // Update root localStorage to accounts[0] before reloading
        const nextActive = accounts[0];
        const decoded = decodeUID(nextActive.uid);
        if (decoded) {
            localStorage.setItem("ll_s", decoded.s);
            localStorage.setItem("ll_u", decoded.u);
            localStorage.setItem("ll_p", decoded.p);
            const deviceId = decoded.id.toUpperCase() === "B" ? "B" : "A";
            localStorage.setItem("ll_id", deviceId);
            localStorage.setItem("ll_name", decoded.name || nextActive.name || "Partner");
            localStorage.setItem("ll_uid", nextActive.uid);
            localStorage.setItem("ll_delim", decoded.d || "/");
        }
    }

    // Automatically refresh the page
    window.location.reload();
}

function navigateToGroup(uid) {
    const accounts = loadAccounts() || [];
    const idx = accounts.findIndex(a => a.uid === uid);
    if (idx >= 0) {
        switchToAccount(idx);
        switchTab('partner');
    }
}

// Background MQTT Manager
function initBackgroundMqtt() {
    const accounts = loadAccounts() || [];
    accounts.forEach(acct => {
        if (backgroundMqttClients[acct.uid]) {
            // Re-trigger visual status on render
            updateGroupTileStatusUI(acct.uid);
            return;
        }

        const decoded = decodeUID(acct.uid);
        if (!decoded) return;

        let clean_server = decoded.s;
        let active_port = 8084;
        if (decoded.s.includes(":")) {
            const parts = decoded.s.split(":");
            clean_server = parts[0];
            active_port = parseInt(parts[1]) || 8084;
        }

        const brokerUrl = `wss://${clean_server}:${active_port}/mqtt`;
        const clientId = "Bg-" + decoded.id.toUpperCase() + "-" + Math.random().toString(16).substring(2, 8);
        const myDeviceId = decoded.id.toUpperCase() === "B" ? "B" : "A";
        const partnerDeviceId = myDeviceId === "A" ? "B" : "A";
        const delim = decoded.d || "/";

        function getAccountTopic(devId, suffix) {
            if (delim === "_" && decoded.u) {
                const cleanSuffix = suffix.replace(/\//g, "_");
                return `${decoded.u}/f/ll_${devId}_${cleanSuffix}`;
            }
            return `linkedlamp/${devId}/${suffix}`;
        }

        function getAccountSupTopic(devId) {
            if (delim === "_" && decoded.u) {
                return `${decoded.u}/f/ll_${devId}2_status`;
            }
            return `linkedlamp/${devId}2/status`;
        }

        const client = mqtt.connect(brokerUrl, {
            clientId,
            username: decoded.u,
            password: decoded.p,
            reconnectPeriod: 5000,
            clean: true
        });

        const state = {
            client,
            myLampOnline: null,
            partnerLampOnline: null,
            mySupLampOnline: null,
            partnerSupLampOnline: null,
            hasMySupLamp: false,
            hasPartnerSupLamp: false,
            partnerLastTapTimestamp: 0,
            pendingReadReceipt: false,
            readReceiptTimeout: null,
            bonfireActive: false,
            lastBonfireLogEpoch: 0
        };

        backgroundMqttClients[acct.uid] = state;

        client.on("connect", () => {
            client.subscribe(getAccountTopic(myDeviceId, "status"));
            client.subscribe(getAccountTopic(partnerDeviceId, "status"));
            client.subscribe(getAccountSupTopic(myDeviceId));
            client.subscribe(getAccountSupTopic(partnerDeviceId));
            client.subscribe(getAccountTopic(myDeviceId, "settings"));
            client.subscribe(getAccountTopic(partnerDeviceId, "settings"));
            client.subscribe(getAccountTopic(myDeviceId, "presets"));
            client.subscribe(getAccountTopic(myDeviceId, "bonfire"));
            client.subscribe(getAccountTopic(partnerDeviceId, "bonfire"));

            updateGroupTileStatusUI(acct.uid);
        });

        client.on("offline", () => {
            updateGroupTileStatusUI(acct.uid);
        });

        client.on("close", () => {
            updateGroupTileStatusUI(acct.uid);
        });

        client.on("message", (topic, message) => {
            const msg = message.toString();

            if (topic === getAccountTopic(myDeviceId, "status")) {
                state.myLampOnline = msg.startsWith("ONLINE");
                updateGroupTileStatusUI(acct.uid);
            } else if (topic === getAccountTopic(partnerDeviceId, "status")) {
                state.partnerLampOnline = msg.startsWith("ONLINE");
                updateGroupTileStatusUI(acct.uid);
            } else if (topic === getAccountSupTopic(myDeviceId)) {
                if (msg.length > 0) {
                    state.hasMySupLamp = true;
                    state.mySupLampOnline = msg.startsWith("ONLINE");
                } else {
                    state.hasMySupLamp = false;
                }
                updateGroupTileStatusUI(acct.uid);
            } else if (topic === getAccountSupTopic(partnerDeviceId)) {
                if (msg.length > 0) {
                    state.hasPartnerSupLamp = true;
                    state.partnerSupLampOnline = msg.startsWith("ONLINE");
                } else {
                    state.hasPartnerSupLamp = false;
                }
                updateGroupTileStatusUI(acct.uid);
            } else if (topic === getAccountTopic(myDeviceId, "settings")) {
                try {
                    const settings = JSON.parse(msg);
                    localStorage.setItem("ll_settings_" + acct.uid, msg);
                    updateGroupTileDetails(acct.uid, settings);
                } catch (e) { }
            } else if (topic === getAccountTopic(partnerDeviceId, "settings")) {
                try {
                    const partnerSettings = JSON.parse(msg);
                    const newTimestamp = partnerSettings.lastTapTimestamp || 0;

                    if (state.pendingReadReceipt && newTimestamp > state.partnerLastTapTimestamp) {
                        confirmGroupReadReceipt(acct.uid);
                    }
                    state.partnerLastTapTimestamp = newTimestamp;

                    // Automatically sync and display partner name from their settings MQTT topic
                    if (partnerSettings.ownerName) {
                        updateGroupTileName(acct.uid, partnerSettings.ownerName);
                    }
                } catch (e) { }
            } else if (topic === getAccountTopic(myDeviceId, "presets")) {
                try {
                    const parsed = JSON.parse(msg);
                    localStorage.setItem("ll_presets_" + acct.uid, msg);
                    updateGroupTilePresets(acct.uid, parsed);
                } catch (e) { }
            } else if (topic === getAccountTopic(myDeviceId, "bonfire") || topic === getAccountTopic(partnerDeviceId, "bonfire")) {
                handleGroupIncomingBonfireMessage(acct.uid, msg);
            }
        });
    });
}

function updateGroupTileStatusUI(uid) {
    const state = backgroundMqttClients[uid];
    const statusEl = document.querySelector(`#status-${uid}`);
    if (!state || !statusEl) return;

    const dot = statusEl.querySelector(".dot");
    const text = statusEl.querySelector(".status-text");
    if (!dot || !text) return;

    // If MQTT client is not connected, show connecting state (grey dot)
    if (!state.client || !state.client.connected) {
        dot.className = "dot connecting";
        text.innerText = "Connecting";
        return;
    }

    if (state.myLampOnline === null && state.partnerLampOnline === null) {
        dot.className = "dot connecting";
        text.innerText = "Connecting";
        return;
    }

    const anySupplementary = state.hasMySupLamp || state.hasPartnerSupLamp;

    if (!anySupplementary) {
        const myStatus = state.myLampOnline === null ? false : state.myLampOnline;
        const partnerStatus = state.partnerLampOnline === null ? false : state.partnerLampOnline;

        const decoded = decodeUID(uid);
        const pName = decoded ? decoded.name || "Partner" : "Partner";

        if (myStatus && partnerStatus) {
            dot.className = "dot online";
            text.innerText = "Both Online";
        } else if (myStatus && !partnerStatus) {
            dot.className = "dot partial";
            text.innerText = pName + " Offline";
        } else if (!myStatus && partnerStatus) {
            dot.className = "dot partial";
            text.innerText = "Your Lamp Offline";
        } else {
            dot.className = "dot offline";
            text.innerText = "Lamps Offline";
        }
    } else {
        const lamps = [];
        lamps.push({ name: "My Lamp", online: state.myLampOnline === true, mine: true });
        if (state.hasMySupLamp) lamps.push({ name: "My Lamp 2", online: state.mySupLampOnline === true, mine: true });
        lamps.push({ name: "Partner's Lamp", online: state.partnerLampOnline === true, mine: false });
        if (state.hasPartnerSupLamp) lamps.push({ name: "Partner's Lamp 2", online: state.partnerSupLampOnline === true, mine: false });

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
            dot.className = "dot mine-offline";
            text.innerText = offlineCount === 1 ? "One Offline" : offlineCount + " Offline";
        } else {
            dot.className = "dot partial";
            text.innerText = offlineCount === 1 ? "One Offline" : offlineCount + " Offline";
        }
    }
}

function updateGroupTileDetails(uid, settings) {
    const card = document.querySelector(`.group-card[data-uid="${uid}"]`);
    if (!card) return;

    const circle = card.querySelector(".group-color-circle");
    if (circle && settings.defaultColor) {
        circle.style.backgroundColor = settings.defaultColor;
        circle.classList.remove("light-text", "dark-text");
        circle.classList.add(getLuminance(settings.defaultColor) > 0.6 ? "dark-text" : "light-text");
    }

    const settingsRow = card.querySelector(".group-settings-row");
    if (settingsRow) {
        let html = "";
        if (settings.dayBright !== undefined) {
            html += `
                <span class="group-setting-item" title="Day Brightness & Duration">
                    <span class="material-icons-round">wb_sunny</span>
                    <span>${Math.round((settings.dayBright / 255) * 100)}% (${settings.dayTimeMin || 5}m)</span>
                </span>
            `;
        }
        if (settings.ambientMode) {
            html += `
                <span class="group-setting-item active" style="color: var(--accent);" title="Ambient Mode On">
                    <span class="material-icons-round">wb_twilight</span>
                    <span>On</span>
                </span>
            `;
        }
        if (settings.nightMode) {
            html += `
                <span class="group-setting-item" title="Night Mode Timings">
                    <span class="material-icons-round">nights_stay</span>
                    <span>${formatTime12h(settings.nightStart)} - ${formatTime12h(settings.nightEnd)}</span>
                </span>
            `;
        }
        settingsRow.innerHTML = html;
    }

    const label = card.querySelector(`#lastTap-${uid}`);
    if (label && !label.classList.contains("sending") && !label.classList.contains("sent")) {
        label.innerText = "Last Tap: " + formatLastTapDate(settings.lastTapTimestamp);
    }
}

function handleGroupTileTap(uid) {
    const state = backgroundMqttClients[uid];
    if (!state || !state.client || !state.client.connected) {
        alert("Not connected to this group's network.");
        return;
    }

    // Intercept if bonfire is active for this group: tapping the tile adds a log!
    if (state.bonfireActive) {
        handleGroupAddLog(uid);
        return;
    }

    const decoded = decodeUID(uid);
    if (!decoded) return;

    const myDeviceId = decoded.id.toUpperCase() === "B" ? "B" : "A";
    const partnerDeviceId = myDeviceId === "A" ? "B" : "A";
    const delim = decoded.d || "/";

    function getAccountTopic(devId, suffix) {
        if (delim === "_" && decoded.u) {
            const cleanSuffix = suffix.replace(/\//g, "_");
            return `${decoded.u}/f/ll_${devId}_${cleanSuffix}`;
        }
        return `linkedlamp/${devId}/${suffix}`;
    }

    const topic = getAccountTopic(partnerDeviceId, "color_trigger");

    let settings = { defaultColor: "#FF0000" };
    try {
        const saved = localStorage.getItem("ll_settings_" + uid);
        if (saved) settings = JSON.parse(saved);
    } catch (e) { }

    // Send the MQTT tap
    state.client.publish(topic, settings.defaultColor);
    console.log(`Background signal sent: ${settings.defaultColor} to ${topic}`);

    startGroupReadReceiptTracking(uid);
}

function startGroupReadReceiptTracking(uid) {
    const state = backgroundMqttClients[uid];
    if (!state) return;

    state.pendingReadReceipt = true;

    const label = document.querySelector(`#lastTap-${uid}`);
    if (label) {
        label.innerText = "Tap Sending...";
        label.className = "group-last-tap sending";
    }

    if (state.readReceiptTimeout) clearTimeout(state.readReceiptTimeout);
    state.readReceiptTimeout = setTimeout(() => {
        if (state.pendingReadReceipt) {
            state.pendingReadReceipt = false;
            resetGroupLastTapLabel(uid);
        }
    }, 5000);
}

function confirmGroupReadReceipt(uid) {
    const state = backgroundMqttClients[uid];
    if (!state) return;

    state.pendingReadReceipt = false;
    if (state.readReceiptTimeout) clearTimeout(state.readReceiptTimeout);

    const label = document.querySelector(`#lastTap-${uid}`);
    if (label) {
        label.innerText = "Tap Sent!";
        label.className = "group-last-tap sent";
    }

    setTimeout(() => {
        resetGroupLastTapLabel(uid);
    }, 4000);
}

function resetGroupLastTapLabel(uid) {
    const label = document.querySelector(`#lastTap-${uid}`);
    if (!label) return;

    label.className = "group-last-tap";

    let lastTapVal = "Unknown";
    try {
        const saved = localStorage.getItem("ll_settings_" + uid);
        if (saved) {
            const settings = JSON.parse(saved);
            lastTapVal = formatLastTapDate(settings.lastTapTimestamp);
        }
    } catch (e) { }
    label.innerText = "Last Tap: " + lastTapVal;
}

// Drag and drop reordering
function makeGroupCardsDraggable() {
    const list = document.getElementById("groupsList");
    const cards = list.querySelectorAll(".group-card");

    cards.forEach(card => {
        card.draggable = isGroupsEditMode;

        card.addEventListener("dragstart", (e) => {
            if (!isGroupsEditMode) {
                e.preventDefault();
                return;
            }
            e.dataTransfer.setData("text/plain", card.dataset.uid);
            card.classList.add("dragging");
        });

        card.addEventListener("dragend", () => {
            card.classList.remove("dragging");
        });

        card.addEventListener("dragover", (e) => {
            e.preventDefault();
            const draggingCard = list.querySelector(".dragging");
            if (!draggingCard) return;

            const siblings = [...list.querySelectorAll(".group-card:not(.dragging)")];

            let nextSibling = siblings.find(sibling => {
                const box = sibling.getBoundingClientRect();
                const offset = e.clientY - box.top - box.height / 2;
                return offset < 0;
            });

            list.insertBefore(draggingCard, nextSibling);
        });

        card.addEventListener("drop", (e) => {
            e.preventDefault();
            saveNewGroupsOrder();
        });
    });
}

// Mobile touch reordering
let touchDragEl = null;

function makeGroupCardsTouchDraggable() {
    const list = document.getElementById("groupsList");
    if (!list) return;

    list.addEventListener("touchstart", (e) => {
        if (!isGroupsEditMode) return;
        const card = e.target.closest(".group-card");
        if (!card) return;
        // Only reorder if dragging the drag handle
        if (!e.target.closest(".group-drag-handle")) return;

        touchDragEl = card;
        card.classList.add("dragging");
    }, { passive: true });

    list.addEventListener("touchmove", (e) => {
        if (!isGroupsEditMode || !touchDragEl) return;

        const touch = e.touches[0];
        const cards = [...list.querySelectorAll(".group-card:not(.dragging)")];

        let nextSibling = cards.find(sibling => {
            const box = sibling.getBoundingClientRect();
            return touch.clientY < box.top + box.height / 2;
        });

        list.insertBefore(touchDragEl, nextSibling);

        // Prevent scrolling while reordering
        e.preventDefault();
    }, { passive: false });

    list.addEventListener("touchend", () => {
        if (!touchDragEl) return;
        touchDragEl.classList.remove("dragging");
        touchDragEl = null;
        saveNewGroupsOrder();
    });
}

function saveNewGroupsOrder() {
    const list = document.getElementById("groupsList");
    const cards = [...list.querySelectorAll(".group-card")];
    const accounts = loadAccounts() || [];

    const newOrder = cards.map(card => {
        const uid = card.dataset.uid;
        return accounts.find(a => a.uid === uid);
    }).filter(Boolean);

    saveAccounts(newOrder);
    console.log("Groups reordered and saved:", newOrder);
}

function onScanFailure(error) {
    // html5-qrcode calls this on every frame that doesn't have a code.
    // We ignore it to let the scanner keep looking.
}

function handleGroupPresetTap(uid, preset, event) {
    if (event) event.stopPropagation();

    const state = backgroundMqttClients[uid];
    if (!state || !state.client || !state.client.connected) {
        alert("Not connected to this group's network.");
        return;
    }

    // Intercept if bonfire is active for this group: any preset tap adds a log!
    if (state.bonfireActive) {
        handleGroupAddLog(uid, event);
        return;
    }

    const decoded = decodeUID(uid);
    if (!decoded) return;

    const myDeviceId = decoded.id.toUpperCase() === "B" ? "B" : "A";
    const partnerDeviceId = myDeviceId === "A" ? "B" : "A";
    const delim = decoded.d || "/";

    function getAccountTopic(devId, suffix) {
        if (delim === "_" && decoded.u) {
            const cleanSuffix = suffix.replace(/\//g, "_");
            return `${decoded.u}/f/ll_${devId}_${cleanSuffix}`;
        }
        return `linkedlamp/${devId}/${suffix}`;
    }

    const topic = getAccountTopic(partnerDeviceId, "color_trigger");

    let payload = "";
    if (preset.type === 'cycle' && preset.colors) {
        const parts = preset.colors.map(c => {
            const hex = c.hex.replace('#', '');
            return `${hex},${c.hold},${c.trans}`;
        });
        payload = 'CC:' + parts.join(';');
    } else {
        payload = preset.color;
    }

    // Send preset payload
    state.client.publish(topic, payload);
    console.log(`Background preset signal sent: ${payload} to ${topic}`);

    startGroupReadReceiptTracking(uid);
}

function updateGroupTilePresets(uid, presetsList) {
    const card = document.querySelector(`.group-card[data-uid="${uid}"]`);
    if (!card) return;

    const container = card.querySelector(".group-presets-row");
    if (!container) return;

    const topPresets = (presetsList || []).slice(0, 2);
    if (topPresets.length === 0) {
        container.innerHTML = "";
        return;
    }

    container.innerHTML = topPresets.map(p => `
        <button class="action-btn secondary-btn group-preset-btn" style="flex: 1; display: inline-flex; align-items: center; justify-content: flex-start; padding: 10px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); color: var(--text); font-weight: 500; cursor: pointer; background: rgba(255,255,255,0.05); --preset-color: ${p.type === 'cycle' && p.colors && p.colors.length > 0 ? p.colors[0].hex : p.color};" onclick="handleGroupPresetTap('${uid}', ${JSON.stringify(p).replace(/"/g, '&quot;')}, event)">
            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; width: 100%;">${p.name}</span>
        </button>
    `).join('');
}

function saveNewPresetsOrder() {
    const grid = document.getElementById("presetsGrid");
    const buttons = [...grid.querySelectorAll(".preset-btn")];

    const newOrder = buttons.map(btn => {
        const id = btn.dataset.id;
        return presets.find(p => p.id === id);
    }).filter(Boolean);

    presets = newOrder;

    const activeUid = localStorage.getItem("ll_uid");
    if (activeUid) localStorage.setItem("ll_presets_" + activeUid, JSON.stringify(presets));
    localStorage.setItem("ll_presets_" + myDeviceId, JSON.stringify(presets));

    publishPresets();
}

function updateGroupTileName(uid, name) {
    const accounts = loadAccounts() || [];
    const idx = accounts.findIndex(a => a.uid === uid);
    if (idx >= 0 && accounts[idx].name !== name) {
        accounts[idx].name = name;
        saveAccounts(accounts);
    }

    const card = document.querySelector(`.group-card[data-uid="${uid}"]`);
    if (!card) return;

    let displayName = name;
    if (!displayName.toLowerCase().includes("lamp")) {
        displayName = `${displayName}'s Lamp`;
    }

    const title = card.querySelector(".group-title");
    if (title) title.innerText = displayName;

    // If this is the currently active account, keep ll_name root key updated
    const activeUid = localStorage.getItem("ll_uid");
    if (uid === activeUid) {
        localStorage.setItem("ll_name", name);
        partnerName = name;
        const sub = document.getElementById("signalSubtitle");
        if (sub) sub.innerText = "Tap to turn on " + name + "'s lamp";
    }
}

window.toggleDefaultGroup = function (uid, event) {
    if (event) event.stopPropagation();

    const currentDefault = localStorage.getItem("ll_default_landing_uid");
    if (currentDefault === uid) {
        localStorage.removeItem("ll_default_landing_uid");
        console.log("Unset default landing group.");
    } else {
        localStorage.setItem("ll_default_landing_uid", uid);
        console.log("Set default landing group to:", uid);
    }

    renderGroupsPage();
};

// =============================================================================
// Virtual Bonfire (Co-Presence Glow) Implementation
// =============================================================================

function getPartnerSettings() {
    if (cachedPartnerSettings) return cachedPartnerSettings;
    try {
        const saved = localStorage.getItem("ll_partner_settings_" + partnerDeviceId);
        if (saved) {
            cachedPartnerSettings = JSON.parse(saved);
            return cachedPartnerSettings;
        }
    } catch (e) { }
    return null;
}

/**
 * Checks whether a given lamp's settings currently put it in night mode.
 * Evaluates nightMode toggle, start/end times, and timezone.
 */
function isLampInNightMode(settings) {
    if (!settings || !settings.nightMode) return false;

    let tz = settings.timezone || "EST5EDT";
    const mappedTz = tzToIanaMap[tz] || tz;

    let nowMinutes;
    try {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: mappedTz,
            hour: "numeric",
            minute: "numeric",
            hour12: false
        });
        const parts = formatter.formatToParts(new Date());
        let h = 0, m = 0;
        for (const p of parts) {
            if (p.type === "hour") h = parseInt(p.value, 10);
            if (p.type === "minute") m = parseInt(p.value, 10);
        }
        if (h === 24) h = 0;
        nowMinutes = h * 60 + m;
    } catch (e) {
        const d = new Date();
        nowMinutes = d.getHours() * 60 + d.getMinutes();
    }

    const startParts = (settings.nightStart || "22:00").split(":");
    const endParts = (settings.nightEnd || "08:00").split(":");
    const startMinutes = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10);
    const endMinutes = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10);

    if (startMinutes <= endMinutes) {
        return (nowMinutes >= startMinutes && nowMinutes < endMinutes);
    } else {
        return (nowMinutes >= startMinutes || nowMinutes < endMinutes);
    }
}

let isIgnitingBonfire = false;

/**
 * Triggers the Virtual Bonfire action from the Connections view.
 */
function triggerBonfireConnection() {
    if (bonfireState.active) {
        setBonfireModeUI(true);
        return;
    }
    startBonfireIgnition();
}

/**
 * Runs pre-flight checks and starts ignition sequence for Virtual Bonfire.
 */
function startBonfireIgnition() {
    if (isIgnitingBonfire) return;

    if (!mqttClient || !mqttClient.connected) {
        showToast("Cannot light bonfire: MQTT is not connected.", "error");
        return;
    }

    // Pre-flight check 1: Both lamps must be online
    if (myLampOnline !== true) {
        showToast("Cannot light bonfire: Your lamp is currently offline.", "error");
        return;
    }
    if (partnerLampOnline !== true) {
        const pName = partnerName || "Partner";
        showToast(`Cannot light bonfire: ${pName}'s lamp is currently offline.`, "error");
        return;
    }

    // Pre-flight check 2: Neither lamp can be in night mode
    if (isLampInNightMode(mySettings)) {
        showToast("Cannot light bonfire: Your lamp is currently in Night Mode.", "error");
        return;
    }
    const partnerSet = getPartnerSettings();
    if (partnerSet && isLampInNightMode(partnerSet)) {
        const pName = partnerName || "Partner";
        showToast(`Cannot light bonfire: ${pName}'s lamp is currently in Night Mode.`, "error");
        return;
    }

    isIgnitingBonfire = true;
    let signalSent = false;
    const sendIgnitionSignal = () => {
        if (signalSent) return;
        signalSent = true;
        const nowSec = Math.floor(Date.now() / 1000);
        const payload = `ON:${nowSec}`;

        // Retained topic publish so lamps and reconnecting clients restore state
        mqttClient.publish(getTopic(myDeviceId, "bonfire"), payload, { retain: true, qos: 1 });
        mqttClient.publish(getTopic(partnerDeviceId, "bonfire"), payload, { retain: true, qos: 1 });

        // Direct triggers for zero-latency execution
        mqttClient.publish(getTopic(myDeviceId, "color_trigger"), "BONFIRE:START");
        mqttClient.publish(getTopic(partnerDeviceId, "color_trigger"), "BONFIRE:START");

        bonfireState.active = true;
        bonfireState.lastLogEpoch = nowSec * 1000;
    };

    // All checks passed! Play Zippo lighter animation
    playZippoLighterAnimation({
        onIgnite: () => {
            sendIgnitionSignal();
        },
        onComplete: () => {
            isIgnitingBonfire = false;
            sendIgnitionSignal();
            activateBonfire(bonfireState.lastLogEpoch || Date.now(), true);
            switchTab("partner");
        }
    });
}

/**
 * Handler for legacy/programmatic bonfire toggle calls.
 */
function handleBonfireToggle(checkbox) {
    if (!checkbox) return;
    if (checkbox.checked) {
        checkbox.checked = false;
        startBonfireIgnition();
    } else {
        checkbox.checked = true;
        handleExtinguishFromUI();
    }
}

function handleLightBonfireClick() {
    triggerBonfireConnection();
}

/**
 * Realistic full-screen Zippo Lighter animation sequence.
 * Perspective: Lighter starts close to the viewer (large foreground),
 * strikes flame, moves away towards the logs, ignites the kindling at the base,
 * and triggers onIgnite the exact moment fire catches.
 */
function playZippoLighterAnimation(callbacks) {
    const onIgnite = typeof callbacks === 'object' && callbacks ? callbacks.onIgnite : null;
    const onComplete = typeof callbacks === 'function' ? callbacks : (callbacks ? callbacks.onComplete : null);

    const overlay = document.getElementById("bonfireLighterOverlay");
    if (!overlay) {
        if (onIgnite) onIgnite();
        if (onComplete) onComplete();
        return;
    }

    const zippo = document.getElementById("zippoLighter");
    const lid = overlay.querySelector(".zippo-lid");
    const flintWheel = overlay.querySelector(".zippo-flint-wheel");
    const sparks = document.getElementById("zippoSparks");
    const flame = document.getElementById("zippoFlame");
    const hearthEruption = document.getElementById("hearthFireEruption");
    const kindlingSpark = document.getElementById("kindlingCatchSpark");

    // Reset initial state: close to viewer in foreground (scale 1.45)
    overlay.style.display = "flex";
    overlay.style.opacity = "1";
    if (zippo) zippo.className = "zippo-lighter";
    if (lid) lid.classList.remove("open");
    if (flintWheel) flintWheel.classList.remove("sparking");
    if (sparks) sparks.classList.remove("active");
    if (flame) flame.classList.remove("ignited");
    if (kindlingSpark) kindlingSpark.classList.remove("active");
    if (hearthEruption) hearthEruption.classList.remove("ignited");

    // Step 1: Open Zippo Lid close to viewer (400ms)
    setTimeout(() => {
        if (lid) lid.classList.add("open");
    }, 400);

    // Step 2: Spin Flint Wheel & Shower Sparks in foreground (800ms)
    setTimeout(() => {
        if (flintWheel) flintWheel.classList.add("sparking");
        if (sparks) sparks.classList.add("active");
    }, 800);

    // Step 3: Flame catches on wick right in front of you! (1200ms)
    setTimeout(() => {
        if (sparks) sparks.classList.remove("active");
        if (flame) flame.classList.add("ignited");
    }, 1200);

    // Step 4: Move Zippo away from you towards the logs at its base (1650ms)
    setTimeout(() => {
        if (zippo) zippo.classList.add("move-to-logs");
    }, 1650);

    // Step 5: Flame reaches and touches kindling at the base (2500ms)
    setTimeout(() => {
        if (kindlingSpark) kindlingSpark.classList.add("active");
    }, 2500);

    // Step 6: Logs catch fire at the base & erupt into flame! (2800ms)
    // Send the bonfire signal the exact moment the fire is actually lit!
    setTimeout(() => {
        if (hearthEruption) hearthEruption.classList.add("ignited");
        if (zippo) zippo.classList.add("retract");
        if (onIgnite) onIgnite();
    }, 2800);

    // Step 7: Fade Out & Complete (3600ms)
    setTimeout(() => {
        overlay.style.transition = "opacity 0.45s ease";
        overlay.style.opacity = "0";
    }, 3600);

    setTimeout(() => {
        overlay.style.display = "none";
        overlay.style.opacity = "1";
        overlay.style.transition = "";
        if (onComplete) onComplete();
    }, 4100);
}

let waterAnimFrameId = null;

/**
 * Realistic full-screen Water Bucket Extinguish animation sequence.
 * Renders physical cascading water pouring from the tilted bucket mouth,
 * falling under gravity directly into the campfire, splashing, quenching the flames,
 * and billowing white steam.
 */
function playWaterBucketAnimation(onComplete) {
    const overlay = document.getElementById("bonfireWaterOverlay");
    if (!overlay) {
        if (onComplete) onComplete();
        return;
    }

    const bucket = document.getElementById("waterBucket");
    const dyingFlames = document.getElementById("dyingFireFlames");
    const canvas = document.getElementById("waterPourCanvas");
    const ctx = canvas ? canvas.getContext("2d") : null;

    if (waterAnimFrameId) {
        cancelAnimationFrame(waterAnimFrameId);
        waterAnimFrameId = null;
    }

    // Reset initial state
    overlay.style.display = "flex";
    overlay.style.opacity = "1";
    if (bucket) bucket.className = "water-bucket";
    if (dyingFlames) dyingFlames.className = "dying-fire-flames";

    if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    const waterParticles = [];
    const splashParticles = [];
    const steamParticles = [];

    let isPouring = false;
    let waterHitFire = false;
    const animStartTime = Date.now();

    function renderWaterSim() {
        if (!ctx || !canvas) return;
        const now = Date.now();
        const elapsed = now - animStartTime;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 1. Spawn waterfall stream while bucket is tilted
        if (isPouring) {
            // Dynamically locate the pouring mouth of the bucket from its DOM rect
            const bucketEl = document.getElementById("waterBucket");
            const rimEl = bucketEl ? bucketEl.querySelector(".bucket-rim") : null;
            const stageEl = document.querySelector(".water-bucket-stage");

            let baseSpoutX = 176;
            let baseSpoutY = 160;
            if (rimEl && stageEl) {
                const rimRect = rimEl.getBoundingClientRect();
                const stageRect = stageEl.getBoundingClientRect();
                baseSpoutX = rimRect.left - stageRect.left + 5; // Pouring lip of tilted rim
                baseSpoutY = rimRect.bottom - stageRect.top - 2;
            }

            const count = 10;
            const logTargetY = 360; // Hearth fire logs impact line
            const ay = 0.52; // Gravity acceleration

            for (let i = 0; i < count; i++) {
                const px0 = baseSpoutX + (Math.random() - 0.5) * 8;
                const py0 = baseSpoutY + (Math.random() - 0.5) * 6;
                // Target the exact middle of the campfire logs (x = 160)
                const targetX = 160 + (Math.random() - 0.5) * 16;
                const dy = Math.max(10, logTargetY - py0);
                const vy0 = 1.8 + Math.random() * 2.0;

                // Time of flight to reach the logs under gravity
                const t = (-vy0 + Math.sqrt(vy0 * vy0 + 2 * ay * dy)) / ay;
                // Exact horizontal velocity to land dead-center on the logs
                const vx = (targetX - px0) / t;

                waterParticles.push({
                    x: px0,
                    y: py0,
                    vx: vx,
                    vy: vy0,
                    size: 3.5 + Math.random() * 3.5,
                    alpha: 0.8 + Math.random() * 0.2,
                    color: Math.random() > 0.4 ? '#93c5fd' : '#bfdbfe'
                });
            }
        }

        const logTargetY = 360; // Hearth fire logs impact line

        // Draw fluid stream body as a smooth curved water ribbon
        if (waterParticles.length > 6) {
            const sorted = waterParticles.slice().sort((a, b) => a.y - b.y);
            const spinePoints = [];
            const stepY = 22;
            let currentBucketY = sorted[0].y;
            let sumX = 0, countX = 0;
            for (const p of sorted) {
                if (p.y - currentBucketY < stepY) {
                    sumX += p.x;
                    countX++;
                } else {
                    if (countX > 0) spinePoints.push({ x: sumX / countX, y: currentBucketY + stepY / 2 });
                    currentBucketY = p.y;
                    sumX = p.x;
                    countX = 1;
                }
            }
            if (countX > 0) spinePoints.push({ x: sumX / countX, y: currentBucketY });

            if (spinePoints.length > 1) {
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(spinePoints[0].x, spinePoints[0].y);
                for (let i = 1; i < spinePoints.length; i++) {
                    const xc = (spinePoints[i - 1].x + spinePoints[i].x) / 2;
                    const yc = (spinePoints[i - 1].y + spinePoints[i].y) / 2;
                    ctx.quadraticCurveTo(spinePoints[i - 1].x, spinePoints[i - 1].y, xc, yc);
                }
                const last = spinePoints[spinePoints.length - 1];
                ctx.lineTo(last.x, last.y);

                // Outer fluid sheen
                ctx.strokeStyle = 'rgba(147, 197, 253, 0.45)';
                ctx.lineWidth = 18;
                ctx.lineCap = 'round';
                ctx.filter = 'blur(4px)';
                ctx.stroke();

                // Inner bright water core
                ctx.strokeStyle = 'rgba(219, 234, 254, 0.65)';
                ctx.lineWidth = 9;
                ctx.filter = 'blur(1.5px)';
                ctx.stroke();
                ctx.restore();
            }
        }

        // 2. Physics & Draw for falling water droplets
        for (let i = waterParticles.length - 1; i >= 0; i--) {
            const p = waterParticles[i];
            p.vy += 0.52; // Gravity acceleration
            p.x += p.vx;
            p.y += p.vy;

            // When water hits the fire/logs
            if (p.y >= logTargetY) {
                if (!waterHitFire && elapsed > 550) {
                    waterHitFire = true;
                    if (dyingFlames) dyingFlames.classList.add("quenched");
                }

                // Impact splash droplets erupting symmetrically around middle of the logs
                const splashNum = 2 + Math.floor(Math.random() * 3);
                for (let s = 0; s < splashNum; s++) {
                    splashParticles.push({
                        x: p.x,
                        y: logTargetY - 2,
                        vx: (Math.random() - 0.5) * 6.5,
                        vy: -Math.random() * 4.5 - 1.5,
                        size: 2.0 + Math.random() * 2.0,
                        alpha: 0.85,
                        life: 1.0,
                        decay: 0.045 + Math.random() * 0.04
                    });
                }

                // Rising steam puffs billowing right over the center of the hearth logs (x = 160)
                if (Math.random() < 0.65) {
                    steamParticles.push({
                        x: 160 + (Math.random() - 0.5) * 26,
                        y: logTargetY - 8,
                        vx: (Math.random() - 0.5) * 1.3,
                        vy: -1.6 - Math.random() * 2.2,
                        radius: 10 + Math.random() * 12,
                        maxRadius: 32 + Math.random() * 22,
                        alpha: 0.75,
                        decay: 0.015 + Math.random() * 0.012
                    });
                }

                waterParticles.splice(i, 1);
                continue;
            }

            // Draw falling droplet elongated along velocity vector
            ctx.fillStyle = p.color;
            ctx.globalAlpha = p.alpha;
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, p.size * 0.75, p.size * 1.5, Math.atan2(p.vy, p.vx), 0, Math.PI * 2);
            ctx.fill();
        }

        // 3. Update & Draw Splash Particles
        for (let i = splashParticles.length - 1; i >= 0; i--) {
            const sp = splashParticles[i];
            sp.vy += 0.42;
            sp.x += sp.vx;
            sp.y += sp.vy;
            sp.life -= sp.decay;

            if (sp.life <= 0) {
                splashParticles.splice(i, 1);
                continue;
            }

            ctx.fillStyle = '#dbeafe';
            ctx.globalAlpha = sp.alpha * sp.life;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, sp.size, 0, Math.PI * 2);
            ctx.fill();
        }

        // 4. Update & Draw Rising Steam Clouds centered directly over the fire
        for (let i = steamParticles.length - 1; i >= 0; i--) {
            const st = steamParticles[i];
            st.x += st.vx;
            st.y += st.vy;
            st.radius += 0.48;
            st.alpha -= st.decay;

            if (st.alpha <= 0 || st.y < 30) {
                steamParticles.splice(i, 1);
                continue;
            }

            const grad = ctx.createRadialGradient(st.x, st.y, 0, st.x, st.y, st.radius);
            grad.addColorStop(0, `rgba(245, 248, 255, ${st.alpha * 0.75})`);
            grad.addColorStop(0.5, `rgba(225, 235, 250, ${st.alpha * 0.45})`);
            grad.addColorStop(1, 'rgba(210, 225, 245, 0)');

            ctx.fillStyle = grad;
            ctx.globalAlpha = 1;
            ctx.beginPath();
            ctx.arc(st.x, st.y, st.radius, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.globalAlpha = 1;

        if (elapsed < 2700) {
            waterAnimFrameId = requestAnimationFrame(renderWaterSim);
        }
    }

    // Step 1: Bucket tilts to pour (300ms)
    setTimeout(() => {
        if (bucket) bucket.classList.add("pouring");
    }, 300);

    // Step 2: Water begins pouring out of the bucket mouth (500ms)
    setTimeout(() => {
        isPouring = true;
    }, 500);

    // Step 3: Bucket finishes pouring (1500ms)
    setTimeout(() => {
        isPouring = false;
    }, 1500);

    // Step 4: Fade out overlay (2300ms)
    setTimeout(() => {
        overlay.style.transition = "opacity 0.45s ease";
        overlay.style.opacity = "0";
    }, 2300);

    // Step 5: Complete & close (2800ms)
    setTimeout(() => {
        if (waterAnimFrameId) {
            cancelAnimationFrame(waterAnimFrameId);
            waterAnimFrameId = null;
        }
        overlay.style.display = "none";
        overlay.style.opacity = "1";
        overlay.style.transition = "";
        if (onComplete) onComplete();
    }, 2800);

    // Start simulation loop
    waterAnimFrameId = requestAnimationFrame(renderWaterSim);
}

/**
 * Activates Bonfire mode locally, transitioning the Send tab into the Bonfire tab.
 */
function activateBonfire(logEpochMs, isFlare = true) {
    bonfireState.active = true;
    bonfireState.lastLogEpoch = logEpochMs || Date.now();
    if (isFlare) {
        bonfireState.isFlaring = true;
        bonfireState.flareStartTime = Date.now();
    }

    const toggle = document.getElementById("bonfireToggle");
    if (toggle) toggle.checked = true;

    setBonfireModeUI(true);
    startBonfireCountdown();
    startBonfireCanvas();
}

/**
 * Deactivates Bonfire mode locally, restoring the Send tab.
 */
function deactivateBonfire() {
    bonfireState.active = false;
    bonfireState.isFlaring = false;
    bonfireState.lastLogEpoch = 0;

    const toggle = document.getElementById("bonfireToggle");
    if (toggle) toggle.checked = false;

    stopBonfireCountdown();
    stopBonfireCanvas();
    setBonfireModeUI(false);
    setDashboardSignalsMode('signals');
}

/**
 * Switches the primary Partner View between Send mode and Bonfire mode.
 */
function setBonfireModeUI(isActive) {
    const sendContainer = document.getElementById("partnerSendContainer");
    const bonfireContainer = document.getElementById("partnerBonfireContainer");
    const navSend = document.getElementById("navSend");
    const pageTitle = document.getElementById("pageTitle");

    if (isActive) {
        if (sendContainer) sendContainer.style.display = "none";
        if (bonfireContainer) bonfireContainer.style.display = "flex";

        if (navSend) {
            navSend.classList.add("bonfire-active");
            const icon = navSend.querySelector(".material-icons-round");
            const label = navSend.querySelector("span:not(.material-icons-round)");
            if (icon) icon.innerText = "local_fire_department";
            if (label) label.innerText = "Bonfire";
        }
        if (pageTitle && document.getElementById("view-partner").classList.contains("active")) {
            pageTitle.innerText = "Virtual Bonfire";
        }
    } else {
        if (bonfireContainer) bonfireContainer.style.display = "none";
        if (sendContainer) sendContainer.style.display = "block";

        if (navSend) {
            navSend.classList.remove("bonfire-active");
            const icon = navSend.querySelector(".material-icons-round");
            const label = navSend.querySelector("span:not(.material-icons-round)");
            if (icon) icon.innerText = "send";
            if (label) label.innerText = "Send";
        }
        if (pageTitle && document.getElementById("view-partner").classList.contains("active")) {
            pageTitle.innerText = "My Group";
        }
    }

    // Refresh groups page in case it's currently rendered
    if (document.getElementById("view-groups") && document.getElementById("view-groups").classList.contains("active")) {
        renderGroupsPage();
    }
}

/**
 * Countdown timer loop (updates every second).
 */
function startBonfireCountdown() {
    stopBonfireCountdown();
    updateBonfireTimerUI();
    bonfireCountdownInterval = setInterval(updateBonfireTimerUI, 1000);
}

function stopBonfireCountdown() {
    if (bonfireCountdownInterval) {
        clearInterval(bonfireCountdownInterval);
        bonfireCountdownInterval = null;
    }
}

function updateBonfireTimerUI() {
    if (!bonfireState.active || bonfireState.lastLogEpoch === 0) return;

    const now = Date.now();
    const elapsedMs = now - bonfireState.lastLogEpoch;
    const elapsedMinutes = elapsedMs / 60000.0;
    const totalDurationMs = 60 * 60 * 1000;
    const remainingMs = Math.max(0, totalDurationMs - elapsedMs);

    // Check timeout: 60 minutes with no log added
    if (remainingMs <= 0) {
        deactivateBonfire();
        return;
    }

    // Format remaining time MM:SS
    const totalSec = Math.floor(remainingMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const timeStr = `${m}:${s < 10 ? '0' : ''}${s}`;

    const timerEl = document.getElementById("bonfireTimerText");
    if (timerEl) timerEl.innerText = `Fire dies in ${timeStr}`;

    // Stage text
    const stageBadge = document.getElementById("bonfireStageBadge");
    if (stageBadge) {
        if (bonfireState.isFlaring) {
            stageBadge.innerText = "Flaring strong";
            stageBadge.style.color = "#ffd166";
        } else if (elapsedMinutes <= 30) {
            stageBadge.innerText = "Roaring strong";
            stageBadge.style.color = "var(--accent)";
        } else {
            const dyingFraction = (elapsedMinutes - 30.0) / 30.0;
            const remainingPerceived = Math.max(0, Math.round((1.0 - dyingFraction) * 75));
            stageBadge.innerText = `Dying down (${remainingPerceived}%)`;
            stageBadge.style.color = "var(--text-dim)";
        }
    }

    // Subheading with partner name
    const subheading = document.getElementById("bonfireSubheading");
    if (subheading) {
        subheading.innerText = `Co-presence glow synchronized with ${partnerName || 'your partner'}.`;
    }
}

/**
 * Procedural Organic Canvas Fire Simulation matching lamp flame brightness.
 */
let flameParticles = [];
let emberSparks = [];

function startBonfireCanvas() {
    stopBonfireCanvas();
    const canvas = document.getElementById("bonfireCanvas");
    if (!canvas) return;

    flameParticles = [];
    emberSparks = [];

    const ctx = canvas.getContext("2d");

    function renderLoop() {
        renderBonfireCanvasFrame(canvas, ctx);
        bonfireCanvasAnimId = requestAnimationFrame(renderLoop);
    }
    bonfireCanvasAnimId = requestAnimationFrame(renderLoop);
}

function stopBonfireCanvas() {
    if (bonfireCanvasAnimId) {
        cancelAnimationFrame(bonfireCanvasAnimId);
        bonfireCanvasAnimId = null;
    }
    flameParticles = [];
    emberSparks = [];
}

function renderBonfireCanvasFrame(canvas, ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!bonfireState.active || bonfireState.lastLogEpoch === 0) return;

    const now = Date.now();
    const elapsedMinutes = (now - bonfireState.lastLogEpoch) / 60000.0;

    // Calculate current perceived intensity I matching lamp firmware
    let intensity = 0.75;
    if (bonfireState.isFlaring) {
        const flareSec = (now - bonfireState.flareStartTime) / 1000.0;
        if (flareSec < 15.0) {
            intensity = 1.0 - (flareSec / 15.0) * 0.25;
        } else {
            bonfireState.isFlaring = false;
            intensity = 0.75;
        }
    } else if (elapsedMinutes > 30.0) {
        const dyingFraction = (elapsedMinutes - 30.0) / 30.0;
        intensity = Math.max(0.01, 0.75 * (1.0 - dyingFraction));
    }

    // Origin of fire hearth
    const originX = canvas.width / 2;
    const originY = canvas.height - 24;

    // Spawn new flame particles based on intensity
    const spawnRate = Math.floor(4 * (intensity / 0.75));
    for (let i = 0; i < spawnRate; i++) {
        flameParticles.push({
            x: originX + (Math.random() - 0.5) * 60,
            y: originY + (Math.random() - 0.5) * 8,
            vx: (Math.random() - 0.5) * 0.8,
            vy: -(1.8 + Math.random() * 2.8) * (intensity / 0.75),
            size: (16 + Math.random() * 20) * (intensity / 0.75),
            maxLife: 35 + Math.random() * 25,
            life: 0,
            heat: 1.0
        });
    }

    // Spawn occasional rising ember sparks
    if (Math.random() < 0.35 * (intensity / 0.75)) {
        emberSparks.push({
            x: originX + (Math.random() - 0.5) * 50,
            y: originY - 10,
            vx: (Math.random() - 0.5) * 1.5,
            vy: -(2.5 + Math.random() * 3.5),
            size: 1.5 + Math.random() * 2.5,
            life: 0,
            maxLife: 45 + Math.random() * 40,
            driftFreq: 0.05 + Math.random() * 0.08
        });
    }

    // Draw flame particles with additive blending
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (let i = flameParticles.length - 1; i >= 0; i--) {
        const p = flameParticles[i];
        p.life++;
        p.x += p.vx + Math.sin(p.life * 0.1) * 0.4;
        p.y += p.vy;
        p.size *= 0.96;

        const progress = p.life / p.maxLife;
        if (progress >= 1.0 || p.size < 1.0) {
            flameParticles.splice(i, 1);
            continue;
        }

        // Color shift from hot core to outer flame mantle
        let r = 255, g = 100, b = 20, alpha = (1.0 - progress) * 0.8;
        if (progress < 0.25) {
            // White-gold core
            r = 255;
            g = Math.floor(220 * intensity);
            b = Math.floor(100 * intensity);
        } else if (progress < 0.65) {
            // Vibrant orange
            r = 255;
            g = Math.floor(120 * intensity);
            b = 10;
        } else {
            // Deep crimson amber
            r = Math.floor(200 * intensity);
            g = Math.floor(40 * intensity);
            b = 0;
        }

        const rad = Math.max(1, p.size);
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`);
        grad.addColorStop(0.6, `rgba(${r}, ${Math.floor(g * 0.6)}, 0, ${alpha * 0.5})`);
        grad.addColorStop(1, `rgba(${r}, 0, 0, 0)`);

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fill();
    }

    // Draw rising ember sparks
    for (let i = emberSparks.length - 1; i >= 0; i--) {
        const s = emberSparks[i];
        s.life++;
        s.x += s.vx + Math.sin(s.life * s.driftFreq) * 0.8;
        s.y += s.vy;

        const progress = s.life / s.maxLife;
        if (progress >= 1.0) {
            emberSparks.splice(i, 1);
            continue;
        }

        const alpha = (1.0 - progress);
        ctx.fillStyle = `rgba(255, ${Math.floor(200 + Math.random() * 55)}, 60, ${alpha})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.restore();
}

/**
 * Action: User clicks "Add Log" in Bonfire tab.
 * Does NOT update lastTapTimestamp. Spikes fire to 100% flare.
 */
function handleAddLogFromUI() {
    if (!mqttClient || !mqttClient.connected) {
        showToast("Cannot add log: Not connected to lamp network.", "error");
        return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const payload = `ON:${nowSec}`;

    // Retained state topic
    mqttClient.publish(getTopic(myDeviceId, "bonfire"), payload, { retain: true, qos: 1 });
    mqttClient.publish(getTopic(partnerDeviceId, "bonfire"), payload, { retain: true, qos: 1 });

    // Direct log trigger command
    mqttClient.publish(getTopic(myDeviceId, "color_trigger"), "BONFIRE:LOG");
    mqttClient.publish(getTopic(partnerDeviceId, "color_trigger"), "BONFIRE:LOG");

    // Local flare spike
    bonfireState.active = true;
    bonfireState.lastLogEpoch = nowSec * 1000;
    bonfireState.isFlaring = true;
    bonfireState.flareStartTime = Date.now();

    updateBonfireTimerUI();
    showToast("Added a log to the fire. Flames roaring strong.");
}

/**
 * Action: User clicks "Put Out Fire" in Bonfire tab.
 * Plays the full-screen Water Bucket animation and extinguishes fire.
 */
function handleExtinguishFromUI() {
    playWaterBucketAnimation(() => {
        if (mqttClient && mqttClient.connected) {
            mqttClient.publish(getTopic(myDeviceId, "bonfire"), "OFF", { retain: true, qos: 1 });
            mqttClient.publish(getTopic(partnerDeviceId, "bonfire"), "OFF", { retain: true, qos: 1 });
            mqttClient.publish(getTopic(myDeviceId, "color_trigger"), "BONFIRE:STOP");
            mqttClient.publish(getTopic(partnerDeviceId, "color_trigger"), "BONFIRE:STOP");
        }
        deactivateBonfire();
    });
}

/**
 * Remote or Retained Bonfire message handler on the primary MQTT connection.
 */
function handleIncomingBonfireMessage(msg) {
    if (msg.startsWith("ON:")) {
        const epochSec = parseInt(msg.substring(3), 10);
        if (isNaN(epochSec) || epochSec <= 0) return;

        const epochMs = epochSec * 1000;
        const elapsedMs = Date.now() - epochMs;

        // If retained message is older than 60 minutes, clean it up
        if (elapsedMs >= 60 * 60 * 1000) {
            console.log("Incoming retained bonfire is older than 60m — extinguishing.");
            if (mqttClient && mqttClient.connected) {
                mqttClient.publish(getTopic(myDeviceId, "bonfire"), "OFF", { retain: true, qos: 1 });
            }
            if (bonfireState.active) deactivateBonfire();
            return;
        }

        // Active bonfire!
        if (!bonfireState.active) {
            activateBonfire(epochMs, false);
        } else {
            // Log was added remotely
            bonfireState.lastLogEpoch = epochMs;
            bonfireState.isFlaring = true;
            bonfireState.flareStartTime = Date.now();
            updateBonfireTimerUI();
        }
    } else if (msg === "OFF" || msg.startsWith("OFF:")) {
        if (bonfireState.active) {
            deactivateBonfire();
        }
    }
}

/**
 * Groups Page Actions & Synchronization
 */
function handleGroupBonfireTap(uid) {
    handleGroupAddLog(uid);
}

function handleGroupAddLog(uid, event) {
    if (event) event.stopPropagation();

    // If this is currently the active account, route through primary handler
    const activeUid = localStorage.getItem("ll_uid");
    if (uid === activeUid) {
        handleAddLogFromUI();
        return;
    }

    const state = backgroundMqttClients[uid];
    if (!state || !state.client || !state.client.connected) {
        showToast("Not connected to this group's lamp network.", "error");
        return;
    }

    const decoded = decodeUID(uid);
    if (!decoded) return;

    const myDevId = decoded.id.toUpperCase() === "B" ? "B" : "A";
    const partnerDevId = myDevId === "A" ? "B" : "A";
    const delim = decoded.d || "/";

    function getAccTopic(devId, suffix) {
        if (delim === "_" && decoded.u) {
            const cleanSuffix = suffix.replace(/\//g, "_");
            return `${decoded.u}/f/ll_${devId}_${cleanSuffix}`;
        }
        return `linkedlamp/${devId}/${suffix}`;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const payload = `ON:${nowSec}`;

    state.client.publish(getAccTopic(myDevId, "bonfire"), payload, { retain: true, qos: 1 });
    state.client.publish(getAccTopic(partnerDevId, "bonfire"), payload, { retain: true, qos: 1 });
    state.client.publish(getAccTopic(myDevId, "color_trigger"), "BONFIRE:LOG");
    state.client.publish(getAccTopic(partnerDevId, "color_trigger"), "BONFIRE:LOG");

    state.bonfireActive = true;
    state.lastBonfireLogEpoch = nowSec * 1000;

    showToast("Added a log to the fire.");
}

function handleGroupExtinguish(uid, event) {
    if (event) event.stopPropagation();

    // Trigger full-screen water bucket animation
    playWaterBucketAnimation(() => {
        const activeUid = localStorage.getItem("ll_uid");
        if (uid === activeUid) {
            if (mqttClient && mqttClient.connected) {
                mqttClient.publish(getTopic(myDeviceId, "bonfire"), "OFF", { retain: true, qos: 1 });
                mqttClient.publish(getTopic(partnerDeviceId, "bonfire"), "OFF", { retain: true, qos: 1 });
                mqttClient.publish(getTopic(myDeviceId, "color_trigger"), "BONFIRE:STOP");
                mqttClient.publish(getTopic(partnerDeviceId, "color_trigger"), "BONFIRE:STOP");
            }
            deactivateBonfire();
        } else {
            const state = backgroundMqttClients[uid];
            if (state && state.client && state.client.connected) {
                const decoded = decodeUID(uid);
                if (decoded) {
                    const myDevId = decoded.id.toUpperCase() === "B" ? "B" : "A";
                    const partnerDevId = myDevId === "A" ? "B" : "A";
                    const delim = decoded.d || "/";
                    function getAccTopic(devId, suffix) {
                        if (delim === "_" && decoded.u) {
                            return `${decoded.u}/f/ll_${devId}_${suffix.replace(/\//g, "_")}`;
                        }
                        return `linkedlamp/${devId}/${suffix}`;
                    }
                    state.client.publish(getAccTopic(myDevId, "bonfire"), "OFF", { retain: true, qos: 1 });
                    state.client.publish(getAccTopic(partnerDevId, "bonfire"), "OFF", { retain: true, qos: 1 });
                    state.client.publish(getAccTopic(myDevId, "color_trigger"), "BONFIRE:STOP");
                    state.client.publish(getAccTopic(partnerDevId, "color_trigger"), "BONFIRE:STOP");
                }
                state.bonfireActive = false;
            }
        }
        renderGroupsPage();
    });
}

function handleGroupIncomingBonfireMessage(uid, msg) {
    const state = backgroundMqttClients[uid];
    if (!state) return;

    if (msg.startsWith("ON:")) {
        const epochSec = parseInt(msg.substring(3), 10);
        if (!isNaN(epochSec) && epochSec > 0) {
            const elapsed = Date.now() - (epochSec * 1000);
            if (elapsed < 60 * 60 * 1000) {
                state.bonfireActive = true;
                state.lastBonfireLogEpoch = epochSec * 1000;
            } else {
                state.bonfireActive = false;
            }
        }
    } else if (msg === "OFF" || msg.startsWith("OFF:")) {
        state.bonfireActive = false;
    }

    // If groups view is currently active, re-render
    if (document.getElementById("view-groups") && document.getElementById("view-groups").classList.contains("active")) {
        renderGroupsPage();
    }
}

/**
 * Toast Notification Utility
 */
function showToast(message, type = "info") {
    let toast = document.getElementById("appToast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "appToast";
        toast.style.position = "fixed";
        toast.style.bottom = "85px";
        toast.style.left = "50%";
        toast.style.transform = "translateX(-50%) translateY(20px)";
        toast.style.background = "rgba(18, 20, 30, 0.95)";
        toast.style.color = "#ffffff";
        toast.style.padding = "10px 18px";
        toast.style.borderRadius = "12px";
        toast.style.border = "1px solid rgba(255, 255, 255, 0.15)";
        toast.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.6)";
        toast.style.backdropFilter = "blur(10px)";
        toast.style.webkitBackdropFilter = "blur(10px)";
        toast.style.fontFamily = "var(--font)";
        toast.style.fontSize = "0.88rem";
        toast.style.fontWeight = "500";
        toast.style.zIndex = "999999";
        toast.style.pointerEvents = "none";
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.25s ease, transform 0.25s ease";
        document.body.appendChild(toast);
    }

    if (type === "error") {
        toast.style.borderColor = "rgba(255, 71, 87, 0.5)";
        toast.style.color = "#ff6b81";
    } else {
        toast.style.borderColor = "rgba(255, 152, 0, 0.4)";
        toast.style.color = "#ffffff";
    }

    toast.innerText = message;
    toast.style.opacity = "1";
    toast.style.transform = "translateX(-50%) translateY(0)";

    if (window._toastTimer) clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(-50%) translateY(20px)";
    }, 3200);
}


