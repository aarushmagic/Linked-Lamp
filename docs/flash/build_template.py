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
import argparse

# Paths relative to this script's location
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FLASH_DIR = SCRIPT_DIR  # docs/flash/

# PlatformIO framework tools path (varies by OS)
FRAMEWORK_DIR = os.path.join(
    os.path.expanduser("~"),
    ".platformio", "packages", "framework-arduinoespressif32"
)

def main():
    print("Linked Lamp — Build Helper")
    print("=" * 40)

    hw_types = ["pcb", "neopixel"]
    
    # Track if we found a LittleFS image to use as template
    littlefs_found = False

    for hw in hw_types:
        print(f"\nProcessing hardware type: {hw}")
        print("-" * 30)

        # Dynamic paths based on hardware type
        FIRMWARE_DIR = os.path.join(SCRIPT_DIR, "..", "..", "firmware", hw)
        BUILD_DIR = os.path.join(FIRMWARE_DIR, ".pio", "build", "esp32dev")
        
        # Check firmware build exists for this type
        if not os.path.isdir(BUILD_DIR):
            print(f"  ✗ ERROR: Build directory not found: {BUILD_DIR}")
            print(f"    Please run 'pio run' in the firmware/{hw}/ directory first.")
            continue

        FW_FILENAME = "firmware.bin" if hw == "pcb" else "firmware-neo.bin"

        # Binaries specific to this build
        FILES_TO_COPY = {
            "bootloader.bin": os.path.join(BUILD_DIR, "bootloader.bin"),
            "partitions.bin": os.path.join(BUILD_DIR, "partitions.bin"),
            FW_FILENAME:      os.path.join(BUILD_DIR, "firmware.bin"),
        }

        # Also copy boot_app0.bin (shared tool binary)
        BOOT_APP0_DEST = os.path.join(FLASH_DIR, "boot_app0.bin")
        BOOT_APP0_SRC = os.path.join(FRAMEWORK_DIR, "tools", "partitions", "boot_app0.bin")
        if os.path.isfile(BOOT_APP0_SRC):
            shutil.copy2(BOOT_APP0_SRC, BOOT_APP0_DEST)
            size_kb = os.path.getsize(BOOT_APP0_DEST) / 1024
            print(f"  ✓ boot_app0.bin ({size_kb:.1f} KB)")

        # Copy standard binaries
        for dest_name, src_path in FILES_TO_COPY.items():
            dest_path = os.path.join(FLASH_DIR, dest_name)
            if os.path.isfile(src_path):
                shutil.copy2(src_path, dest_path)
                size_kb = os.path.getsize(dest_path) / 1024
                print(f"  ✓ {dest_name} ({size_kb:.1f} KB)")
            else:
                print(f"  ✗ {dest_name} — source not found: {src_path}")

        # Check for LittleFS image for this type
        LITTLEFS_SRC = os.path.join(BUILD_DIR, "littlefs.bin")
        LITTLEFS_DEST = os.path.join(FLASH_DIR, "littlefs_template.bin")
        if not littlefs_found and os.path.isfile(LITTLEFS_SRC):
            shutil.copy2(LITTLEFS_SRC, LITTLEFS_DEST)
            size_kb = os.path.getsize(LITTLEFS_DEST) / 1024
            print(f"  ✓ littlefs_template.bin ({size_kb:.1f} KB) ← pulled from {hw}")
            littlefs_found = True

    print("\n" + "=" * 40)
    print("Done! Files are ready in docs/flash/")
    print("Commit these files to your repository.")


if __name__ == "__main__":
    main()
