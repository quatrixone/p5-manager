# Prefer the vendored in-tree SDK at p5managerclient/sdk so `make` works
# straight from a fresh clone (after the user has run the SDK bootstrapper
# once). Falls back to $PS5_PAYLOAD_SDK if the user keeps an external SDK.
ifndef PS5_PAYLOAD_SDK
    LOCAL_SDK := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))../sdk)
    ifneq ($(wildcard $(LOCAL_SDK)/toolchain/prospero.mk),)
        PS5_PAYLOAD_SDK := $(LOCAL_SDK)
    endif
endif

ifdef PS5_PAYLOAD_SDK
    include $(PS5_PAYLOAD_SDK)/toolchain/prospero.mk
else
    $(error PS5_PAYLOAD_SDK is undefined and no in-tree SDK found at p5managerclient/sdk)
endif

ELF := pkg-install.elf

# We deliberately do NOT link -lSceAppInstUtil. The payload resolves
# sceAppInstUtilInitialize / sceAppInstUtilInstallByPackage /
# sceAppInstUtilGetInstallStatus at runtime via sceKernelDlsym so the
# binary keeps working across firmwares where SDK stub linkage drifts.
CFLAGS := -O2 -Wl,-s

# Override the trigger path at build time if you reconfigure
# `pkg_trigger_file` in P5 Manager → Settings → Config:
#
#   make TRIGGER_PATH=/data/my-installer-trigger.txt
ifdef TRIGGER_PATH
    CFLAGS += -DTRIGGER_PATH=\"$(TRIGGER_PATH)\"
endif

all: $(ELF)

$(ELF): main.c
	$(CC) $(CFLAGS) -o $@ $^

clean:
	rm -f $(ELF)

# Quick smoke-send to a PS5 on the LAN once the file is built.
# Override PS5 with the right IP first: `make send PS5=10.0.0.50`.
PS5 ?= 192.168.137.2
send: $(ELF)
	socat -t 99999999 - TCP:$(PS5):9021 < $(ELF)
