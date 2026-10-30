#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <cstdint>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

static void CheckHr(HRESULT hr, const char* operation)
{
    if (FAILED(hr))
    {
        std::cerr << operation << " failed: 0x" << std::hex
                  << static_cast<unsigned long>(hr) << std::dec << "\n";
        throw std::runtime_error(operation);
    }
}

static std::uint32_t ParseDimension(const wchar_t* value, const char* name)
{
    wchar_t* end = nullptr;
    const unsigned long parsed = std::wcstoul(value, &end, 10);
    if (end == value || *end != L'\0' || parsed == 0 ||
        parsed > std::numeric_limits<std::uint32_t>::max())
    {
        throw std::runtime_error(std::string("Invalid ") + name + ".");
    }
    return static_cast<std::uint32_t>(parsed);
}

int wmain(int argc, wchar_t** argv)
{
    const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(comResult))
    {
        CheckHr(comResult, "CoInitializeEx");
    }

    try
    {
        if (argc != 6)
        {
            std::wcerr << L"Usage: jxr-wic-encoder.exe input.rgba16f output.jxr width height quality\n"
                       << L"Quality: integer from 0 to 100; 100 requests lossless JPEG XR.\n"
                       << L"Input layout: packed little-endian RGBA, four IEEE-754 binary16 values per pixel.\n";
            CoUninitialize();
            return 2;
        }

        const std::filesystem::path inputPath(argv[1]);
        const std::filesystem::path outputPath(argv[2]);
        const std::uint32_t width = ParseDimension(argv[3], "width");
        const std::uint32_t height = ParseDimension(argv[4], "height");
        wchar_t* qualityEnd = nullptr;
        const unsigned long qualityPercent = std::wcstoul(argv[5], &qualityEnd, 10);
        if (qualityEnd == argv[5] || *qualityEnd != L'\0' || qualityPercent > 100)
        {
            throw std::runtime_error("Quality must be an integer between 0 and 100.");
        }
        const float imageQuality = static_cast<float>(qualityPercent) / 100.0f;

        const std::uint64_t expectedBytes =
            static_cast<std::uint64_t>(width) * height * 8u;
        const std::uint64_t stride64 = static_cast<std::uint64_t>(width) * 8u;
        if (expectedBytes > std::numeric_limits<UINT>::max() ||
            stride64 > std::numeric_limits<UINT>::max())
        {
            throw std::runtime_error("The image is too large for WIC WritePixels.");
        }

        std::ifstream input(inputPath, std::ios::binary | std::ios::ate);
        if (!input)
        {
            throw std::runtime_error("Could not open the FP16 input file.");
        }
        const std::streamoff inputSize = input.tellg();
        if (inputSize < 0 || static_cast<std::uint64_t>(inputSize) != expectedBytes)
        {
            throw std::runtime_error("Input byte length does not match width * height * 8.");
        }

        std::vector<std::uint8_t> pixels(static_cast<std::size_t>(expectedBytes));
        input.seekg(0, std::ios::beg);
        if (!input.read(reinterpret_cast<char*>(pixels.data()), inputSize))
        {
            throw std::runtime_error("Could not read the complete FP16 input file.");
        }

        // Desktop captures are opaque. Force alpha to 1.0 without touching RGB.
        auto* halfPixels = reinterpret_cast<std::uint16_t*>(pixels.data());
        const std::uint64_t pixelCount = static_cast<std::uint64_t>(width) * height;
        for (std::uint64_t pixel = 0; pixel < pixelCount; ++pixel)
        {
            halfPixels[pixel * 4u + 3u] = 0x3c00u; // IEEE-754 binary16 value 1.0
        }

        ComPtr<IWICImagingFactory> factory;
        CheckHr(CoCreateInstance(
            CLSID_WICImagingFactory,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(&factory)),
            "CoCreateInstance(WICImagingFactory)");

        ComPtr<IWICStream> stream;
        CheckHr(factory->CreateStream(&stream), "IWICImagingFactory::CreateStream");
        CheckHr(stream->InitializeFromFilename(outputPath.c_str(), GENERIC_WRITE),
                "IWICStream::InitializeFromFilename");

        ComPtr<IWICBitmapEncoder> encoder;
        CheckHr(factory->CreateEncoder(GUID_ContainerFormatWmp, nullptr, &encoder),
                "IWICImagingFactory::CreateEncoder(JPEG XR)");
        CheckHr(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache),
                "IWICBitmapEncoder::Initialize");

        ComPtr<IWICBitmapFrameEncode> frame;
        ComPtr<IPropertyBag2> options;
        CheckHr(encoder->CreateNewFrame(&frame, &options),
                "IWICBitmapEncoder::CreateNewFrame");

        // Set lossless quality before initializing the frame with its options.
        PROPBAG2 qualityProperty{};
        qualityProperty.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
        VARIANT qualityValue;
        VariantInit(&qualityValue);
        qualityValue.vt = VT_R4;
        qualityValue.fltVal = imageQuality;
        const HRESULT qualityResult = options->Write(1, &qualityProperty, &qualityValue);
        VariantClear(&qualityValue);
        CheckHr(qualityResult, "IPropertyBag2::Write(ImageQuality)");

        CheckHr(frame->Initialize(options.Get()),
                "IWICBitmapFrameEncode::Initialize");
        CheckHr(frame->SetSize(width, height),
                "IWICBitmapFrameEncode::SetSize");

        // The JPEG XR WIC encoder supports this exact FP16 RGBA format.
        // Refuse any substitution so half-float samples can never be misread as UINT.
        WICPixelFormatGUID pixelFormat = GUID_WICPixelFormat64bppRGBAHalf;
        CheckHr(frame->SetPixelFormat(&pixelFormat),
                "IWICBitmapFrameEncode::SetPixelFormat(64bppRGBAHalf)");
        if (!IsEqualGUID(pixelFormat, GUID_WICPixelFormat64bppRGBAHalf))
        {
            std::wcerr << L"WIC substituted the requested RGBAHalf format. Returned GUID: "
                       << std::hex
                       << pixelFormat.Data1 << L"-"
                       << pixelFormat.Data2 << L"-"
                       << pixelFormat.Data3 << L"\n";
            throw std::runtime_error("The JPEG XR encoder did not accept 64bppRGBAHalf.");
        }

        CheckHr(frame->WritePixels(
            height,
            static_cast<UINT>(stride64),
            static_cast<UINT>(expectedBytes),
            pixels.data()),
            "IWICBitmapFrameEncode::WritePixels");

        CheckHr(frame->Commit(), "IWICBitmapFrameEncode::Commit");
        CheckHr(encoder->Commit(), "IWICBitmapEncoder::Commit");

        std::wcout << L"JPEG XR written: " << outputPath.wstring() << L"\n"
                   << L"Dimensions: " << width << L"x" << height << L"\n"
                   << L"Input format: GUID_WICPixelFormat64bppRGBAHalf (FP16 scRGB)\n"
                   << L"ImageQuality: " << imageQuality
                   << (qualityPercent == 100 ? L" (lossless)\n" : L"\n");
        CoUninitialize();
        return 0;
    }
    catch (const std::exception& error)
    {
        std::cerr << "JXR WIC prototype error: " << error.what() << "\n";
        CoUninitialize();
        return 1;
    }
}
