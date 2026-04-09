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

// Binary file URLs (relative to the page in docs/)
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

function generateConfigJSON(deviceId, mqttServer, mqttUser, mqttPass) {
    const config = {
        device_id: deviceId,
        mqtt_server: mqttServer,
        mqtt_port: 8883,
        mqtt_user: mqttUser,
        mqtt_pass: mqttPass,
        ota_url: "https://www.linkedlamp.com"
    };
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

    onLog("Fetching firmware binaries...");
    onProgress(5);

    const firmwareUrl = (config.hwType === "neopixel") ? BINARY_FILES.firmware_neopixel : BINARY_FILES.firmware_pcb;

    const [bootloader, partitions, bootApp0, firmware] = await Promise.all([
        fetchBinary(BINARY_FILES.bootloader),
        fetchBinary(BINARY_FILES.partitions),
        fetchBinary(BINARY_FILES.boot_app0),
        fetchBinary(firmwareUrl),
    ]);

    // --- THE MAGIC FIX ---
    // Manually patch the ESP32 binary headers to force DIO mode (0x02) and 40MHz/4MB (0x20)
    // This bypasses the esptool-js bug that leaves the bootloader at a crashing 80MHz setting.
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

    try {
        const chipType = await loader.main();
        onLog(`Connected! Chip: ${chipType || "ESP32"}`);
        onProgress(20);

        onLog("Flashing firmware (no LittleFS — config sent via Serial after boot)...");
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
        onLog("Firmware flashed! Resetting ESP32...");
        await loader.hardReset();

    } finally {
        await transport.disconnect();
    }

    onLog("Waiting for ESP32 to boot and request config...");
    onProgress(82);

    await sleep(6000);
    await port.open({ baudRate: 115200 });

    const configJson = generateConfigJSON(
        config.deviceId,
        config.mqttServer,
        config.mqttUser,
        config.mqttPass
    );

    try {
        const reader = port.readable.getReader();
        const writer = port.writable.getWriter();
        const decoder = new TextDecoder();
        let buffer = "";
        let configSent = false;
        let configSaved = false;
        const startTime = Date.now();
        const TIMEOUT = 25000;

        onProgress(85);

        const readWithTimeout = (ms) => {
            return new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ value: null, done: false }), ms);
                reader.read().then(result => {
                    clearTimeout(timer);
                    resolve(result);
                });
            });
        };

        while (Date.now() - startTime < TIMEOUT) {
            const { value, done } = await readWithTimeout(2000);
            if (done) break;

            if (value) {
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop();
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed) onLog("ESP32: " + trimmed);

                    if (trimmed.includes("SEND_CONFIG") && !configSent) {
                        onLog("Sending config to ESP32...");
                        onProgress(90);
                        const configLine = JSON.stringify(JSON.parse(configJson)) + "\n";
                        await writer.write(new TextEncoder().encode(configLine));
                        configSent = true;
                    }

                    if (configSent && (trimmed.includes("CONFIG_SAVED") || trimmed.includes("MQTT Server:"))) {
                        configSaved = true;
                    }
                }
                if (configSaved) break;
            }
        }

        reader.releaseLock();
        writer.releaseLock();

        if (configSaved) {
            onProgress(100);
            onLog("✓ Done! Firmware flashed and config saved successfully.");
        } else if (configSent) {
            onProgress(98);
            onLog("⚠ Config was sent but no confirmation received. The ESP32 may need a manual restart.");
        } else {
            onProgress(85);
            onLog("⚠ ESP32 didn't request config. It may already have a valid config, or you may need to re-flash.");
        }

    } finally {
        await port.close();
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