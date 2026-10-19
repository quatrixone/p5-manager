# LZ4 Compression - standalone PS5 payload build.

SHELL := bash

ifeq ($(strip $(PS5_PAYLOAD_SDK)),)
$(error PS5_PAYLOAD_SDK is required, e.g. export PS5_PAYLOAD_SDK=/path/to/ps5-payload-sdk)
endif

include $(PS5_PAYLOAD_SDK)/toolchain/prospero.mk

PYTHON ?= python3
LLVM_BINDIR ?= $(shell dirname "$$(command -v clang-18 2>/dev/null || command -v clang 2>/dev/null || command -v llvm-strip-18 2>/dev/null || command -v llvm-strip 2>/dev/null || echo clang)" 2>/dev/null || echo .)
export LLVM_BINDIR
export LLVM_CONFIG

BIN := lz4-compression.elf
BUILD_VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

C_SRCS := src/lzc_main.c
C_SRCS += src/lzc_websrv.c
C_SRCS += src/lzc_api.c
C_SRCS += src/lzc_job.c
C_SRCS += src/lzc_diag.c
C_SRCS += src/lzc_notify.c
C_SRCS += src/lzc_power_guard.c
C_SRCS += src/lzc_app_installer.c
C_SRCS += src/lzc_shadowmount.c
C_SRCS += src/lzc_size_cache.c
C_SRCS += src/lzc_icon_thumb.c
C_SRCS += src/lzc_image_mount.c
C_SRCS += src/lzc_boot_files.c
C_SRCS += src/ampr_index.c
C_SRCS += src/asset.c
C_SRCS += src/pfs_compress.c
C_SRCS += src/pfs_decompress.c
C_SRCS += src/pfs_repair.c
C_SRCS += src/pfs_ampr_hotswap.c
C_SRCS += src/pfs_block_pipeline.c
C_SRCS += src/pfs_validate_hash.c
C_SRCS += src/miniz_tinfl.c
C_SRCS += src/ampr_pack.c
C_SRCS += src/ampr_pack_profile.c
C_SRCS += src/ampr_pack_toml.c
C_SRCS += src/ampr_pack_runtime.c
C_SRCS += third_party/qrcodegen/qrcodegen.c

ASSETS := $(wildcard assets/*)
GEN_SRCS := $(patsubst assets/%,gen/assets/%,$(ASSETS:=.c))
APP_ASSETS := assets-app/param.json assets-app/icon0.png assets-app/pic0.png
OBJS := $(patsubst %.c,build/%.o,$(C_SRCS) $(GEN_SRCS))

# Pinned ampr_emu PackedStdio runtime installed into LZ4-packed games.
AMPR_RUNTIME := third_party/ampr_emu/libSceAmpr.sprx
AMPR_RUNTIME_SHA256 := 69e6c4d5e4f5fb83c9e01815db5861c4c75734acbf4595cafa50d4c218116d1a
AMPR_RUNTIME_GEN := gen/ampr_runtime_blob.c
OBJS += build/gen/ampr_runtime_blob.o

# ampr_pack TOML profiles picked automatically for matching games.
PROFILES := profiles/index.json $(wildcard profiles/*.toml)
PROFILES_GEN := gen/lz4_profiles.c
OBJS += build/gen/lz4_profiles.o

LZ4_SRCS := lz4.c lz4hc.c
LZ4_OBJS := $(patsubst %.c,build/lz4/%.o,$(LZ4_SRCS))
OBJS += $(LZ4_OBJS)

CFLAGS_COMMON := -Os -Wall -Werror -Wno-unused-command-line-argument -Wno-unused-variable -Wno-unused-but-set-variable -Wno-unused-function -Isrc
CFLAGS_COMMON += -ffunction-sections -fdata-sections -flto
CFLAGS_COMMON += -DLZC_VERSION=\"$(BUILD_VERSION)\"
CFLAGS_COMMON += -DLZC_PORT=5920
CFLAGS_COMMON += -DVERSION_TAG=\"lz4-compression\"
CFLAGS_COMMON += -DBUILD_VERSION=\"$(BUILD_VERSION)\"
CFLAGS_COMMON += -DMINIZ_USE_UNALIGNED_LOADS_AND_STORES=1
CFLAGS_COMMON += -Ithird_party/lz4

FAST_SRCS := src/pfs_compress.c src/pfs_decompress.c src/pfs_repair.c src/pfs_ampr_hotswap.c src/pfs_block_pipeline.c src/pfs_validate_hash.c src/miniz_tinfl.c src/ampr_pack.c
FAST_OBJS := $(patsubst %.c,build/%.o,$(FAST_SRCS))

PFSC_ENCODER ?= runtime
PFSC_ZLIB_LEVEL ?= 7
PFSC_THRESHOLD_GAIN ?= 5
PFSC_FORCE_RAW_EXEC ?= 1
ZLIB_INCLUDE := third_party/zlib
ZLIB_LIB := build/zlib/libz.a
ZLIB_SRCS := adler32.c compress.c crc32.c deflate.c infback.c inffast.c inflate.c inftrees.c trees.c uncompr.c zutil.c
ZLIB_HEADERS := $(wildcard third_party/zlib/*.h)
ZLIB_OBJS := $(patsubst %.c,build/zlib/%.o,$(ZLIB_SRCS))

ifneq ($(filter $(PFSC_ENCODER),runtime zlib miniz),)
CFLAGS_COMMON += -DLZC_PFSC_ZLIB_LEVEL=$(PFSC_ZLIB_LEVEL)
CFLAGS_COMMON += -DLZC_PFSC_THRESHOLD_GAIN=$(PFSC_THRESHOLD_GAIN)
CFLAGS_COMMON += -DLZC_PFSC_FORCE_RAW_EXEC=$(PFSC_FORCE_RAW_EXEC)
CFLAGS_COMMON += -I$(ZLIB_INCLUDE)
else
$(error unsupported PFSC_ENCODER=$(PFSC_ENCODER), expected runtime, zlib, or miniz)
endif

FAST_CFLAGS := $(filter-out -Os,$(CFLAGS_COMMON)) -O2
LDFLAGS_COMMON := -Wl,--gc-sections -flto
LDADD := -lSceNotification -lSceSystemService
LDADD += $(ZLIB_LIB)

all: $(BIN)

check-sdk-fw1360:
	$(PYTHON) tools/check_sdk_fw1360.py "$(PS5_PAYLOAD_SDK)"

gen/assets:
	mkdir -p $@

gen/assets/%.c: assets/% | gen/assets
	$(PYTHON) gen-asset-module.py --path $* $< > $@

$(FAST_OBJS): build/%.o: %.c Makefile
	mkdir -p $(dir $@)
	"$(CC)" $(FAST_CFLAGS) -c $< -o $@

build/src/lzc_app_installer.o: $(APP_ASSETS)

$(AMPR_RUNTIME_GEN): $(AMPR_RUNTIME) tools/gen_binary_c.py
	mkdir -p $(dir $@)
	$(PYTHON) tools/gen_binary_c.py --symbol lzc_ampr_runtime_blob --sha256 $(AMPR_RUNTIME_SHA256) $< > $@.tmp
	mv $@.tmp $@

build/gen/ampr_runtime_blob.o: $(AMPR_RUNTIME_GEN)
	mkdir -p $(dir $@)
	"$(CC)" -O2 -c $< -o $@

$(PROFILES_GEN): $(PROFILES) tools/gen_profiles_c.py
	mkdir -p $(dir $@)
	$(PYTHON) tools/gen_profiles_c.py profiles/index.json > $@.tmp
	mv $@.tmp $@

build/gen/lz4_profiles.o: $(PROFILES_GEN) src/lzc_profiles.h
	mkdir -p $(dir $@)
	"$(CC)" -O2 -Isrc -c $< -o $@

build/lz4/%.o: third_party/lz4/%.c $(wildcard third_party/lz4/*.h) Makefile
	mkdir -p $(dir $@)
	"$(CC)" -O2 -ffunction-sections -fdata-sections -flto -Ithird_party/lz4 -c $< -o $@

build/zlib/%.o: third_party/zlib/%.c $(ZLIB_HEADERS) Makefile
	mkdir -p $(dir $@)
	"$(CC)" -O2 -I$(ZLIB_INCLUDE) -c $< -o $@

$(ZLIB_LIB): $(ZLIB_OBJS)
	"$(AR)" rcs $@ $(ZLIB_OBJS)

build/%.o: %.c Makefile
	mkdir -p $(dir $@)
	"$(CC)" $(CFLAGS_COMMON) -c $< -o $@

$(BIN): $(OBJS) $(APP_ASSETS) $(ZLIB_LIB) | check-sdk-fw1360
	"$(CC)" $(CFLAGS_COMMON) $(LDFLAGS_COMMON) -o $@ $(OBJS) $(LDADD)
	"$(STRIP)" --strip-all $@

clean:
	rm -rf build gen $(BIN)

.SECONDARY: $(GEN_SRCS)
.PHONY: all clean check-sdk-fw1360
