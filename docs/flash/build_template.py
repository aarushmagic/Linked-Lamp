"""
Linked Lamp — Build Helper Script

Compiles both firmware variants (PCB and NeoPixel) using PlatformIO,
then copies build artifacts into docs/flash/ for browser-based flashing.
Also generates a LittleFS template image with a padded placeholder config.json.

Usage:
   python docs/flash/build_template.py

This script:
  1. Runs 'pio run' and 'pio run -t buildfs' for both pcb and neopixel firmware
  2. Copies bootloader.bin, partitions.bin, boot_app0.bin, firmware.bin/firmware-neo.bin
  3. Copies littlefs.bin as littlefs_template.bin
"""

import shutil
import os
import sys
import struct
import argparse
import subprocess

# Paths relative to this script's location
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FLASH_DIR = SCRIPT_DIR  # docs/flash/

# PlatformIO framework tools path (varies by OS)
FRAMEWORK_DIR = os.path.join(
    os.path.expanduser("~"),
    ".platformio", "packages", "framework-arduinoespressif32"
)

def compile_firmware():
    """Compile both PCB and NeoPixel firmware using PlatformIO."""
    # Resolve PlatformIO CLI path (not always on system PATH, especially on Windows)
    pio_cmd = os.path.join(
        os.path.expanduser("~"),
        ".platformio", "penv", "Scripts", "platformio.exe"
    )
    if not os.path.isfile(pio_cmd):
        # Fallback: try bare 'pio' in case it's on PATH
        pio_cmd = "pio"

    hw_types = ["pcb", "neopixel"]

    for hw in hw_types:
        fw_dir = os.path.join(SCRIPT_DIR, "..", "..", "firmware", hw)
        fw_dir = os.path.abspath(fw_dir)

        if not os.path.isfile(os.path.join(fw_dir, "platformio.ini")):
            print(f"  ✗ ERROR: platformio.ini not found in {fw_dir}")
            sys.exit(1)

        # Build firmware
        print(f"\n  Building firmware ({hw})...")
        result = subprocess.run(
            [pio_cmd, "run"],
            cwd=fw_dir,
            capture_output=False,
            shell=True
        )
        if result.returncode != 0:
            print(f"  ✗ ERROR: Firmware build failed for {hw}")
            sys.exit(1)
        print(f"  ✓ Firmware compiled ({hw})")

        # Build filesystem image
        print(f"  Building filesystem image ({hw})...")
        result = subprocess.run(
            [pio_cmd, "run", "-t", "buildfs"],
            cwd=fw_dir,
            capture_output=False,
            shell=True
        )
        if result.returncode != 0:
            print(f"  ✗ ERROR: Filesystem build failed for {hw}")
            sys.exit(1)
        print(f"  ✓ Filesystem image built ({hw})")

def main():
    print("Linked Lamp — Build Helper")
    print("=" * 40)

    # Step 1: Compile both firmware variants
    print("\n📦 Step 1: Compiling firmware...")
    print("-" * 30)
    compile_firmware()

    # Step 2: Copy build artifacts
    print("\n📋 Step 2: Copying build artifacts...")
    print("-" * 30)

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
