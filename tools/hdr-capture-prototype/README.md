# Windows HDR desktop-capture prototype

This standalone proof of concept tests Windows Graphics Capture (WGC) after the DXGI Desktop Duplication API returned `DXGI_ERROR_UNSUPPORTED` for FP16, 10-bit and 8-bit output formats. It does not modify the Light Matter viewer and does not implement the loupe.

## What the current executable proves

- Selects the attached display whose desktop origin is (0, 0), matching the first prototype.
- Uses `Windows.Graphics.Capture` with an FP16 `R16G16B16A16_FLOAT` frame pool.
- Receives frames continuously for a short 3-second burst and retains the newest frame.
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

With Windows HDR enabled, capture the primary monitor:

```powershell
.\build\Release\hdr-capture.exe .\hdr-capture.exr

```

To test capturing only the Light Matter window, first find its HWND:

```powershell
Get-Process |
  Where-Object { $_.MainWindowTitle -like '*Light Matter*' -and $_.MainWindowHandle -ne 0 } |
  Select-Object ProcessName, MainWindowTitle, @{Name='HWND'; Expression={ '0x{0:X}' -f $_.MainWindowHandle.ToInt64() }}

```

Then pass that handle (keep Light Matter open and showing the HDR image):

```powershell
.\build\Release\hdr-capture.exe --hwnd 0x123456 .\light-matter-window.exr

```

Replace `0x123456` with the actual HWND printed by the command. Open the resulting EXR in Light Matter. For this test, verify that the dimensions match the app window and the actual texture format is enum `10` (`DXGI_FORMAT_R16G16B16A16_FLOAT`). If the window capture is SDR/8-bit, do not use it for the HDR loupe; report the complete console output instead.

## Integration design for the cursor loupe

The capture loop must be independent of pointer movement. The native side owns the WGC frame pool and retains only the latest valid frame/texture. A pointer update supplies only source coordinates and magnification; it must not start a capture, read back a 4K frame, or write a file.

The intended division of work is:

1. **Electron main/native capture owner:** starts and stops capture on demand and owns the latest WGC frame. The current EXR-writing path is diagnostic only and must not run in the live path.
2. **GPU crop:** for each loupe position, use the latest frame texture and GPU-side crop/scale. Do not copy the complete 3840×2160 FP16 frame to JavaScript or CPU memory for every pointer event.
3. **Separate loupe surface:** render the loupe in a separate native overlay/window or an equivalent surface excluded from the capture source. A DOM loupe inside the captured window would be captured again and could feed back into later frames.
4. **HDR-preserving output:** keep FP16/scRGB through the crop and render path. A normal PNG/canvas conversion is not an acceptable substitute because it can discard values above 1.0.
5. **Lifecycle:** start capture only while the loupe is enabled and the normal image view is active; stop it when disabled, entering fullscreen, leaving the image view, or closing the window. Overlay changes are reflected by the next naturally delivered WGC frame.

### Next native integration milestone

Before wiring UI controls, change the capture target from the whole monitor to the Light Matter window and validate that WGC still returns FP16/scRGB while capturing the rendered image plus its Info/Histogram overlays. The eventual loupe must be a separate capture-excluded surface; otherwise the magnifier can appear recursively in its own source. Only after that test passes should the frame cache and GPU crop be connected to Electron IPC.

## Current limitation

This is still a capture-format proof of concept. It does not yet capture the Light Matter window, expose a native API to Electron, or render a loupe. The 3-second burst measures frame delivery; it is not a requirement to recapture on mouse movement.
