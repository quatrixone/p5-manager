/*
 * LZ4 Compression - read-only image mounts (see lzc_image_mount.h).
 *
 * exFAT images are attached as an md(4) vnode disk and mounted read-only.
 * ShadowMountPlus by drakmor (GPL-3.0) mounts through LVD by default and
 * keeps its own record of the LVD units it attached, so this stays on md
 * units it never touches. The attach options, sector size and exFAT mount
 * options follow its MD backend (src/sm_image.c, include/sm_mount_defs.h).
 */

#include "lzc_image_mount.h"
#include "lzc_diag.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/mdioctl.h>
#include <sys/mount.h>
#include <sys/param.h>
#include <sys/stat.h>
#include <sys/uio.h>

#define LZC_MOUNT_ROOT "/mnt/lzc"
#define MD_CTRL_PATH "/dev/mdctl"
#define MD_SECTOR_SIZE_EXFAT 512u
#define MD_NODE_WAIT_US 100000
#define MD_NODE_WAIT_RETRIES 100

#define IOV(x) {(void *)(x), (x) ? strlen(x) + 1 : 0}

int
lzc_image_mount_supported(const char *image_path) {
  const char *dot = image_path ? strrchr(image_path, '.') : NULL;
  return dot && !strcasecmp(dot, ".exfat");
}

static int
path_under(const char *path, const char *root) {
  size_t n = strlen(root);
  return !strncmp(path, root, n) && (path[n] == 0 || path[n] == '/');
}

/* exFAT keeps its sector size in the boot sector (BytesPerSectorShift). */
static uint32_t
exfat_sector_size(const char *path) {
  unsigned char boot[512];
  int fd = open(path, O_RDONLY);
  uint32_t size = MD_SECTOR_SIZE_EXFAT;
  if(fd < 0) return size;
  if(pread(fd, boot, sizeof(boot), 0) == (ssize_t)sizeof(boot) &&
     !memcmp(boot + 3, "EXFAT   ", 8) && boot[0x6C] >= 9 && boot[0x6C] <= 12) {
    size = 1u << boot[0x6C];
  }
  close(fd);
  return size;
}

static int
wait_for_node(const char *devname, int should_exist) {
  struct stat st;
  for(int i = 0; i < MD_NODE_WAIT_RETRIES; i++) {
    int exists = stat(devname, &st) == 0;
    if(exists == !!should_exist) return 0;
    usleep(MD_NODE_WAIT_US);
  }
  return -1;
}

static int
md_detach(int unit) {
  char devname[32];
  struct md_ioctl req;
  int fd = open(MD_CTRL_PATH, O_RDWR);
  if(fd < 0) return -1;
  memset(&req, 0, sizeof(req));
  req.md_version = MDIOVERSION;
  req.md_unit = (unsigned)unit;
  int rc = ioctl(fd, MDIOCDETACH, &req);
  int e = errno;
  close(fd);
  if(rc != 0) {
    lzc_log("image mount detach md%d failed: %s", unit, strerror(e));
    return -1;
  }
  snprintf(devname, sizeof(devname), "/dev/md%d", unit);
  (void)wait_for_node(devname, 0);
  return 0;
}

/* The mount point still holds this unit's filesystem. */
static int
mount_is_ours(const char *mount_point, int unit) {
  struct statfs sfs;
  char devname[32];
  snprintf(devname, sizeof(devname), "/dev/md%d", unit);
  return statfs(mount_point, &sfs) == 0 &&
         !strcmp(sfs.f_mntonname, mount_point) &&
         !strcmp(sfs.f_mntfromname, devname);
}

int
lzc_image_mount_ro(const char *image_path, const char *title_id,
                   lzc_image_mount_t *m, char *err, size_t err_size) {
  struct stat st;
  char devname[32];
  char errmsg[256];
  if(!m) return -1;
  memset(m, 0, sizeof(*m));
  m->unit = -1;
  if(!lzc_image_mount_supported(image_path) || stat(image_path, &st) != 0 ||
     !S_ISREG(st.st_mode) || st.st_size <= 0) {
    snprintf(err, err_size, "%s", "image can't be mounted here");
    return -1;
  }

  struct md_ioctl req;
  memset(&req, 0, sizeof(req));
  req.md_version = MDIOVERSION;
  req.md_type = MD_VNODE;
  req.md_file = (char *)image_path;
  req.md_mediasize = st.st_size;
  req.md_sectorsize = exfat_sector_size(image_path);
  req.md_options = MD_AUTOUNIT | MD_ASYNC | MD_READONLY;

  int fd = open(MD_CTRL_PATH, O_RDWR);
  if(fd < 0) {
    snprintf(err, err_size, "open %s: %s", MD_CTRL_PATH, strerror(errno));
    return -1;
  }
  int rc = ioctl(fd, MDIOCATTACH, &req);
  int attach_errno = errno;
  close(fd);
  if(rc != 0) {
    snprintf(err, err_size, "attach image: %s", strerror(attach_errno));
    lzc_log("image mount attach failed path=%s sector=%u err=%s", image_path,
           req.md_sectorsize, err);
    return -1;
  }
  m->unit = (int)req.md_unit;
  snprintf(m->image_path, sizeof(m->image_path), "%s", image_path);
  snprintf(devname, sizeof(devname), "/dev/md%d", m->unit);
  if(wait_for_node(devname, 1) != 0) {
    snprintf(err, err_size, "%s did not appear", devname);
    md_detach(m->unit);
    m->unit = -1;
    return -1;
  }

  (void)mkdir(LZC_MOUNT_ROOT, 0777);
  snprintf(m->mount_point, sizeof(m->mount_point), "%s/%s-md%d", LZC_MOUNT_ROOT,
           title_id && title_id[0] ? title_id : "image", m->unit);
  if(mkdir(m->mount_point, 0777) != 0 && errno != EEXIST) {
    snprintf(err, err_size, "create mount point: %s", strerror(errno));
    md_detach(m->unit);
    m->unit = -1;
    m->mount_point[0] = 0;
    return -1;
  }

  memset(errmsg, 0, sizeof(errmsg));
  struct iovec iov[] = {
    IOV("from"), IOV(devname), IOV("fspath"), IOV(m->mount_point),
    IOV("fstype"), IOV("exfatfs"), IOV("budgetid"), IOV("game"),
    IOV("large"), IOV("yes"), IOV("timezone"), IOV("static"),
    IOV("async"), IOV(NULL), IOV("noatime"), IOV(NULL),
    IOV("ignoreacl"), IOV(NULL), IOV("automounted"), IOV(NULL),
    IOV("errmsg"), {(void *)errmsg, sizeof(errmsg)},
  };
  if(nmount(iov, (unsigned int)(sizeof(iov) / sizeof(iov[0])), (int)MNT_RDONLY) != 0) {
    int e = errno;
    snprintf(err, err_size, "mount image: %s%s%s", strerror(e),
             errmsg[0] ? " " : "", errmsg);
    lzc_log("image mount nmount failed path=%s dev=%s err=%s", image_path, devname, err);
    rmdir(m->mount_point);
    md_detach(m->unit);
    m->unit = -1;
    m->mount_point[0] = 0;
    return -1;
  }
  if(!mount_is_ours(m->mount_point, m->unit)) {
    snprintf(err, err_size, "%s", "mount image: the exFAT mount did not appear");
    lzc_image_unmount(m);
    return -1;
  }
  lzc_log("image mount ready path=%s dev=%s at=%s sector=%u", image_path,
         devname, m->mount_point, req.md_sectorsize);
  return 0;
}

int
lzc_image_unmount(lzc_image_mount_t *m) {
  int ok = 1;
  if(!m || m->unit < 0) return 0;
  if(m->mount_point[0]) {
    /* Only unmount and detach what is still ours. */
    if(mount_is_ours(m->mount_point, m->unit)) {
      if(unmount(m->mount_point, 0) != 0 &&
         unmount(m->mount_point, (int)MNT_FORCE) != 0) {
        lzc_log("image unmount failed at=%s err=%s", m->mount_point, strerror(errno));
        ok = 0;
      }
      if(ok && md_detach(m->unit) != 0) ok = 0;
    } else {
      lzc_log("image mount already gone at=%s; leaving md%d alone",
             m->mount_point, m->unit);
    }
    rmdir(m->mount_point);
  }
  lzc_log("image mount released path=%s unit=%d ok=%d", m->image_path, m->unit, ok);
  m->unit = -1;
  m->mount_point[0] = 0;
  return ok ? 0 : -1;
}

void
lzc_image_mount_cleanup_stale(void) {
  struct statfs *mnt = NULL;
  int count = getmntinfo(&mnt, MNT_NOWAIT);
  for(int i = 0; i < count; i++) {
    lzc_image_mount_t m;
    int unit = -1;
    if(!path_under(mnt[i].f_mntonname, LZC_MOUNT_ROOT) ||
       sscanf(mnt[i].f_mntfromname, "/dev/md%d", &unit) != 1) {
      continue;
    }
    memset(&m, 0, sizeof(m));
    m.unit = unit;
    snprintf(m.mount_point, sizeof(m.mount_point), "%s", mnt[i].f_mntonname);
    snprintf(m.image_path, sizeof(m.image_path), "%s", "(left by an earlier run)");
    lzc_image_unmount(&m);
  }
  DIR *d = opendir(LZC_MOUNT_ROOT);
  struct dirent *ent;
  while(d && (ent = readdir(d)) != NULL) {
    char path[512];
    if(ent->d_name[0] == '.') continue;
    snprintf(path, sizeof(path), "%s/%s", LZC_MOUNT_ROOT, ent->d_name);
    rmdir(path);
  }
  if(d) closedir(d);
}
