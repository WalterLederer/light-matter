# Windows HDR desktop-capture prototype

This standalone proof of concept tests Windows Graphics Capture (WGC) after the DXGI Desktop Duplication API returned `DXGI_ERROR_UNSUPPORTED` for FP16, 10-bit and 8-bit output formats. It does not modify the Light Matter viewer and does not implement the loupe.

## What it does

- Selects the attached display whose desktop origin is (0, 0), matching the first prototype.
- Uses `Windows.Graphics.Capture` with an FP16 `R16G16B16A16_FLOAT` frame pool.
- Receives frames continuously for a short 3-second burst, retains the newest frame and reports the observed frame delivery rate.
- Copies the newest texture to CPU-readable memory and writes one linear scRGB OpenEXR file.
- Prints the actual texture format and RGB minimum/maximum. It refuses to write an EXR if Windows does not deliver FP16.
- Minimizes its console before capture so the console is less likely to appear in the screenshot.

Windows HDR must be enabled on the target display. The EXR stores RGBA half-float channels with Rec.709/scRGB primaries and linear values; it is not an HDR10/PQ file. scRGB values can exceed 1.0.

## Build (Visual Studio 2022/2026, x64)

Install CMake and vcpkg, then from this directory run in a Developer PowerShell:

```powershell
cmake -S . -B build -A x64 -DCMAKE_TOOLCHAIN_FILE="$env:VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake"
cmake --build build --config Release

```

If `VCPKG_ROOT` is not set, replace the toolchain path with the full path to your vcpkg installation.

## Run

With Windows HDR enabled:

```powershell
.\build\Release\hdr-capture.exe .\hdr-capture.exr

```

Open the EXR in Light Matter. Send the complete console output if the build or capture fails. The important checks are whether WGC returns format enum `10` (`DXGI_FORMAT_R16G16B16A16_FLOAT`), whether the capture burst delivers frames continuously, and whether the EXR preserves expected HDR highlights.

## Current limitation

This test captures a single saved frame after a 3-second capture burst. It validates ongoing frame delivery but does not yet benchmark low-latency cursor-loupe rendering or exclude an eventual loupe overlay from desktop capture.
