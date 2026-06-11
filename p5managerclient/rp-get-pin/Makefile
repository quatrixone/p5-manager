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

ELF := rp-get-pin.elf

CFLAGS := -O2 -Wl,-s -lkernel_sys -lSceRegMgr -lSceUserService -DOUTPUT_FILENAME=\"$(ELF)\" -Wunused-function -Wno-unsequenced

all: $(ELF)

$(ELF): main.c ptrace.c utils.c
	$(CC) $(CFLAGS) -o $@ $^

clean:
	rm -f $(ELF)

send: $(ELF)
	socat -t 99999999 - TCP:192.168.137.2:9021 < $(ELF)
