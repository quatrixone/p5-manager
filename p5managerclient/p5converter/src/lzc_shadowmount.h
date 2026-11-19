#ifndef LZC_SHADOWMOUNT_H
#define LZC_SHADOWMOUNT_H

#include <stddef.h>

#include "pfs_compress.h"

int lzc_shadowmount_write_pfsc_hints(const char *outer_path,
                                    const char *nested_name,
                                    int nested_type,
                                    char *err,
                                    size_t err_size);
int lzc_shadowmount_prepare_pfsc_hints_for_title(const char *title_id,
                                                const char *outer_path,
                                                const char *nested_name,
                                                int nested_type,
                                                char *err,
                                                size_t err_size);
int lzc_shadowmount_prepare_image_hints_for_title(const char *title_id,
                                                 const char *image_path,
                                                 int nested_type,
                                                 char *err,
                                                 size_t err_size);
int lzc_shadowmount_ensure_image_read_only(const char *image_path,
                                          int *already_present,
                                          char *err,
                                          size_t err_size);
int lzc_shadowmount_remove_pfsc_hints(const char *outer_path,
                                     const char *nested_name,
                                     int nested_type,
                                     char *err,
                                     size_t err_size);
int lzc_shadowmount_remove_title_pfsc_hints(const char *title_id,
                                           const char *outer_path,
                                           char *err,
                                           size_t err_size);
int lzc_shadowmount_remove_outer_sector_hint(const char *outer_path,
                                            char *err,
                                            size_t err_size);

int lzc_shadowmount_request_source_scan(const char *source_path,
                                       char *err,
                                       size_t err_size);
int lzc_shadowmount_request_title_source_scan(const char *title_id,
                                             const char *source_path,
                                             char *err,
                                             size_t err_size);
int lzc_shadowmount_request_scan(char *err, size_t err_size);
/* 0 on success, -<HTTP status> when ShadowMountPlus refuses (-409 while a
 * game is running), -1 when its API can't be reached. */
int lzc_shadowmount_request_mount(const char *title_id);
int lzc_shadowmount_request_unmount(const char *title_id);
int lzc_shadowmount_manual_remove_source(const char *source_path, char *err,
                                         size_t err_size);
int lzc_shadowmount_restart_running(char *detail, size_t detail_size);

#endif
