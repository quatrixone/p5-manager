#include "utils.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>

int sceKernelSendNotificationRequest(int, notify_request_t *, size_t, int);

void notifyf(const char *fmt, ...)
{
    notify_request_t req = {0};
    va_list args;
    va_start(args, fmt);
    vsnprintf(req.message, sizeof(req.message), fmt, args);
    va_end(args);
    sceKernelSendNotificationRequest(0, &req, sizeof(req), 0);
}

void notifyf_printf(const char *fmt, ...)
{
    notify_request_t req = {0};
    va_list args;
    va_start(args, fmt);
    vsnprintf(req.message, sizeof(req.message), fmt, args);
    va_end(args);
    sceKernelSendNotificationRequest(0, &req, sizeof(req), 0);

    printf("%s\n", req.message);
}

static const char base64_table[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

char *base64_encode(const unsigned char *input, int length)
{
    int output_length = 4 * ((length + 2) / 3);
    char *output = (char *)malloc(output_length + 1);
    if (output == NULL) {
        return NULL;
    }

    int i, j;
    for (i = 0, j = 0; i < length;) {
        uint32_t octet_a = i < length ? input[i++] : 0;
        uint32_t octet_b = i < length ? input[i++] : 0;
        uint32_t octet_c = i < length ? input[i++] : 0;

        uint32_t triple = (octet_a << 0x10) + (octet_b << 0x08) + octet_c;

        output[j++] = base64_table[(triple >> 3 * 6) & 0x3F];
        output[j++] = base64_table[(triple >> 2 * 6) & 0x3F];
        output[j++] = base64_table[(triple >> 1 * 6) & 0x3F];
        output[j++] = base64_table[(triple >> 0 * 6) & 0x3F];
    }

    for (int k = 0; k < (3 - length % 3) % 3; k++) {
        output[output_length - 1 - k] = '=';
    }

    output[output_length] = '\0';
    return output;
}

int base64_decode(const char *in, unsigned char *out, int out_max)
{
    /* Build a reverse lookup: each ASCII char -> its 0..63 value, or -1
     * for non-alphabet bytes. '=' is treated as padding and ignored. */
    static signed char rev[256];
    static int rev_init = 0;
    if (!rev_init) {
        for (int i = 0; i < 256; i++) rev[i] = -1;
        for (int i = 0; i < 64; i++) rev[(unsigned char)base64_table[i]] = (signed char)i;
        rev_init = 1;
    }

    int written = 0;
    uint32_t buf = 0;
    int bits = 0;
    for (const char *p = in; *p; p++) {
        unsigned char c = (unsigned char)*p;
        if (c == '=' || c == '\r' || c == '\n' || c == ' ' || c == '\t') continue;
        signed char v = rev[c];
        if (v < 0) return -1;
        buf = (buf << 6) | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (written >= out_max) return -1;
            out[written++] = (unsigned char)((buf >> bits) & 0xFF);
        }
    }
    return written;
}
