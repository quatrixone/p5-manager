// save-mounter-ps4 - mounts one PS4 save decrypted, for P5 Manager.
//
// A PS4 save is two files in /user/home/<user>/savedata/<title>/:
//   sdimg_<name>   the PFS image, encrypted
//   <name>.bin     the sealed key, 0x60 bytes, sealed with the console's own
//                  key - which is why no PC and no other console can open
//                  the save, and why this has to run here.
//
// Unsealing is an ioctl on /dev/sbl_srv (the Secure Boot Loader service);
// the plain key then goes to sceFsMountSaveData out of the VSH-private
// libSceFsInternalForVsh.sprx, which mounts the image where FTP can read
// it. libPS4's jailbreak() already gives us what that needs: uid 0, the
// sony credential, process authority 0x3801000000000013 and no sandbox,
// so the devices and /system/priv are reachable without mknod tricks.
//
// Method and ioctl numbers from hzhreal/PS4-vsh-utils (MIT) and
// bucanero/apollo-ps4 (GPL-3.0); the code here is our own.
//
// It is driven by P5 Manager over FTP (backend/src/lib/ps4SaveExport.js):
// one command line in /data/.p5manager-save-ps4, read when the payload
// starts, and the answer in /data/.p5manager-save-ps4.log.
//
//   MOUNT <user id hex> <title id> <save name>
//   UMOUNT
//
// The save is mounted where it lies: P5 Manager only reads it, and the
// console's own copy is what the user wants transferred anyway.
#include "common.h"

#define CMD_PATH "/data/.p5manager-save-ps4"
#define LOG_PATH "/data/.p5manager-save-ps4.log"
#define MOUNT_PATH "/data/p5manager-save-ps4-mount"
#define SBL_DEVICE "/dev/sbl_srv"
#define VSH_FS_LIB "/system/priv/lib/libSceFsInternalForVsh.sprx"

#define ENC_KEY_LEN 0x60
#define DEC_KEY_LEN 0x20
#define SBL_DECRYPT_SEALED_KEY 0xC0845302

typedef struct { uint8_t reserved; char *budgetid; } MountSaveDataOpt;
typedef struct { uint8_t dummy; } UmountSaveDataOpt;

static int (*fs_init_mount_opt)(MountSaveDataOpt *);
static int (*fs_mount_save)(MountSaveDataOpt *, const char *, const char *, uint8_t *);
static int (*fs_init_umount_opt)(UmountSaveDataOpt *);
static int (*fs_umount_save)(UmountSaveDataOpt *, const char *, int, int);

static int resolve_fs(void) {
  fs_init_mount_opt = (void *)rp_symbol(VSH_FS_LIB, "sceFsInitMountSaveDataOpt");
  fs_mount_save = (void *)rp_symbol(VSH_FS_LIB, "sceFsMountSaveData");
  fs_init_umount_opt = (void *)rp_symbol(VSH_FS_LIB, "sceFsInitUmountSaveDataOpt");
  fs_umount_save = (void *)rp_symbol(VSH_FS_LIB, "sceFsUmountSaveData");
  return fs_init_mount_opt && fs_mount_save && fs_init_umount_opt && fs_umount_save ? 0 : -1;
}

// The sealed key as it lies next to the save, turned into the key the
// mount wants. The buffer handed to the ioctl holds both: the sealed key
// goes in at 0, the plain one comes back right after it.
static int unseal_key(const char *key_path, uint8_t out[DEC_KEY_LEN]) {
  uint8_t data[ENC_KEY_LEN + DEC_KEY_LEN];
  memset(data, 0, sizeof(data));
  int fd = open(key_path, 0 /* O_RDONLY */, 0);
  if (fd < 0) { rp_log("Error: sealed key could not be read (%s)\n", key_path); return -1; }
  ssize_t n = read(fd, data, ENC_KEY_LEN);
  close(fd);
  if (n != ENC_KEY_LEN) { rp_log("Error: sealed key is %d bytes, expected %d\n", (int)n, ENC_KEY_LEN); return -1; }

  int dev = open(SBL_DEVICE, 2 /* O_RDWR */, 0);
  if (dev < 0) { rp_log("Error: %s could not be opened - is the jailbreak complete?\n", SBL_DEVICE); return -1; }
  int rc = ioctl(dev, SBL_DECRYPT_SEALED_KEY, data);
  close(dev);
  if (rc < 0) { rp_log("Error: key decryption rc=0x%x\n", rc); return -1; }

  memcpy(out, data + ENC_KEY_LEN, DEC_KEY_LEN);
  return 0;
}

// A token up to `max` characters, stopping at whitespace. Returns what is
// left of the line, or NULL when there was no token.
static char *token(char *line, char *out, int max) {
  while (*line == ' ' || *line == '\t') line++;
  if (!*line) return NULL;
  int n = 0;
  while (*line && *line != ' ' && *line != '\t' && *line != '\r' && *line != '\n') {
    if (n < max - 1) out[n++] = *line;
    line++;
  }
  out[n] = 0;
  return line;
}

// Letters, digits and - _ . only: the command file decides which paths we
// build, so nothing in it may walk out of the save's own folder.
static int plain_name(const char *s, int max) {
  int n = 0;
  for (; s[n]; n++) {
    char c = s[n];
    int ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
      || c == '-' || c == '_' || c == '.';
    if (!ok) return 0;
  }
  return n > 0 && n <= max;
}

static int read_command(char *line, int size) {
  int fd = open(CMD_PATH, 0, 0);
  if (fd < 0) return -1;
  ssize_t n = read(fd, line, size - 1);
  close(fd);
  if (n <= 0) return -1;
  line[n] = 0;
  for (int i = 0; line[i]; i++) if (line[i] == '\r' || line[i] == '\n') { line[i] = 0; break; }
  return 0;
}

static int do_umount(int quiet) {
  UmountSaveDataOpt opt;
  memset(&opt, 0, sizeof(opt));
  fs_init_umount_opt(&opt);
  int rc = fs_umount_save(&opt, MOUNT_PATH, 0, 1 /* ignore errors */);
  if (rc < 0) {
    if (!quiet) rp_log("Error: unmount rc=0x%x\n", rc);
    return -1;
  }
  rmdir(MOUNT_PATH);
  if (!quiet) rp_log("Unmounted\n");
  return 0;
}

static int do_mount(const char *user, const char *title, const char *dir) {
  char folder[256], volume[320], key_path[320];
  uint8_t key[DEC_KEY_LEN];
  memset(key, 0, sizeof(key));

  sprintf(folder, "/user/home/%s/savedata/%s", user, title);
  sprintf(volume, "%s/sdimg_%s", folder, dir);
  sprintf(key_path, "%s/%s.bin", folder, dir);

  struct stat st;
  if (stat(volume, &st) < 0) { rp_log("Error: no save at %s\n", volume); return -1; }
  if (unseal_key(key_path, key)) return -1;

  // A mount left over from an interrupted run would make this one fail.
  do_umount(1);
  mkdir(MOUNT_PATH, 0777);

  MountSaveDataOpt opt;
  memset(&opt, 0, sizeof(opt));
  fs_init_mount_opt(&opt);
  opt.budgetid = "system";
  int rc = fs_mount_save(&opt, volume, MOUNT_PATH, key);
  if (rc < 0) { rp_log("Error: mount rc=0x%x\n", rc); rmdir(MOUNT_PATH); return -1; }

  rp_log("Source: %s\nMount point: %s\n", volume, MOUNT_PATH);
  return 0;
}

int _main(void) {
  if (rp_init(LOG_PATH)) return 0;

  char line[256];
  if (read_command(line, sizeof(line))) { rp_log("Error: missing command\nDone\n"); rp_close(); return 0; }
  if (resolve_fs()) { rp_log("Error: PS4 internal filesystem API unavailable\nDone\n"); rp_close(); return 0; }

  char verb[16], user[16], title[16], dir[64];
  char *rest = token(line, verb, sizeof(verb));
  if (rest && !strcmp(verb, "UMOUNT")) {
    do_umount(0);
    rp_log("Done\n");
    rp_close();
    return 0;
  }

  rest = rest ? token(rest, user, sizeof(user)) : NULL;
  rest = rest ? token(rest, title, sizeof(title)) : NULL;
  rest = rest ? token(rest, dir, sizeof(dir)) : NULL;
  if (!rest || !plain_name(user, 8) || !plain_name(title, 9) || !plain_name(dir, 31)) {
    rp_log("Error: invalid mount command\nDone\n");
    rp_close();
    return 0;
  }

  if (do_mount(user, title, dir) == 0)
    printf_notification("P5 Manager: %s/%s mounted for export", title, dir);
  rp_log("Done\n");
  rp_close();
  return 0;
}
