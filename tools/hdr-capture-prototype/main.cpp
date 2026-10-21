#include <windows.h>
#include <d3d11.h>
#include <dxgi1_5.h>
#include <wrl/client.h>

#include <OpenEXR/ImfRgbaFile.h>
#include <OpenEXR/ImfHeader.h>
#include <OpenEXR/ImfStringAttribute.h>
#include <OpenEXR/ImfChromaticitiesAttribute.h>
#include <Imath/ImathBox.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <limits>
#include <string>
#include <stdexcept>
#include <vector>

using Microsoft::WRL::ComPtr;
namespace Imf = OPENEXR_IMF_NAMESPACE;
namespace Imath = IMATH_NAMESPACE;

static void CheckHr(HRESULT hr, const char* what)
{
    if (FAILED(hr))
    {
        std::cerr << what << " failed: 0x" << std::hex
                  << static_cast<unsigned long>(hr) << std::dec << "\n";
        throw std::runtime_error(what);
    }
}

static bool IsHdrFloatFormat(DXGI_FORMAT format)
{
    return format == DXGI_FORMAT_R16G16B16A16_FLOAT;
}

int wmain(int argc, wchar_t** argv)
{
    try
    {
        const std::filesystem::path outputPath =
            argc > 1 ? std::filesystem::path(argv[1])
                     : std::filesystem::current_path() / L"hdr-capture.exr";

        ComPtr<IDXGIFactory1> factory;
        CheckHr(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "CreateDXGIFactory1");

        ComPtr<IDXGIAdapter1> selectedAdapter;
        ComPtr<IDXGIOutput> selectedOutput;

        for (UINT adapterIndex = 0; ; ++adapterIndex)
        {
            ComPtr<IDXGIAdapter1> adapter;
            if (factory->EnumAdapters1(adapterIndex, &adapter) == DXGI_ERROR_NOT_FOUND)
                break;

            for (UINT outputIndex = 0; ; ++outputIndex)
            {
                ComPtr<IDXGIOutput> output;
                if (adapter->EnumOutputs(outputIndex, &output) == DXGI_ERROR_NOT_FOUND)
                    break;

                DXGI_OUTPUT_DESC desc{};
                CheckHr(output->GetDesc(&desc), "IDXGIOutput::GetDesc");

                if (desc.AttachedToDesktop &&
                    desc.DesktopCoordinates.left == 0 &&
                    desc.DesktopCoordinates.top == 0)
                {
                    selectedAdapter = adapter;
                    selectedOutput = output;
                    break;
                }
            }
            if (selectedOutput)
                break;
        }

        if (!selectedAdapter || !selectedOutput)
            throw std::runtime_error("Could not find an attached display whose desktop origin is (0,0).");

        DXGI_ADAPTER_DESC1 adapterDesc{};
        CheckHr(selectedAdapter->GetDesc1(&adapterDesc), "IDXGIAdapter1::GetDesc1");
        DXGI_OUTPUT_DESC outputDesc{};
        CheckHr(selectedOutput->GetDesc(&outputDesc), "IDXGIOutput::GetDesc");

        ComPtr<ID3D11Device> device;
        ComPtr<ID3D11DeviceContext> context;
        D3D_FEATURE_LEVEL featureLevel{};
        const D3D_FEATURE_LEVEL levels[] = {
            D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0
        };
        HRESULT createHr = D3D11CreateDevice(
            selectedAdapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, ARRAYSIZE(levels),
            D3D11_SDK_VERSION, &device, &featureLevel, &context);

        if (createHr == E_INVALIDARG)
        {
            CheckHr(D3D11CreateDevice(
                selectedAdapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels + 1, 1,
                D3D11_SDK_VERSION, &device, &featureLevel, &context),
                "D3D11CreateDevice");
        }
        else
        {
            CheckHr(createHr, "D3D11CreateDevice");
        }

        ComPtr<IDXGIOutput5> output5;
        CheckHr(selectedOutput.As(&output5), "Query IDXGIOutput5");

        // Request the HDR compositor format first. BGRA8 remains in the list so
        // the API can still operate in SDR; SDR capture is rejected below.
        const DXGI_FORMAT formats[] = {
            DXGI_FORMAT_R16G16B16A16_FLOAT,
            DXGI_FORMAT_R10G10B10A2_UNORM,
            DXGI_FORMAT_B8G8R8A8_UNORM
        };
        ComPtr<IDXGIOutputDuplication> duplication;
        CheckHr(output5->DuplicateOutput1(
            device.Get(), 0, ARRAYSIZE(formats), formats, &duplication),
            "IDXGIOutput5::DuplicateOutput1");

        DXGI_OUTDUPL_DESC duplicationDesc{};
        duplication->GetDesc(&duplicationDesc);
        std::cout << "Adapter: " << std::wstring(adapterDesc.Description).size()
                  << " characters in name\n";
        std::wcout << L"Display: " << outputDesc.DeviceName << L"\n";
        std::cout << "Desktop size: " << duplicationDesc.ModeDesc.Width << " x "
                  << duplicationDesc.ModeDesc.Height << "\n";
        std::cout << "Captured DXGI format enum: "
                  << static_cast<unsigned>(duplicationDesc.ModeDesc.Format) << "\n";
        std::cout << "Waiting for a desktop frame...\n";

        ComPtr<IDXGIResource> desktopResource;
        DXGI_OUTDUPL_FRAME_INFO frameInfo{};
        HRESULT acquireHr = DXGI_ERROR_WAIT_TIMEOUT;
        for (int attempt = 0; attempt < 5; ++attempt)
        {
            acquireHr = duplication->AcquireNextFrame(1000, &frameInfo, &desktopResource);
            if (acquireHr != DXGI_ERROR_WAIT_TIMEOUT)
                break;
        }
        CheckHr(acquireHr, "AcquireNextFrame");

        ComPtr<ID3D11Texture2D> desktopTexture;
        CheckHr(desktopResource.As(&desktopTexture), "Query captured texture");

        D3D11_TEXTURE2D_DESC sourceDesc{};
        desktopTexture->GetDesc(&sourceDesc);
        if (!IsHdrFloatFormat(sourceDesc.Format))
        {
            duplication->ReleaseFrame();
            std::cerr << "Capture is not FP16 scRGB. Actual DXGI format enum: "
                      << static_cast<unsigned>(sourceDesc.Format) << "\n"
                      << "Enable Windows HDR for this display, then run again. "
                      << "No EXR was written, because converting SDR pixels to EXR "
                      << "would not preserve HDR information.\n";
            return 2;
        }

        D3D11_TEXTURE2D_DESC stagingDesc = sourceDesc;
        stagingDesc.BindFlags = 0;
        stagingDesc.MiscFlags = 0;
        stagingDesc.Usage = D3D11_USAGE_STAGING;
        stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

        ComPtr<ID3D11Texture2D> stagingTexture;
        CheckHr(device->CreateTexture2D(&stagingDesc, nullptr, &stagingTexture),
                "Create staging texture");
        context->CopyResource(stagingTexture.Get(), desktopTexture.Get());

        D3D11_MAPPED_SUBRESOURCE mapped{};
        CheckHr(context->Map(stagingTexture.Get(), 0, D3D11_MAP_READ, 0, &mapped),
                "Map staging texture");

        const int width = static_cast<int>(sourceDesc.Width);
        const int height = static_cast<int>(sourceDesc.Height);
        std::vector<Imf::Rgba> pixels(static_cast<size_t>(width) * height);

        float minRgb = std::numeric_limits<float>::max();
        float maxRgb = std::numeric_limits<float>::lowest();
        const auto* sourceBytes = static_cast<const std::uint8_t*>(mapped.pData);

        for (int y = 0; y < height; ++y)
        {
            const auto* row = reinterpret_cast<const Imath::half*>(
                sourceBytes + static_cast<size_t>(y) * mapped.RowPitch);
            for (int x = 0; x < width; ++x)
            {
                const Imath::half r = row[x * 4 + 0];
                const Imath::half g = row[x * 4 + 1];
                const Imath::half b = row[x * 4 + 2];
                const Imath::half a = row[x * 4 + 3];

                pixels[static_cast<size_t>(y) * width + x] = Imf::Rgba(r, g, b, a);
                minRgb = std::min({ minRgb, static_cast<float>(r),
                                    static_cast<float>(g), static_cast<float>(b) });
                maxRgb = std::max({ maxRgb, static_cast<float>(r),
                                    static_cast<float>(g), static_cast<float>(b) });
            }
        }

        context->Unmap(stagingTexture.Get(), 0);
        CheckHr(duplication->ReleaseFrame(), "ReleaseFrame");

        Imf::Header header(width, height);
        header.insert("chromaticities",
            Imf::ChromaticitiesAttribute(Imf::Chromaticities()));
        header.insert("comments", Imf::StringAttribute(
            "Windows desktop capture, DXGI_FORMAT_R16G16B16A16_FLOAT; "
            "scRGB/Rec.709 primaries, linear-light FP16 values."));

        Imf::RgbaOutputFile file(outputPath.string().c_str(), header, Imf::WRITE_RGBA);
        file.setFrameBuffer(pixels.data(), 1, width);
        file.writePixels(height);

        const auto& center = pixels[static_cast<size_t>(height / 2) * width + width / 2];
        std::cout << "Saved: " << outputPath.string() << "\n";
        std::cout << "Format: OpenEXR RGBA half-float, linear scRGB (not PQ).\n";
        std::cout << "RGB min/max: " << minRgb << " / " << maxRgb << "\n";
        std::cout << "Center pixel (linear scRGB): "
                  << static_cast<float>(center.r) << ", "
                  << static_cast<float>(center.g) << ", "
                  << static_cast<float>(center.b) << "\n";
        std::cout << "Use Light Matter to inspect the EXR. Values above 1.0 are "
                     "expected for HDR highlights.\n";
        return 0;
    }
    catch (const std::exception& ex)
    {
        std::cerr << "ERROR: " << ex.what() << "\n";
        return 1;
    }
}
