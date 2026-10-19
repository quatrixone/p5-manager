#ifndef LZC_ICON_THUMB_H
#define LZC_ICON_THUMB_H

#include <stddef.h>
#include <sys/stat.h>

#define LZC_ICON_THUMB_SIZE 256

int lzc_icon_thumb_path(const char *title_id,
                       const char *source_path,
                       const struct stat *source_st,
                       char *out_path,
                       size_t out_path_size);

/* PNG (grayscale, 4-module quiet zone) of a QR code for text, malloc'd;
 * NULL if the text doesn't fit a QR code. scale is pixels per module. */
unsigned char *lzc_qr_png(const char *text, int scale, int *out_len);

#endif
