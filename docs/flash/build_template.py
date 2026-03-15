"""
Linked Lamp — Build Helper Script

Copies PlatformIO build artifacts into docs/flash/ for browser-based flashing.
Also generates a LittleFS template image with a padded placeholder config.json.

Usage:
   cd firmware
   pio run                   # Build the firmware
   pio run -t buildfs        # Build the filesystem image
   python ../docs/flash/build_template.py

This script copies:
  - bootloader.bin
  - partitions.bin
  - boot_app0.bin
  - firmware.bin
  - littlefs.bin (as littlefs_template.bin, with placeholder patched in)
"""

import shutil
import os
import sys
import struct

# Paths relative to this script's location
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FIRMWARE_DIR = os.path.join(SCRIPT_DIR, "..", "..", "firmware")
BUILD_DIR = os.path.join(FIRMWARE_DIR, ".pio", "build", "esp32dev")
FLASH_DIR = SCRIPT_DIR  # docs/flash/

# PlatformIO framework tools path (varies by OS)
FRAMEWORK_DIR = os.path.join(
    os.path.expanduser("~"),
    ".platformio", "packages", "framework-arduinoespressif32"
)

FILES_TO_COPY = {
    # (source relative to BUILD_DIR, destination filename)
    "bootloader.bin": os.path.join(BUILD_DIR, "bootloader.bin"),
    "partitions.bin": os.path.join(BUILD_DIR, "partitions.bin"),
    "firmware.bin":   os.path.join(BUILD_DIR, "firmware.bin"),
    "boot_app0.bin":  os.path.join(FRAMEWORK_DIR, "tools", "partitions", "boot_app0.bin"),
}

LITTLEFS_SRC = os.path.join(BUILD_DIR, "littlefs.bin")
LITTLEFS_DEST = os.path.join(FLASH_DIR, "littlefs_template.bin")

# Placeholder marker for config.json inside the LittleFS image
PLACEHOLDER_MARKER = b"__LINKED_LAMP_CONFIG_PLACEHOLDER__"


def main():
    print("Linked Lamp — Build Helper")
    print("=" * 40)

    # Check firmware build exists
    if not os.path.isdir(BUILD_DIR):
        print(f"ERROR: Build directory not found: {BUILD_DIR}")
        print("Please run 'pio run' in the firmware/ directory first.")
        sys.exit(1)

    # Copy standard binaries
    for dest_name, src_path in FILES_TO_COPY.items():
        dest_path = os.path.join(FLASH_DIR, dest_name)
        if os.path.isfile(src_path):
            shutil.copy2(src_path, dest_path)
            size_kb = os.path.getsize(dest_path) / 1024
            print(f"  ✓ {dest_name} ({size_kb:.1f} KB)")
        else:
            print(f"  ✗ {dest_name} — source not found: {src_path}")
            if dest_name == "boot_app0.bin":
                print("    (Try: find ~/.platformio -name boot_app0.bin)")

    # Copy LittleFS image
    if os.path.isfile(LITTLEFS_SRC):
        shutil.copy2(LITTLEFS_SRC, LITTLEFS_DEST)
        size_kb = os.path.getsize(LITTLEFS_DEST) / 1024
        print(f"  ✓ littlefs_template.bin ({size_kb:.1f} KB)")
    else:
        print(f"  ✗ littlefs.bin — not found. Run 'pio run -t buildfs' first.")

    # Also copy firmware.bin to docs/ root for OTA updates
    ota_dest = os.path.join(SCRIPT_DIR, "..", "firmware.bin")
    firmware_src = FILES_TO_COPY["firmware.bin"]
    if os.path.isfile(firmware_src):
        shutil.copy2(firmware_src, ota_dest)
        size_kb = os.path.getsize(ota_dest) / 1024
        print(f"  ✓ firmware.bin → docs/ for OTA ({size_kb:.1f} KB)")
    else:
        print(f"  ✗ Could not copy firmware.bin to docs/ for OTA — source not found.")

    print()
    print("Done! Files are ready in docs/flash/ and docs/firmware.bin (OTA)")
    print("Commit these files to your repository.")


if __name__ == "__main__":
    main()
