cmake_minimum_required(VERSION 3.24)
project(JxrWicPrototype LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "This prototype is Windows-only.")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(jxr-wic-encoder main.cpp)
target_compile_definitions(jxr-wic-encoder PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_link_libraries(jxr-wic-encoder PRIVATE windowscodecs ole32 oleaut32)
