# The Remote Play session, native. Built on the same library and the same
# version the server's p5rp uses (see rpnative/), so a console that works
# there works here.
#
# Android brings two wrinkles that a Linux build does not have: the
# dependencies have to be cross-compiled too, and OpenSSL comes from the
# NDK's own prefab package rather than the system.
cmake_minimum_required(VERSION 3.22)
project(p5rp_jni C CXX)

set(P5RP_CHIAKI_TAG "v1.10.0" CACHE STRING "chiaki-ng version to build against")

include(FetchContent)
set(FETCHCONTENT_QUIET OFF)

# What a session on a local network never uses. Each of these would
# otherwise have to be cross-compiled as well.
foreach(opt CHIAKI_ENABLE_TESTS CHIAKI_ENABLE_CLI CHIAKI_ENABLE_GUI CHIAKI_ENABLE_ANDROID
            CHIAKI_LIB_ENABLE_OPUS CHIAKI_ENABLE_STEAM_SHORTCUT)
  set(${opt} OFF CACHE BOOL "" FORCE)
endforeach()
foreach(opt CHIAKI_ENABLE_SETSU CHIAKI_ENABLE_STEAMDECK_NATIVE CHIAKI_ENABLE_SPEEX CHIAKI_ENABLE_RUDP
            CHIAKI_ENABLE_FFMPEG_DECODER CHIAKI_ENABLE_PI_DECODER)
  set(${opt} OFF CACHE STRING "" FORCE)
endforeach()
foreach(opt CURL_USE_LIBPSL CURL_USE_LIBSSH2 CURL_USE_LIBSSH CURL_BROTLI CURL_ZSTD USE_NGHTTP2
            USE_LIBIDN2 CURL_ZLIB USE_WIN32_IDN BUILD_CURL_EXE)
  set(${opt} OFF CACHE BOOL "" FORCE)
endforeach()
set(CURL_DISABLE_LDAP ON CACHE BOOL "" FORCE)
set(CURL_USE_OPENSSL ON CACHE BOOL "" FORCE)

# OpenSSL for Android: the NDK's prefab package, pulled in by Gradle. It
# arrives as imported targets, while chiaki and its vendored curl both call
# find_package(OpenSSL) and expect the variables FindOpenSSL produces - so
# fill those in from the targets, in the cache, where find_path and
# find_library look before searching.
find_package(openssl REQUIRED CONFIG)
get_target_property(P5RP_SSL_LIB openssl::ssl IMPORTED_LOCATION)
get_target_property(P5RP_CRYPTO_LIB openssl::crypto IMPORTED_LOCATION)
get_target_property(P5RP_SSL_INCLUDES openssl::ssl INTERFACE_INCLUDE_DIRECTORIES)
list(GET P5RP_SSL_INCLUDES 0 P5RP_SSL_INCLUDE)
if(NOT EXISTS "${P5RP_SSL_INCLUDE}/openssl/opensslv.h")
  message(FATAL_ERROR "The OpenSSL prefab package has no headers at ${P5RP_SSL_INCLUDE}")
endif()
set(OPENSSL_INCLUDE_DIR "${P5RP_SSL_INCLUDE}" CACHE PATH "" FORCE)
set(OPENSSL_SSL_LIBRARY "${P5RP_SSL_LIB}" CACHE FILEPATH "" FORCE)
set(OPENSSL_CRYPTO_LIBRARY "${P5RP_CRYPTO_LIB}" CACHE FILEPATH "" FORCE)
set(OPENSSL_LIBRARIES ${P5RP_SSL_LIB} ${P5RP_CRYPTO_LIB})
set(OPENSSL_INCLUDE_DIRS "${P5RP_SSL_INCLUDE}")
set(OPENSSL_FOUND TRUE)
set(OPENSSL_USE_STATIC_LIBS OFF)
message(STATUS "OpenSSL for Android: ${P5RP_SSL_LIB} (headers ${P5RP_SSL_INCLUDE})")

# The three libraries chiaki-lib wants from the system, built from source.
FetchContent_Declare(json-c
  GIT_REPOSITORY https://github.com/json-c/json-c.git
  GIT_TAG json-c-0.17-20230812
  GIT_SHALLOW TRUE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_APPS OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(DISABLE_WERROR ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(json-c)

FetchContent_Declare(libevent
  GIT_REPOSITORY https://github.com/libevent/libevent.git
  GIT_TAG release-2.1.12-stable
  GIT_SHALLOW TRUE)
set(EVENT__DISABLE_TESTS ON CACHE BOOL "" FORCE)
set(EVENT__DISABLE_BENCHMARK ON CACHE BOOL "" FORCE)
set(EVENT__DISABLE_SAMPLES ON CACHE BOOL "" FORCE)
set(EVENT__DISABLE_REGRESS ON CACHE BOOL "" FORCE)
set(EVENT__LIBRARY_TYPE STATIC CACHE STRING "" FORCE)
FetchContent_MakeAvailable(libevent)

FetchContent_Declare(miniupnpc
  GIT_REPOSITORY https://github.com/miniupnp/miniupnp.git
  GIT_TAG miniupnpc_2_2_8
  GIT_SHALLOW TRUE
  SOURCE_SUBDIR miniupnpc)
set(UPNPC_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(UPNPC_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(UPNPC_BUILD_SAMPLE OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(miniupnpc)

FetchContent_Declare(chiaki
  GIT_REPOSITORY https://github.com/streetpea/chiaki-ng.git
  GIT_TAG ${P5RP_CHIAKI_TAG}
  GIT_SHALLOW TRUE
  GIT_SUBMODULES third-party/nanopb third-party/jerasure third-party/gf-complete third-party/curl)
FetchContent_MakeAvailable(chiaki)

add_library(p5rp_jni SHARED p5rp_jni.c)
target_link_libraries(p5rp_jni PRIVATE chiaki-lib android log)
target_compile_options(p5rp_jni PRIVATE -Wall -Wextra)
