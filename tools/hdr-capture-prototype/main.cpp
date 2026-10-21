#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <wrl/client.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <OpenEXR/ImfRgbaFile.h>
#include <OpenEXR/ImfHeader.h>
#include <OpenEXR/ImfStringAttribute.h>
#include <OpenEXR/ImfChromaticitiesAttribute.h>
#include <Imath/ImathBox.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
using namespace std::chrono_literals;
using winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame;
using winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool;
using winrt::Windows::Graphics::Capture::GraphicsCaptureItem;
using winrt::Windows::Graphics::DirectX::DirectXPixelFormat;
using winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;

static void CheckHr(HRESULT hr, const char* what)
{
    if (FAILED(hr))
    {
        std::cerr << what << " failed: 0x" << std::hex
                  << static_cast<unsigned long>(hr) << std::dec << "\n";
        throw std::runtime_error(what);
    }
}

static ComPtr<ID3D11Device> CreateDeviceForAdapter(
    IDXGIAdapter* adapter, ComPtr<ID3D11DeviceContext>& context)
{
    ComPtr<ID3D11Device> device;
    D3D_FEATURE_LEVEL featureLevel{};
    const D3D_FEATURE_LEVEL levels[] = {
        D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0
    };

    HRESULT hr = D3D11CreateDevice(
        adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, ARRAYSIZE(levels),
        D3D11_SDK_VERSION, &device, &featureLevel, &context);

    if (hr == E_INVALIDARG)
    {
        CheckHr(D3D11CreateDevice(
            adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels + 1, 1,
            D3D11_SDK_VERSION, &device, &featureLevel, &context),
            "D3D11CreateDevice");
    }
    else
    {
        CheckHr(hr, "D3D11CreateDevice");
    }
    return device;
}

static GraphicsCaptureItem CreateCaptureItemForMonitor(HMONITOR monitor)
{
    auto interop = winrt::get_activation_factory<
        GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    GraphicsCaptureItem item{ nullptr };
    CheckHr(interop->CreateForMonitor(
        monitor, winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item)),
        "IGraphicsCaptureItemInterop::CreateForMonitor");
    return item;
}

static GraphicsCaptureItem CreateCaptureItemForWindow(HWND window)
{
    auto interop = winrt::get_activation_factory<
        GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    GraphicsCaptureItem item{ nullptr };
    CheckHr(interop->CreateForWindow(
        window, winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item)),
        "IGraphicsCaptureItemInterop::CreateForWindow");
    return item;
}

int wmain(int argc, wchar_t** argv)
{
    try
    {
        winrt::init_apartment(winrt::apartment_type::multi_threaded);

        HWND targetWindow = nullptr;
        std::filesystem::path outputPath =
            std::filesystem::current_path() / L"hdr-capture.exr";

        // Usage:
        //   hdr-capture.exe [output.exr]
        //   hdr-capture.exe --hwnd 0x123456 [output.exr]
        int argIndex = 1;
        if (argc > 2 && std::wstring(argv[1]) == L"--hwnd")
        {
            wchar_t* end = nullptr;
            const unsigned long long value = std::wcstoull(argv[2], &end, 0);
            if (end == argv[2] || *end != L'\\0' || value == 0)
                throw std::runtime_error("Invalid HWND. Use --hwnd 0x123456.");

            targetWindow = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(value));
            if (!IsWindow(targetWindow))
                throw std::runtime_error("The supplied HWND is not a valid window handle.");

            argIndex = 3;
        }

        if (argc > argIndex)
            outputPath = std::filesystem::path(argv[argIndex]);

        if (!winrt::Windows::Graphics::Capture::GraphicsCaptureSession::IsSupported())
            throw std::runtime_error("Windows.Graphics.Capture is not supported on this system.");

        // Match the earlier prototype: choose the display whose desktop origin is (0, 0).
        ComPtr<IDXGIFactory1> factory;
        CheckHr(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "CreateDXGIFactory1");

        ComPtr<IDXGIAdapter1> selectedAdapter;
        ComPtr<IDXGIOutput> selectedOutput;
        DXGI_OUTPUT_DESC outputDesc{};

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
                    outputDesc = desc;
                    break;
                }
            }
            if (selectedOutput)
                break;
        }

        if (!selectedAdapter || !selectedOutput)
            throw std::runtime_error("Could not find an attached display whose desktop origin is (0, 0).");

        ComPtr<ID3D11DeviceContext> context;
        auto device = CreateDeviceForAdapter(selectedAdapter.Get(), context);

        ComPtr<IDXGIDevice> dxgiDevice;
        CheckHr(device.As(&dxgiDevice), "Query IDXGIDevice");

        winrt::com_ptr<::IInspectable> inspectableDevice;
        CheckHr(CreateDirect3D11DeviceFromDXGIDevice(
            dxgiDevice.Get(), inspectableDevice.put()),
            "CreateDirect3D11DeviceFromDXGIDevice");
        auto winrtDevice = inspectableDevice.as<IDirect3DDevice>();

        const HMONITOR monitor = outputDesc.Monitor;
        const GraphicsCaptureItem item = CreateCaptureItemForMonitor(monitor);
        const auto size = item.Size();

        std::cout << "Capture API: Windows.Graphics.Capture\n";
        std::wcout << L"Display: " << outputDesc.DeviceName << L"\n";
        std::cout << "Requested frame format: R16G16B16A16_FLOAT (FP16/scRGB)\n";
        std::cout << "Capture dimensions: " << size.Width << " x " << size.Height << "\n";

        // Minimize this console so it does not appear in the desktop frame.
        if (HWND console = GetConsoleWindow())
            ShowWindow(console, SW_MINIMIZE);

        std::mutex mutex;
        std::condition_variable condition;
        Direct3D11CaptureFrame capturedFrame{ nullptr };
        bool frameReady = false;
        std::uint64_t frameCount = 0;
        std::string callbackError;

        auto framePool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            winrtDevice, DirectXPixelFormat::R16G16B16A16Float, 2, size);
        auto session = framePool.CreateCaptureSession(item);

        // This prototype intentionally captures one frame only. The same frame-pool
        // path can later feed a continuously refreshed loupe.
        auto revoker = framePool.FrameArrived(
            [&](const Direct3D11CaptureFramePool& sender, const winrt::Windows::Foundation::IInspectable&)
            {
                try
                {
                    auto frame = sender.TryGetNextFrame();
                    if (!frame)
                        return;

                    {
                        std::lock_guard lock(mutex);
                        capturedFrame = std::move(frame);
                        frameReady = true;
                        ++frameCount;
                    }
                    condition.notify_one();
                }
                catch (const winrt::hresult_error& error)
                {
                    std::lock_guard lock(mutex);
                    callbackError = winrt::to_string(error.message());
                    condition.notify_one();
                }
            });

        const auto captureStarted = std::chrono::steady_clock::now();
        session.StartCapture();

        std::uint64_t framesObserved = 0;
        {
            std::unique_lock lock(mutex);
            if (!condition.wait_for(lock, 10s, [&] { return frameReady || !callbackError.empty(); }))
                throw std::runtime_error("Timed out waiting for a Windows.Graphics.Capture frame.");
            if (!callbackError.empty())
                throw std::runtime_error("FrameArrived failed: " + callbackError);

            // Keep the capture session running for a short burst and retain only
            // the newest frame. This tests sustained delivery without writing
            // every frame to disk.
            const auto burstEnd = std::chrono::steady_clock::now() + 3s;
            while (condition.wait_until(lock, burstEnd) != std::cv_status::timeout) {
                if (!callbackError.empty())
                    throw std::runtime_error("FrameArrived failed: " + callbackError);
            }

            framesObserved = frameCount;
            if (!capturedFrame)
                throw std::runtime_error("Capture frame pool did not retain a frame.");
        }

        const auto captureElapsed = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - captureStarted).count();
        std::cout << "Frames received in capture burst: " << framesObserved << "\n";
        std::cout << "Average frame delivery rate: "
                  << (captureElapsed > 0.0 ? framesObserved / captureElapsed : 0.0)
                  << " frames/s over " << captureElapsed << " s\n";

        const auto contentSize = capturedFrame.ContentSize();
        auto surfaceAccess = capturedFrame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
        ComPtr<ID3D11Texture2D> sourceTexture;
        CheckHr(surfaceAccess->GetInterface(IID_PPV_ARGS(&sourceTexture)),
                "IDirect3DDxgiInterfaceAccess::GetInterface(ID3D11Texture2D)");

        D3D11_TEXTURE2D_DESC sourceDesc{};
        sourceTexture->GetDesc(&sourceDesc);
        std::cout << "Actual frame texture format enum: "
                  << static_cast<unsigned>(sourceDesc.Format) << "\n";

        if (sourceDesc.Format != DXGI_FORMAT_R16G16B16A16_FLOAT)
        {
            session.Close();
            framePool.Close();
            std::cerr << "The returned frame is not FP16 scRGB. No EXR was written; "
                         "an SDR frame must not be labelled as HDR.\n";
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
        context->CopyResource(stagingTexture.Get(), sourceTexture.Get());

        D3D11_MAPPED_SUBRESOURCE mapped{};
        CheckHr(context->Map(stagingTexture.Get(), 0, D3D11_MAP_READ, 0, &mapped),
                "Map staging texture");

        const int width = static_cast<int>(contentSize.Width);
        const int height = static_cast<int>(contentSize.Height);
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
        capturedFrame.Close();
        session.Close();
        framePool.Close();

        Imf::Header header(width, height);
        header.insert("chromaticities",
            Imf::ChromaticitiesAttribute(Imf::Chromaticities()));
        header.insert("comments", Imf::StringAttribute(
            "Windows.Graphics.Capture; DXGI_FORMAT_R16G16B16A16_FLOAT; "
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
        std::cout << "Values above 1.0 are possible for HDR highlights. Inspect the EXR in Light Matter.\n";
        return 0;
    }
    catch (const winrt::hresult_error& error)
    {
        std::cerr << "WinRT ERROR: 0x" << std::hex
                  << static_cast<unsigned long>(error.code().value) << std::dec
                  << " " << winrt::to_string(error.message()) << "\n";
        return 1;
    }
    catch (const std::exception& ex)
    {
        std::cerr << "ERROR: " << ex.what() << "\n";
        return 1;
    }
}
