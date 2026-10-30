# JPEG XR WIC FP16 encoder prototype

This standalone Windows prototype isolates JPEG XR encoding from the capture API. It accepts a packed RGBA FP16 file and writes a JPEG XR file through the native Windows Imaging Component (WIC) codec.

The encoder explicitly requests `GUID_WICPixelFormat64bppRGBAHalf` and checks that WIC returns that exact format. If WIC substitutes another format, the program stops instead of silently converting the HDR pixels.

## Build

Requirements: Windows 10/11, Visual Studio C++ build tools, and CMake 3.24 or newer.

From a Developer PowerShell in this directory:

```powershell
cmake -S . -B build -A x64
cmake --build build --config Release

```

## Encode an FP16 capture

First create a raw FP16 frame with the existing capture test:

```powershell
node ..\hdr-capture-prototype\node-screen-capture-fp16-test.mjs --raw .\capture.rgba16f

```

Then encode it. Replace the dimensions with the width and height printed by the capture test:

```powershell
.\build\Release\jxr-wic-encoder.exe .\capture.rgba16f .\capture-wic.jxr 3840 2160

```

The input must be tightly packed little-endian RGBA with four IEEE-754 binary16 channels per pixel (8 bytes per pixel). The helper forces alpha to 1.0 because a desktop capture is opaque. RGB values are passed through unchanged; no brightness scaling or gamma correction is applied.

The diagnostic requests JPEG XR `ImageQuality=1.0`, which the WIC codec documents as mathematically lossless. This prototype does not modify the Light Matter application.
