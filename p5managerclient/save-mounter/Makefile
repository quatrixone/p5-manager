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

ELF := save-mounter.elf

CFLAGS := -O2 -Wl,-s -Wall -Werror
CFLAGS += -lSceUserService -lSceSystemService -lSceFsInternalForVsh

all: $(ELF)

$(ELF): main.c
	$(CC) $(CFLAGS) -o $@ $^

clean:
	rm -f $(ELF)
