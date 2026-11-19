/* LZ4 Compression - read-only image mounts made by the engine itself.
 *
 * ShadowMountPlus refuses to mount anything while a game (or this app) is
 * running, and it only mounts the copy it has registered for a title. Jobs
 * that only read an image (LZ4 pack, read speed) mount it here instead:
 * attached as an md vnode disk and mounted read-only under /mnt/lzc, like
 * ShadowMountPlus's MD backend. */
#pragma once

#include <stddef.h>

typedef struct lzc_image_mount {
  int unit;
  char image_path[1024];
  char mount_point[256];
} lzc_image_mount_t;

/* 1 for the image kinds this can mount (.exfat). */
int lzc_image_mount_supported(const char *image_path);

/* Attach and mount read-only. 0 on success, -1 with err set. */
int lzc_image_mount_ro(const char *image_path, const char *title_id,
                       lzc_image_mount_t *m, char *err, size_t err_size);

/* Unmount and detach. 0 when everything was released. */
int lzc_image_unmount(lzc_image_mount_t *m);

/* Release mounts a previous engine run left under /mnt/lzc. */
void lzc_image_mount_cleanup_stale(void);
