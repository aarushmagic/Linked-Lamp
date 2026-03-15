/**
 * Linked Lamp — Browser Flasher Module
 * 
 * Uses esptool-js and Web Serial API to flash ESP32 directly from the browser.
 * Handles fetching binaries, patching the LittleFS image with custom config, 
 * and flashing all partitions in one operation.
 * 
 * Requires: Chrome 89+ or Edge 89+ (Web Serial API support)
 * 
 * License: GNU GPLv3
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
    firmware: BINARY_BASE + "firmware.bin",
    littlefs: BINARY_BASE + "littlefs_template.bin",
};

// LittleFS partition size (from min_spiffs.csv: 0x20000 = 128KB)
const LITTLEFS_PARTITION_SIZE = 0x20000;

/**
 * Check if the browser supports Web Serial API
 */
function isWebSerialSupported() {
    return "serial" in navigator;
}

/**
 * Fetch a binary file as a Uint8Array
 */
async function fetchBinary(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
}

/**
 * Generate a config.json string and pad it to a fixed length.
 * The padding ensures we can replace the placeholder in the LittleFS template
 * without changing the binary size.
 */
function generateConfigJSON(deviceId, mqttServer, mqttUser, mqttPass) {
    const config = {
        device_id: deviceId,
        mqtt_server: mqttServer,
        mqtt_port: 8883,
        mqtt_user: mqttUser,
        mqtt_pass: mqttPass,
        ota_url: "https://aarushmagic.github.io/Linked-Lamp"
    };
    return JSON.stringify(config, null, 2);
}

/**
 * Create a minimal LittleFS image containing a single config.json file.
 * 
 * This builds a raw LittleFS binary image from scratch using the LittleFS
 * on-disk format specification. The image contains just one file: config.json.
 * 
 * LittleFS v2 on-disk format:
 * - Block 0 & 1: Superblock (metadata pair)
 * - Block 2 & 3: Root directory (metadata pair)
 * - Block 4+: File data
 * 
 * Each metadata block contains:
 *   - Revision count (4 bytes LE)
 *   - Tag entries (each 4 bytes)
 *   - Data associated with tags
 *   - CRC32 (4 bytes) at the end of the commit
 */
function createLittleFSImage(configJson) {
    const BLOCK_SIZE = 4096;
    const BLOCK_COUNT = LITTLEFS_PARTITION_SIZE / BLOCK_SIZE; // 32 blocks for 128KB
    const image = new Uint8Array(LITTLEFS_PARTITION_SIZE);
    image.fill(0xFF); // Erased flash is 0xFF

    const encoder = new TextEncoder();
    const configBytes = encoder.encode(configJson);
    const fileName = "config.json";
    const nameBytes = encoder.encode(fileName);

    // CRC32 lookup table (standard polynomial 0xEDB88320)
    const crc32Table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crc32Table[i] = c;
    }

    function crc32(data, start, len) {
        let crc = 0xFFFFFFFF;
        for (let i = start; i < start + len; i++) {
            crc = crc32Table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
        }
        return crc ^ 0xFFFFFFFF;
    }

    function writeLE32(arr, offset, value) {
        arr[offset] = value & 0xFF;
        arr[offset + 1] = (value >>> 8) & 0xFF;
        arr[offset + 2] = (value >>> 16) & 0xFF;
        arr[offset + 3] = (value >>> 24) & 0xFF;
    }

    function readLE32(arr, offset) {
        return (arr[offset]) |
            (arr[offset + 1] << 8) |
            (arr[offset + 2] << 16) |
            (arr[offset + 3] << 24);
    }

    /**
     * LittleFS Tag format (32-bit):
     *   Bit 31:      Valid bit (1 = valid in XOR chain)  
     *   Bits 30-28:  Type3 (abstract type)
     *   Bits 27-20:  Type1 (8-bit chunk/type)
     *   Bits 19-10:  ID (10-bit file identifier)
     *   Bits 9-0:    Length (10-bit data length)
     * 
     * Tags are XORed with the previous tag in the chain.
     */
    function makeTag(type3, type1, id, length, valid) {
        let tag = 0;
        if (valid) tag |= (1 << 31);
        tag |= ((type3 & 0x7) << 28);
        tag |= ((type1 & 0xFF) << 20);
        tag |= ((id & 0x3FF) << 10);
        tag |= (length & 0x3FF);
        return tag;
    }

    // =========================================================================
    // Build Superblock (blocks 0 and 1 as a metadata pair)
    // =========================================================================
    function writeSuperblock(blockIdx) {
        const base = blockIdx * BLOCK_SIZE;
        let pos = base;

        // Revision count
        writeLE32(image, pos, 1);
        pos += 4;

        // The first tag in a commit is XORed with 0xFFFFFFFF
        let prevTag = 0xFFFFFFFF;

        // --- Tag 1: LFS_TYPE_NAME + LFS_TYPE_SUPERBLOCK (type3=0, type1=0x0FF, id=0)
        // Name tag: type3=0 (LFS_TYPE_NAME), type1=0x0FF (LFS_TYPE_SUPERBLOCK), id=0
        // Length = 8 bytes for "littlefs" (without null terminator)
        const superName = encoder.encode("littlefs");
        let tag1 = makeTag(0, 0xFF, 0, superName.length, true);
        let xorTag1 = (tag1 ^ prevTag) >>> 0;
        writeLE32(image, pos, xorTag1);
        pos += 4;
        image.set(superName, pos);
        pos += superName.length;
        prevTag = tag1;

        // --- Tag 2: LFS_TYPE_STRUCT + LFS_TYPE_SUPERBLOCK (type3=2, type1=0x0FF, id=0)
        // Superblock struct: version (LE32), block_size (LE32), block_count (LE32), name_max (LE32), file_max (LE32), attr_max (LE32)
        const structData = new Uint8Array(24);
        writeLE32(structData, 0, 0x00020000);   // version 2.0
        writeLE32(structData, 4, BLOCK_SIZE);    // block_size
        writeLE32(structData, 8, BLOCK_COUNT);   // block_count
        writeLE32(structData, 12, 255);          // name_max
        writeLE32(structData, 16, 2147483647);   // file_max (0x7FFFFFFF)
        writeLE32(structData, 20, 255);          // attr_max

        let tag2 = makeTag(2, 0xFF, 0, structData.length, true);
        let xorTag2 = (tag2 ^ prevTag) >>> 0;
        writeLE32(image, pos, xorTag2);
        pos += 4;
        image.set(structData, pos);
        pos += structData.length;
        prevTag = tag2;

        // --- CRC tag: type3=0, type1=0x1FF (LFS_TYPE_CRC), id=0x3FF, length=0
        // BUT: length field contains the size of garbage/padding after CRC
        const usedInBlock = pos - base;
        const remaining = BLOCK_SIZE - usedInBlock - 4 - 4; // 4 for CRC tag, 4 for CRC value
        let crcTag = makeTag(0, 0x1FF, 0x3FF, Math.min(remaining, 0x3FF), true);
        let xorCrcTag = (crcTag ^ prevTag) >>> 0;
        writeLE32(image, pos, xorCrcTag);
        pos += 4;

        // Compute CRC over everything from block start to here
        const crcVal = crc32(image, base, pos - base);
        writeLE32(image, pos, crcVal);
        pos += 4;
    }

    // =========================================================================
    // Build Root Directory (blocks 2 and 3 as a metadata pair)
    // =========================================================================
    function writeRootDir(blockIdx) {
        const base = blockIdx * BLOCK_SIZE;
        let pos = base;

        // Revision count
        writeLE32(image, pos, 1);
        pos += 4;

        let prevTag = 0xFFFFFFFF;

        // --- Tag 1: Name entry for config.json (type3=0, type1=0x01 = REG file, id=1)
        let nameTag = makeTag(0, 0x01, 1, nameBytes.length, true);
        let xorNameTag = (nameTag ^ prevTag) >>> 0;
        writeLE32(image, pos, xorNameTag);
        pos += 4;
        image.set(nameBytes, pos);
        pos += nameBytes.length;
        prevTag = nameTag;

        // --- Tag 2: Inline struct for file (type3=2, type1=0x01 = LFS_TYPE_STRUCT for REG, id=1)
        // For a file with inline data in a CTZ skip-list, the struct is:
        //   ctz_head (LE32) — block pointer
        //   ctz_size (LE32) — file size
        // But for inline files (data stored in metadata), we use:
        //   LFS_TYPE_INLINESTRUCT (type3=2, type1=0x00, id=1)
        // with length=0 to indicate inline data follows
        let structTag = makeTag(2, 0x00, 1, 0, true);
        let xorStructTag = (structTag ^ prevTag) >>> 0;
        writeLE32(image, pos, xorStructTag);
        pos += 4;
        prevTag = structTag;

        // --- Tag 3: Inline data (type3=3, type1=0x00 = LFS_FROM_DATA, id=1, length=configBytes.length)
        // This stores the actual file content inline in the metadata
        if (configBytes.length <= 0x3FF) {
            // File is small enough for inline storage
            let dataTag = makeTag(3, 0x00, 1, configBytes.length, true);
            let xorDataTag = (dataTag ^ prevTag) >>> 0;
            writeLE32(image, pos, xorDataTag);
            pos += 4;
            image.set(configBytes, pos);
            pos += configBytes.length;
            prevTag = dataTag;
        } else {
            // File too large for inline — store in data block
            // Write file content to block 4
            const dataBlockIdx = 4;
            const dataBase = dataBlockIdx * BLOCK_SIZE;
            image.set(configBytes, dataBase);

            // CTZ struct: head block, file size
            const ctzStruct = new Uint8Array(8);
            writeLE32(ctzStruct, 0, dataBlockIdx); // head block
            writeLE32(ctzStruct, 4, configBytes.length); // size
            let ctzTag = makeTag(2, 0x01, 1, 8, true);
            let xorCtzTag = (ctzTag ^ prevTag) >>> 0;
            writeLE32(image, pos, xorCtzTag);
            pos += 4;
            image.set(ctzStruct, pos);
            pos += 8;
            prevTag = ctzTag;
        }

        // --- CRC tag
        const usedInBlock = pos - base;
        const remaining = BLOCK_SIZE - usedInBlock - 4 - 4;
        let crcTag = makeTag(0, 0x1FF, 0x3FF, Math.min(remaining, 0x3FF), true);
        let xorCrcTag = (crcTag ^ prevTag) >>> 0;
        writeLE32(image, pos, xorCrcTag);
        pos += 4;

        const crcVal = crc32(image, base, pos - base);
        writeLE32(image, pos, crcVal);
        pos += 4;
    }

    // Write both copies of each metadata pair
    writeSuperblock(0);
    writeSuperblock(1);
    writeRootDir(2);
    writeRootDir(3);

    return image;
}

/**
 * Flash an ESP32 with all required binaries.
 * 
 * @param {object} config - { mqttServer, mqttUser, mqttPass, deviceId }
 * @param {function} onLog - Callback for log messages: (msg) => {}
 * @param {function} onProgress - Callback for progress: (percent) => {}
 * @returns {Promise<void>}
 */
async function flashESP32(config, onLog, onProgress) {
    if (!isWebSerialSupported()) {
        throw new Error("Web Serial API is not supported in this browser. Please use Google Chrome or Microsoft Edge.");
    }

    onLog("Requesting serial port...");
    let port;
    try {
        port = await navigator.serial.requestPort();
    } catch (e) {
        throw new Error("No serial port selected. Please connect your ESP32 and try again.");
    }

    onLog("Loading esptool-js...");

    // Dynamically import esptool-js from CDN
    const esptoolMod = await import(
        "https://unpkg.com/esptool-js@0.4.5/bundle.js"
    );
    const ESPLoader = esptoolMod.ESPLoader;
    const Transport = esptoolMod.Transport;

    onLog("Fetching firmware binaries...");
    onProgress(5);

    // Fetch all binaries in parallel
    const [bootloader, partitions, bootApp0, firmware, littlefs] = await Promise.all([
        fetchBinary(BINARY_FILES.bootloader),
        fetchBinary(BINARY_FILES.partitions),
        fetchBinary(BINARY_FILES.boot_app0),
        fetchBinary(BINARY_FILES.firmware),
        fetchBinary(BINARY_FILES.littlefs),
    ]);

    onProgress(15);
    onLog("Connecting to ESP32...");

    // Terminal logger for esptool-js
    const espTerminal = {
        clean() { },
        writeLine(data) { onLog(data); },
        write(data) { /* suppress raw byte spam */ },
    };

    // Create transport and loader
    const transport = new Transport(port, true);
    const loader = new ESPLoader({
        transport,
        baudrate: 115200,
        romBaudrate: 115200,
        terminal: espTerminal,
    });

    try {
        // Connect and sync with bootloader
        const chipType = await loader.main();
        onLog(`Connected! Chip: ${chipType || "ESP32"}`);
        onProgress(20);

        onLog("Flashing firmware (no LittleFS — config sent via Serial after boot)...");
        onProgress(25);

        // Flash firmware and overwrite LittleFS
        const fileArray = [
            { data: binaryToString(bootloader), address: FLASH_OFFSETS.BOOTLOADER },
            { data: binaryToString(partitions), address: FLASH_OFFSETS.PARTITIONS },
            { data: binaryToString(bootApp0), address: FLASH_OFFSETS.BOOT_APP0 },
            { data: binaryToString(firmware), address: FLASH_OFFSETS.FIRMWARE },
            { data: binaryToString(littlefs), address: FLASH_OFFSETS.LITTLEFS },
        ];

        const totalSize = bootloader.length + partitions.length + bootApp0.length + firmware.length;
        onLog(`Total flash size: ${(totalSize / 1024).toFixed(1)} KB`);

        // Erase only the LittleFS region to clear stale data (don't erase NVS/system partitions!)
        onLog("Erasing LittleFS partition...");
        try {
            await loader.eraseRegion(FLASH_OFFSETS.LITTLEFS, 0x20000); // 128KB
        } catch (e) {
            onLog("Note: Region erase not supported, will be overwritten during flash.");
        }

        await loader.writeFlash({
            fileArray,
            flashSize: "4MB",
            flashMode: "dio",
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

    // =========================================================================
    // Phase 2: Send config via Serial after ESP32 boots
    // =========================================================================
    onLog("Waiting for ESP32 to boot and request config...");
    onProgress(82);

    // Give the ESP32 time to reset, boot, and format LittleFS
    await sleep(6000);

    // Open the serial port directly for config delivery
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
        const TIMEOUT = 25000; // 25 seconds

        onProgress(85);

        // Read serial data — use a simple timeout wrapper to avoid Promise.race data loss
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

                // Log serial output (line by line)
                const lines = buffer.split("\n");
                buffer = lines.pop(); // keep incomplete line in buffer
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed) onLog("ESP32: " + trimmed);

                    // Wait for SEND_CONFIG signal from firmware
                    if (trimmed.includes("SEND_CONFIG") && !configSent) {
                        onLog("Sending config to ESP32...");
                        onProgress(90);
                        // Send config as single-line JSON + newline
                        const configLine = JSON.stringify(JSON.parse(configJson)) + "\n";
                        await writer.write(new TextEncoder().encode(configLine));
                        configSent = true;
                    }

                    // Wait for confirmation (check both signals)
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

/**
 * Simple sleep helper
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Convert a Uint8Array to a binary string (required by esptool-js writeFlash)
 */
function binaryToString(uint8Array) {
    let str = "";
    for (let i = 0; i < uint8Array.length; i++) {
        str += String.fromCharCode(uint8Array[i]);
    }
    return str;
}

// Export for use in setup.html
window.LinkedLampFlasher = {
    isWebSerialSupported,
    flashESP32,
    generateConfigJSON,
};

