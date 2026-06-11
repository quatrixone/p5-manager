#pragma once

#include <stdarg.h>
#include <sys/types.h>
#include <stdint.h>

typedef struct notify_request
{
    char useless1[45];
    char message[3075];
} notify_request_t;

void notifyf(const char *fmt, ...);
void notifyf_printf(const char *fmt, ...);
char *base64_encode(const unsigned char *input, int length);

/* Decode standard base64 (with '+' / '/' and optional '=' padding) into
 * `out`, writing at most `out_max` bytes. Returns the number of decoded
 * bytes on success, or -1 on bad input. Used to read host-supplied
 * account_id from the trigger file. */
int base64_decode(const char *in, unsigned char *out, int out_max);
