/**
 * Linked Lamp — Browser Flasher Module
 * * Uses esptool-js and Web Serial API to flash ESP32 directly from the browser.
 * Handles fetching binaries, patching the LittleFS image with custom config, 
 * and flashing all partitions in one operation.
 * * Requires: Chrome 89+ or Edge 89+ (Web Serial API support)
 * * License: GNU GPLv3
 */

// Flash memory offsets for ESP32 (from min_spiffs.csv partition table)
const FLASH_OFFSETS = {
    BOOTLOADER: 0x1000,
    PARTITIONS: 0x8000,
    BOOT_APP0: 0xE000,
    FIRMWARE: 0x10000,
    LITTLEFS: 0x3D0000,
};

// Binary asset locations
const BINARY_BASE = "flash/";
const BINARY_FILES = {
    bootloader: BINARY_BASE + "bootloader.bin",
    partitions: BINARY_BASE + "partitions.bin",
    boot_app0: BINARY_BASE + "boot_app0.bin",
    firmware_pcb: BINARY_BASE + "firmware.bin",
    firmware_neopixel: BINARY_BASE + "firmware-neo.bin",
    littlefs: BINARY_BASE + "littlefs_template.bin",
};

// LittleFS partition size (from min_spiffs.csv: 0x20000 = 128KB)
const LITTLEFS_PARTITION_SIZE = 0x20000;

function isWebSerialSupported() {
    return "serial" in navigator;
}

async function fetchBinary(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
}

function generateConfigJSON(deviceId, mqttServer, mqttPort, mqttUser, mqttPass, ownerName, delimiter) {
    const config = {
        device_id: deviceId,
        mqtt_server: mqttServer,
        mqtt_port: mqttPort || 8883,
        mqtt_user: mqttUser,
        mqtt_pass: mqttPass,
        delimeter: delimiter || "/",
        ota_url: "https://www.linkedlamp.com"
    };
    if (ownerName) config.owner_name = ownerName;
    return JSON.stringify(config, null, 2);
}

async function flashESP32(config, onLog, onProgress) {
    if (!isWebSerialSupported()) {
        throw new Error("Web Serial API is not supported in this browser.");
    }

    onLog("Requesting serial port...");
    let port;
    try {
        port = await navigator.serial.requestPort();
    } catch (e) {
        throw new Error("No serial port selected. Please connect your ESP32 and try again.");
    }

    onLog("Loading esptool-js...");

    const esptoolMod = await import("https://unpkg.com/esptool-js@0.4.5/bundle.js");
    const ESPLoader = esptoolMod.ESPLoader;
    const Transport = esptoolMod.Transport;

    const fwVersion = (typeof window !== "undefined" && window.LINKED_LAMP_VERSIONS && window.LINKED_LAMP_VERSIONS.stable) ? ` v${window.LINKED_LAMP_VERSIONS.stable}` : "";

    onLog(`Fetching firmware${fwVersion} binaries...`);
    onProgress(5);

    const firmwareUrl = (config.hwType === "neopixel") ? BINARY_FILES.firmware_neopixel : BINARY_FILES.firmware_pcb;

    const [bootloader, partitions, bootApp0, firmware] = await Promise.all([
        fetchBinary(BINARY_FILES.bootloader),
        fetchBinary(BINARY_FILES.partitions),
        fetchBinary(BINARY_FILES.boot_app0),
        fetchBinary(firmwareUrl),
    ]);

    // Bootloader binary patch: overrides esptool-js defaults to force DIO/40MHz
    
    
    const patchHeader = (bin) => {
        if (bin.length > 4 && bin[0] === 0xE9) {
            bin[2] = 0x02;
            bin[3] = 0x20;
        }
    };
    patchHeader(bootloader);
    patchHeader(firmware);

    onProgress(15);
    onLog("Connecting to ESP32...");

    const espTerminal = {
        clean() { },
        writeLine(data) { onLog(data); },
        write(data) { },
    };

    const transport = new Transport(port, true);
    const loader = new ESPLoader({
        transport,
        baudrate: 115200,
        romBaudrate: 115200,
        terminal: espTerminal,
    });

    // Enhanced auto-reset timing:
    // Standard esptool-js releases GPIO0 after only 50ms (W50). On clone ESP32 boards
    // with a 1uF-10uF capacitor on EN, the EN line takes 80-150ms to rise, causing
    // the chip to miss bootloader mode unless the physical BOOT button is held down.
    // Extending GPIO0 hold time to 400ms-600ms allows EN to rise cleanly into bootloader mode.
    if (typeof loader._connectAttempt === "function") {
        const originalConnectAttempt = loader._connectAttempt.bind(loader);
        loader._connectAttempt = async function (mode, isRetry) {
            if (mode !== "no_reset") {
                try {
                    await transport.setDTR(false);
                    await transport.setRTS(true);
                    await sleep(150);
                    await transport.setDTR(true);
                    await transport.setRTS(false);
                    await sleep(isRetry ? 600 : 400); // Extended hold time
                    await transport.setDTR(false);
                } catch (e) { }
                return await originalConnectAttempt("no_reset", isRetry);
            }
            return await originalConnectAttempt(mode, isRetry);
        };
    }

    try {
        let chipType;
        try {
            chipType = await loader.main();
        } catch (connErr) {
            // Provide clear guidance if an auto-reset circuit is physically missing on the board
            onLog("⚠ Connection failed. If your board does not have an auto-reset circuit, press and hold the BOOT button while flashing.");
            throw connErr;
        }

        onLog(`Connected! Chip: ${chipType || "ESP32"}`);
        onProgress(20);

        onLog(`Flashing firmware${fwVersion} (no LittleFS — config sent via Serial after boot)...`);
        onProgress(25);

        const fileArray = [
            { data: binaryToString(bootloader), address: FLASH_OFFSETS.BOOTLOADER },
            { data: binaryToString(partitions), address: FLASH_OFFSETS.PARTITIONS },
            { data: binaryToString(bootApp0), address: FLASH_OFFSETS.BOOT_APP0 },
            { data: binaryToString(firmware), address: FLASH_OFFSETS.FIRMWARE },
        ];

        const totalSize = bootloader.length + partitions.length + bootApp0.length + firmware.length;
        onLog(`Total flash size: ${(totalSize / 1024).toFixed(1)} KB`);

        await loader.writeFlash({
            fileArray,
            flashSize: "4MB",
            flashMode: "keep",
            flashFreq: "40m",
            eraseAll: false,
            compress: true,
            reportProgress: (fileIdx, written, total) => {
                const pct = 25 + ((written / total) * 55);
                onProgress(Math.round(pct));
            },
        });

        onProgress(80);
        onLog(`Firmware${fwVersion} flashed successfully! Resetting ESP32...`);
        await loader.hardReset();

    } finally {
        await transport.disconnect();
    }

    onLog("Waiting for ESP32 to boot and request config...");
    onProgress(82);

    await sleep(1000);
    await port.open({ baudRate: 115200 });

    const configJson = generateConfigJSON(
        config.deviceId,
        config.mqttServer,
        config.mqttPort,
        config.mqttUser,
        config.mqttPass,
        config.ownerName,
        config.delimiter
    );

    try {
        const reader = port.readable.getReader();
        const writer = port.writable.getWriter();
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        let isReading = true;
        let readBuffer = "";
        const allReceivedLines = [];
        const lineListeners = new Set();

        const readLoop = (async () => {
            while (isReading) {
                try {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value) {
                        readBuffer += decoder.decode(value, { stream: true });
                        const lines = readBuffer.split("\n");
                        readBuffer = lines.pop();
                        for (const rawLine of lines) {
                            const trimmed = rawLine.trim();
                            if (trimmed) {
                                onLog("ESP32: " + trimmed);
                                allReceivedLines.push(trimmed);
                                for (const listener of lineListeners) {
                                    listener(trimmed);
                                }
                            }
                        }
                    }
                } catch (e) {
                    break;
                }
            }
        })();

        const writeLine = async (line) => {
            await writer.write(encoder.encode(line + "\n"));
        };

        const waitForLine = (predicate, timeoutMs, startIndex = 0) => {
            return new Promise((resolve) => {
                for (let i = startIndex; i < allReceivedLines.length; i++) {
                    if (predicate(allReceivedLines[i])) {
                        resolve(allReceivedLines[i]);
                        return;
                    }
                }

                let timer = null;
                const listener = (line) => {
                    if (predicate(line)) {
                        cleanup();
                        resolve(line);
                    }
                };

                const cleanup = () => {
                    if (timer) clearTimeout(timer);
                    lineListeners.delete(listener);
                };

                timer = setTimeout(() => {
                    cleanup();
                    resolve(null);
                }, timeoutMs);

                lineListeners.add(listener);
            });
        };

        const restartLamp = async () => {
            onLog("Restarting lamp (maintaining connection)...");
            // 1. Software reboot command in case firmware is already running
            try {
                await writeLine("REBOOT");
            } catch (e) { }

            // 2. Hardware reset via DTR/RTS signals (standard ESP32 auto-reset circuit)
            try {
                await port.setSignals({ dataTerminalReady: false, requestToSend: true });
                await sleep(150);
                await port.setSignals({ dataTerminalReady: false, requestToSend: false });
            } catch (sigErr) {
                onLog("Note: DTR/RTS signal reset not supported on this port: " + sigErr.message);
            }
        };

        onProgress(85);
        let configSaved = false;
        let configSent = false;
        const compactJson = JSON.stringify(JSON.parse(configJson));

        // Step 1: Check if ESP32 directly requests config (SEND_CONFIG) within 5 seconds
        let directRequest = await waitForLine(
            line => line.includes("SEND_CONFIG"),
            5000,
            0
        );

        if (directRequest) {
            onLog("ESP32 directly requested config (SEND_CONFIG). Sending config...");
            onProgress(90);
            const sendIdx = allReceivedLines.length;
            await writeLine(compactJson);
            configSent = true;

            const saveConfirmation = await waitForLine(
                line => line.includes("CONFIG_SAVED") || line.includes("Config received and saved") || line.includes("MQTT Server:"),
                8000,
                sendIdx
            );

            if (saveConfirmation) {
                configSaved = true;
            }
        }

        // Step 2: If config was not directly requested / saved, restart lamp and recover
        if (!configSaved) {
            onLog("ESP32 did not directly request config. Restarting lamp (maintaining connection)...");
            const restartIdx = allReceivedLines.length;
            await restartLamp();

            // Step 3: Make sure the lamp has re-powered on with the correct software
            onLog("Waiting for lamp to re-power on and verifying software...");
            let bootBannerLine = await waitForLine(
                line => line.includes("Linked Lamp Firmware") || line.includes("[VERSION]"),
                4000,
                restartIdx
            );

            if (!bootBannerLine) {
                // Probe device using GET_VERSION in case boot output was printed before reader caught it
                try {
                    await writeLine("GET_VERSION");
                } catch (e) { }

                bootBannerLine = await waitForLine(
                    line => line.includes("Linked Lamp Firmware") || line.includes("[VERSION]"),
                    3000,
                    restartIdx
                );
            }

            if (bootBannerLine) {
                onLog(`✓ Confirmed: Lamp re-powered on with correct software (${bootBannerLine})`);
            } else {
                onLog("Note: Lamp restart triggered, proceeding with config transmission...");
            }

            // Step 4: Check if configs are directly requested after restart
            let rebootDirectRequest = await waitForLine(
                line => line.includes("SEND_CONFIG"),
                3000,
                restartIdx
            );

            if (rebootDirectRequest) {
                onLog("ESP32 directly requested config after restart. Sending config...");
                onProgress(90);
                const sendIdx = allReceivedLines.length;
                await writeLine(compactJson);
                configSent = true;

                const saveConf = await waitForLine(
                    line => line.includes("CONFIG_SAVED") || line.includes("Config received and saved") || line.includes("MQTT Server:"),
                    8000,
                    sendIdx
                );
                if (saveConf) {
                    configSaved = true;
                }
            } else {
                // Step 5: Send config using the send_config command if configs aren't directly requested
                onLog("Configs were not directly requested. Sending config using command...");
                onProgress(90);
                const cmdIdx = allReceivedLines.length;

                // NOTE: The firmware's serial command listener only starts at the END of setup()
                // (after the WiFi connect attempt), so the command may sit in the UART buffer for
                // several seconds before it is processed. Use generous confirmation windows.
                // Only match lines that prove the file was written ("MQTT Server:" is also printed
                // on boot from the OLD config, so it is not a reliable confirmation here).
                const isCmdConfirmation = line => line.includes("CONFIG_SAVED") || line.includes("Config saved to /config.json");

                // Send SET_CONFIG: (supported by both existing and updated firmware)
                await writeLine("SET_CONFIG:" + compactJson);
                configSent = true;

                let cmdConf = await waitForLine(isCmdConfirmation, 12000, cmdIdx);

                if (!cmdConf) {
                    // Fallback attempt: try SEND_CONFIG: prefix
                    onLog("Retrying with SEND_CONFIG command...");
                    const retryIdx = allReceivedLines.length;
                    await writeLine("SEND_CONFIG:" + compactJson);
                    cmdConf = await waitForLine(isCmdConfirmation, 10000, retryIdx);
                }

                // Step 6: If the configs are sent over send config, make sure they are correctly sent before showing the 100%
                // CONFIG_SAVED is only printed after the file write succeeds, so a confirmation is
                // authoritative even if an earlier attempt reported an error.
                if (cmdConf) {
                    onLog(`✓ Config correctly sent and confirmed by ESP32 (${cmdConf}).`);
                    configSaved = true;
                } else if (allReceivedLines.slice(cmdIdx).some(l => l.includes("[CMD] ERROR:"))) {
                    onLog("✗ Error reported by ESP32 while saving config.");
                }
            }
        }

        // Cleanup stream reader and writer cleanly
        isReading = false;
        try { await reader.cancel(); } catch (e) { }
        try { await readLoop; } catch (e) { }
        try { reader.releaseLock(); } catch (e) { }
        try { writer.releaseLock(); } catch (e) { }

        if (configSaved) {
            onProgress(100);
            onLog("✓ Done! Firmware flashed and config saved successfully.");
        } else {
            onProgress(85);
            onLog("✗ Config could not be verified on the ESP32.");
            onLog("⚠ If your board has no auto-reset circuit, press the EN/RST button once and click Retry.");
            throw new Error("Config could not be confirmed on the ESP32. Please check your connection and try again.");
        }

    } finally {
        try {
            await port.close();
        } catch (e) { }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function binaryToString(uint8Array) {
    let str = "";
    for (let i = 0; i < uint8Array.length; i++) {
        str += String.fromCharCode(uint8Array[i]);
    }
    return str;
}

window.LinkedLampFlasher = {
    isWebSerialSupported,
    flashESP32,
    generateConfigJSON,
};