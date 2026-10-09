#include "common.h"
#include <stdarg.h>

static int log_fd = -1;
static int (*rp_vsnprintf)(char *, size_t, const char *, va_list);
int (*rp_get_int)(uint32_t, int *);
int (*rp_get_bin)(uint32_t, void *, size_t);
int (*rp_get_str)(uint32_t, char *, size_t);
int (*rp_set_int)(uint32_t, int);
int (*rp_set_bin)(uint32_t, const void *, size_t);
int (*rp_set_str)(uint32_t, const char *, size_t);

void rp_log(const char *format, ...) {
  char line[512];
  va_list args;
  va_start(args, format);
  if (!rp_vsnprintf) { va_end(args); return; }
  int n = rp_vsnprintf(line, sizeof(line), format, args);
  va_end(args);
  if (n <= 0) return;
  if (n >= (int)sizeof(line)) n = sizeof(line) - 1;
  for (int sent = 0; log_fd >= 0 && sent < n;) {
    int rc = syscall(4, log_fd, line + sent, n - sent);
    if (rc <= 0) break;
    sent += rc;
  }
}

void rp_close(void) {
  if (log_fd >= 0) syscall(6, log_fd);
  log_fd = -1;
}

uintptr_t rp_symbol(const char *module, const char *name) {
  int handles[256], count = 0;
  if (getLoadedModules(handles, 256, &count) == 0) {
    for (int i = 0; i < count && i < 256; i++) {
      void *addr = NULL;
      if (getFunctionAddressByName(handles[i], (char *)name, &addr) == 0 && addr)
        return (uintptr_t)addr;
    }
  }
  int handle = sceKernelLoadStartModule(module, 0, NULL, 0, 0, 0);
  void *addr = NULL;
  if (handle >= 0 && getFunctionAddressByName(handle, (char *)name, &addr) == 0)
    return (uintptr_t)addr;
  return 0;
}

int rp_init(const char *log_path) {
  initKernel(); initLibc(); initSysUtil(); initModule();
  if (jailbreak()) return -1;
  rp_vsnprintf = (void *)rp_symbol("libSceLibcInternal.sprx", "vsnprintf");
  if (!rp_vsnprintf) return -1;
  log_fd = syscall(5, log_path, 0x601, 0600); /* WRONLY|CREAT|TRUNC */
  if (log_fd < 0) {
    printf_notification("P5 Manager: could not open PS4 payload log");
    return -1;
  }
  rp_log("[ps4-rp] pid=%d\n", getpid());
  rp_get_int = (void *)rp_symbol("libSceRegMgr.sprx", "sceRegMgrGetInt");
  rp_get_bin = (void *)rp_symbol("libSceRegMgr.sprx", "sceRegMgrGetBin");
  rp_get_str = (void *)rp_symbol("libSceRegMgr.sprx", "sceRegMgrGetStr");
  if (!rp_get_int || !rp_get_bin || !rp_get_str) {
    rp_log("Error: could not resolve PS4 registry readers\nDone\n");
    rp_close();
    return -1;
  }
  return 0;
}

uint32_t rp_key(int slot, uint32_t base) {
  return base + (uint32_t)(slot - 1) * 0x10000u;
}

int rp_foreground_user(rp_user *user) {
  memset(user, 0, sizeof(*user));
  int (*initialize)(void *) = (void *)rp_symbol("libSceUserService.sprx", "sceUserServiceInitialize");
  int (*foreground)(int *) = (void *)rp_symbol("libSceUserService.sprx", "sceUserServiceGetForegroundUser");
  if (!initialize || !foreground) return -1;
  initialize(NULL); /* May already be initialized by the loader. */
  int rc = foreground(&user->user_id);
  if (rc) { rp_log("Error: foreground user rc=0x%x\n", rc); return -1; }
  for (int slot = 1; slot <= 16; slot++) {
    int id = -1;
    if (rp_get_int(rp_key(slot, PS4_USER_ID_BASE), &id) == 0 && id == user->user_id) {
      user->slot = slot;
      rc = rp_get_bin(rp_key(slot, PS4_ACCOUNT_ID_BASE), &user->account_id, 8);
      if (rc) { rp_log("Error: account ID read rc=0x%x\n", rc); return -1; }
      rp_get_str(rp_key(slot, PS4_USER_NAME_BASE), user->name, sizeof(user->name));
      user->name[sizeof(user->name)-1] = 0;
      return 0;
    }
  }
  rp_log("Error: foreground user 0x%x has no registry slot\n", user->user_id);
  return -1;
}

void rp_print_account(const rp_user *user) {
  size_t length = 0;
  unsigned char *encoded = base64_encode((const unsigned char *)&user->account_id, 8, &length);
  if (!encoded) { rp_log("Error: account ID encoding failed\n"); return; }
  rp_log("User: %s\nSlot: %d\nAccount ID: %s\nAccount ID hex: %016llx\n",
         user->name, user->slot, encoded, (unsigned long long)user->account_id);
  free(encoded);
}

int rp_read_trigger(uint64_t *account_id) {
  *account_id = 0;
  int fd = syscall(5, PS4_TRIGGER_PATH, 0, 0);
  if (fd < 0) return 0;
  char body[512];
  int n = syscall(3, fd, body, sizeof(body)-1);
  syscall(6, fd);
  if (n <= 0) return -1;
  body[n] = 0;
  char *line = body;
  while (*line) {
    char *end = strchr(line, '\n');
    if (end) *end = 0;
    size_t len = strlen(line);
    if (len && line[len-1] == '\r') line[--len] = 0;
    if (len && line[0] != '#') {
      if (len != 12 || line[11] != '=') return -1;
      size_t decoded_size = 0;
      unsigned char *raw = base64_decode((unsigned char *)line, len, &decoded_size);
      if (!raw || decoded_size != 8) { if (raw) free(raw); return -1; }
      memcpy(account_id, raw, 8); free(raw);
      return *account_id ? 1 : -1;
    }
    if (!end) break;
    line = end + 1;
  }
  return -1;
}

int rp_find_process(const char *name) {
  int mib[3] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL};
  size_t len = 0;
  if (sysctl(mib, 3, NULL, &len, NULL, 0) < 0 || !len || len > 16*1024*1024) return -1;
  char *buffer = malloc(len);
  if (!buffer) return -1;
  int pid = -1;
  if (sysctl(mib, 3, buffer, &len, NULL, 0) == 0) {
    for (size_t offset = 0; offset + sizeof(struct kinfo_proc) < len;) {
      struct kinfo_proc *proc = (void *)(buffer + offset);
      if (proc->structSize <= (int)sizeof(*proc) || offset + proc->structSize > len) break;
      size_t available = proc->structSize - sizeof(*proc);
      if (strlen(name) < available && !strncmp(proc->name, name, strlen(name)+1)) { pid = proc->pid; break; }
      offset += proc->structSize;
    }
  }
  free(buffer);
  return pid;
}
