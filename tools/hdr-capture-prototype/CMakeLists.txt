cmake_minimum_required(VERSION 3.24)
project(HdrCapturePrototype LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "This prototype is Windows-only.")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(OpenEXR CONFIG REQUIRED)

add_executable(hdr-capture main.cpp)
target_compile_definitions(hdr-capture PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_link_libraries(hdr-capture PRIVATE d3d11 dxgi OpenEXR::OpenEXR)
