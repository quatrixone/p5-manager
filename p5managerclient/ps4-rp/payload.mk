PS4SDK ?= $(HOME)/.cache/ps4-pin/ps4-payload-sdk/libPS4
CC := gcc
OBJCOPY := objcopy
COMMON := ../ps4-rp
CFLAGS := -I$(PS4SDK)/include -I$(COMMON) -Os -std=gnu11 -fno-builtin \
          -nostartfiles -nostdlib -fno-stack-protector -Wall -Wextra \
          -masm=intel -march=btver2 -mtune=btver2 -m64 -mabi=sysv -fpie -fPIC
LFLAGS := -L$(PS4SDK) -T $(PS4SDK)/linker.x -Wl,--build-id=none -nostartfiles -nostdlib
SOURCES := main.c $(COMMON)/common.c $(EXTRA_SOURCES)

all: $(TARGET)
$(TARGET): $(SOURCES) $(COMMON)/common.h $(COMMON)/tracer.h $(PS4SDK)/crt0.s $(PS4SDK)/libPS4.a
	$(CC) $(PS4SDK)/crt0.s $(SOURCES) -o payload.elf $(CFLAGS) $(LFLAGS) -lPS4
	$(OBJCOPY) -O binary payload.elf $(TARGET)

.PHONY: all
