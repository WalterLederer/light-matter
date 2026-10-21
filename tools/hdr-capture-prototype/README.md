# Windows HDR desktop-capture prototype

This is a deliberately standalone proof of concept for the proposed mouse loupe. It captures one frame from the display whose desktop origin is (0, 0), requests an FP16 desktop surface through `IDXGIOutput5::DuplicateOutput1`, and writes a linear scRGB OpenEXR file. It does not modify the Light Matter viewer and does not implement the loupe.

## Important behavior

- Windows HDR must be enabled for the target display.
- The program writes an EXR only if the acquired texture is `DXGI_FORMAT_R16G16B16A16_FLOAT`. It deliberately refuses to label SDR/BGRA8 pixels as HDR.
- The EXR stores RGBA half-float channels with Rec.709/scRGB primaries and linear values. It is **not** an HDR10/PQ file. scRGB values can exceed 1.0.
- The prototype captures the desktop as composed by Windows. It may capture its own console/terminal window if that window is visible when the frame is acquired.
- This initial prototype selects the attached output with desktop origin (0, 0); it is not yet a multi-monitor selector.

## Build (Visual Studio 2022/2026, x64)

Install CMake and vcpkg, then from this directory run in a Developer PowerShell:

```powershell
cmake -S . -B build -A x64 -DCMAKE_TOOLCHAIN_FILE="$env:VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake"
cmake --build build --config Release

```

If `VCPKG_ROOT` is not set, replace the toolchain path with the full path to your vcpkg installation.

## Run

With Windows HDR enabled on the target display:

```powershell
.\build\Release\hdr-capture.exe .\hdr-capture.exr

```

Open the resulting EXR in Light Matter. The console reports the captured dimensions, DXGI format, min/max RGB values, and the center pixel in linear scRGB. Keep the output log if capture fails; the exact HRESULT or pixel format is important for the next iteration.

If the program reports that the frame is not FP16, do not treat the output as an HDR capture. Send the complete console output and confirm that Windows HDR is enabled for the display.
