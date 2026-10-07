# SPDX-License-Identifier: AGPL-3.0-only
#
# Builds p5rp, the Remote Play session helper, against libchiaki from
# chiaki-ng. Only the library is built: no GUI, no CLI, no audio, no decoder.
#
#   cmake -S rpnative -B build-rp -G Ninja -DCMAKE_BUILD_TYPE=Release
#   cmake --build build-rp --target p5rp
#
# Needs: a C compiler, json-c, miniupnpc, libevent, OpenSSL, pkg-config, and
# a Python 3 that has the `protobuf` module (chiaki's message code is
# generated at build time).
cmake_minimum_required(VERSION 3.20)
project(p5rp C CXX)

set(P5RP_CHIAKI_TAG "v1.10.0" CACHE STRING "chiaki-ng version to build against")

foreach(opt CHIAKI_ENABLE_TESTS CHIAKI_ENABLE_CLI CHIAKI_ENABLE_GUI CHIAKI_LIB_ENABLE_OPUS CHIAKI_ENABLE_STEAM_SHORTCUT)
  set(${opt} OFF CACHE BOOL "" FORCE)
endforeach()
foreach(opt CHIAKI_ENABLE_SETSU CHIAKI_ENABLE_STEAMDECK_NATIVE CHIAKI_ENABLE_SPEEX CHIAKI_ENABLE_RUDP
            CHIAKI_ENABLE_FFMPEG_DECODER CHIAKI_ENABLE_PI_DECODER)
  set(${opt} OFF CACHE STRING "" FORCE)
endforeach()
# chiaki's own copy of curl, without what a session on the local network
# never uses - each of these would otherwise have to be linked in.
foreach(opt CURL_USE_LIBPSL CURL_USE_LIBSSH2 CURL_USE_LIBSSH CURL_BROTLI CURL_ZSTD USE_NGHTTP2 USE_LIBIDN2 CURL_ZLIB USE_WIN32_IDN)
  set(${opt} OFF CACHE BOOL "" FORCE)
endforeach()
set(CURL_DISABLE_LDAP ON CACHE BOOL "" FORCE)

include(FetchContent)
FetchContent_Declare(chiaki
  GIT_REPOSITORY https://github.com/streetpea/chiaki-ng.git
  GIT_TAG ${P5RP_CHIAKI_TAG}
  GIT_SHALLOW TRUE
  GIT_SUBMODULES third-party/nanopb third-party/jerasure third-party/gf-complete third-party/curl
)
FetchContent_MakeAvailable(chiaki)

add_executable(p5rp p5rp.c)
target_link_libraries(p5rp PRIVATE chiaki-lib)
if(WIN32)
  target_link_libraries(p5rp PRIVATE ws2_32 wsock32 bcrypt iphlpapi crypt32 secur32 advapi32 normaliz)
endif()
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(p5rp PRIVATE -Wall -Wextra)
endif()
