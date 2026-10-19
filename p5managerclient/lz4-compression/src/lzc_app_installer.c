/*
 * LZ4 Compression - install the PS5 home-screen web launcher tile.
 */

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include <ps5/kernel.h>

#include "lzc_app_installer.h"
#include "lzc_diag.h"
#include "lzc_notify.h"
#include "lzc_paths.h"

#define LZC_APP_ROOT "/user/app"
#define LZC_APP_PARENT LZC_APP_ROOT "/"
#define LZC_DATA_ROOT "/data"
#define LZC_DATA_DIR LZC_APP_DATA_DIR
#define LZC_MARKER_PATH LZC_DATA_DIR "/launcher.ok"
#define LZC_INSTALL_MARKER "lz4-compression-launcher-v1\n"
#define LZC_APPINST_MODULE "libSceAppInstUtil.sprx"
#define LZC_APPINST_PATH "/system/common/lib/libSceAppInstUtil.sprx"
#define LZC_USER_SERVICE_MODULE "libSceUserService.sprx"
#define LZC_USER_SERVICE_PATH "/system/common/lib/libSceUserService.sprx"
#define LZC_NETCTL_MODULE "libSceNetCtl.sprx"
#define LZC_NETCTL_PATH "/system/common/lib/libSceNetCtl.sprx"
#define LZC_NID_INSTALL_TITLE_DIR "Wudg3Xe3heE"

#define INCASSET(name, file)                                                   \
  __asm__(".section .rodata\n"                                                 \
          ".global " #name "\n"                                                \
          ".global " #name "_size\n"                                           \
          ".align 16\n" #name ":\n"                                            \
          ".incbin \"" file "\"\n.L" #name "_end:\n" #name "_size:\n"          \
          ".quad .L" #name "_end - " #name "\n"                                \
          ".previous\n");                                                      \
  extern const uint8_t name[];                                                 \
  extern const size_t name##_size

INCASSET(lzc_launcher_param_json, "assets-app/param.json");
INCASSET(lzc_launcher_icon0_png, "assets-app/icon0.png");
INCASSET(lzc_launcher_pic0_png, "assets-app/pic0.png");

typedef int (*app_install_title_dir_fn)(const char *, const char *, void *);
typedef int (*appinst_initialize_fn)(void);
typedef int (*appinst_install_all_fn)(void *);
typedef int (*appinst_uninstall_fn)(const char *);
typedef int (*netctl_init_fn)(void);
typedef int (*user_service_initialize_fn)(void *);

int sceKernelLoadStartModule(const char *, size_t, const void *, uint32_t,
                             void *, int *);

typedef struct appinst_api {
  appinst_initialize_fn      initialize;
  app_install_title_dir_fn install_title_dir;
  appinst_install_all_fn     install_all;
  appinst_uninstall_fn       uninstall;
} appinst_api_t;

static pthread_mutex_t g_launcher_start_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t g_launcher_install_lock = PTHREAD_MUTEX_INITIALIZER;
static int g_launcher_started = 0;

static const uint8_t g_install_marker[] = LZC_INSTALL_MARKER;

static int
resolve_module_handle(const char *module, const char *path, uint32_t *handle) {
  int rc = kernel_dynlib_handle(-1, module, handle);
  if(rc == 0) return 0;

  if(path && path[0]) {
    int load_rc = sceKernelLoadStartModule(path, 0, NULL, 0, NULL, NULL);
    lzc_log("launcher load module %s rc=0x%08x", path, (unsigned)load_rc);
    if(load_rc > 0) {
      *handle = (uint32_t)load_rc;
      return 0;
    }

    rc = kernel_dynlib_handle(-1, module, handle);
    if(rc == 0) return 0;
  }

  return rc;
}

static int
resolve_module_nid(const char *module, const char *path, const char *nid,
                   void **out) {
  uint32_t handle = 0;
  void *addr = NULL;

  if(out) *out = NULL;
  if(!module || !nid || !out) return -1;

  int rc = resolve_module_handle(module, path, &handle);
  if(rc != 0) return rc;

  addr = (void *)kernel_dynlib_resolve(-1, handle, nid);
  if(!addr) return -2;

  *out = addr;
  return 0;
}

static int
resolve_module_symbol(const char *module, const char *path, const char *symbol,
                      void **out) {
  uint32_t handle = 0;
  void *addr = NULL;

  if(out) *out = NULL;
  if(!module || !symbol || !out) return -1;

  int rc = resolve_module_handle(module, path, &handle);
  if(rc != 0) return rc;

  addr = (void *)kernel_dynlib_dlsym(-1, handle, symbol);
  if(!addr) return -2;

  *out = addr;
  return 0;
}

static void
resolve_appinst(appinst_api_t *api) {
  memset(api, 0, sizeof(*api));

  int init_rc = resolve_module_symbol(LZC_APPINST_MODULE, LZC_APPINST_PATH,
                                      "sceAppInstUtilInitialize",
                                      (void **)&api->initialize);
  int title_rc = resolve_module_nid(LZC_APPINST_MODULE, LZC_APPINST_PATH,
                                    LZC_NID_INSTALL_TITLE_DIR,
                                    (void **)&api->install_title_dir);
  int all_rc = resolve_module_symbol(LZC_APPINST_MODULE, LZC_APPINST_PATH,
                                     "sceAppInstUtilAppInstallAll",
                                     (void **)&api->install_all);
  int uninstall_rc = resolve_module_symbol(LZC_APPINST_MODULE, LZC_APPINST_PATH,
                                           "sceAppInstUtilAppUnInstall",
                                           (void **)&api->uninstall);

  lzc_log("launcher resolve AppInst init=%s rc=0x%08x titleDir=%s rc=0x%08x "
         "installAll=%s rc=0x%08x uninstall=%s rc=0x%08x",
         api->initialize ? "ok" : "missing", (unsigned)init_rc,
         api->install_title_dir ? "ok" : "missing", (unsigned)title_rc,
         api->install_all ? "ok" : "missing", (unsigned)all_rc,
         api->uninstall ? "ok" : "missing", (unsigned)uninstall_rc);
}

static int
probe_dir_writable(const char *dir) {
  char probe[256];
  int n = snprintf(probe, sizeof(probe), "%s/.lzc_launcher_write_probe", dir);
  if(n < 0 || (size_t)n >= sizeof(probe)) return 0;

  int fd = open(probe, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if(fd < 0) return 0;

  close(fd);
  unlink(probe);
  return 1;
}

static int
mkdir_if_needed(const char *path) {
  if(mkdir(path, 0755) == 0) return 0;
  return errno == EEXIST ? 0 : -1;
}

static void
unlink_if_exists(const char *path) {
  if(unlink(path) != 0 && errno != ENOENT) {
    lzc_log("launcher remove unlink %s failed errno=%d", path, errno);
  }
}

static void
rmdir_if_exists(const char *path) {
  if(rmdir(path) != 0 && errno != ENOENT) {
    lzc_log("launcher remove rmdir %s failed errno=%d", path, errno);
  }
}

static int
write_file(const char *path, const uint8_t *data, size_t size) {
  FILE *file = fopen(path, "wb");
  if(!file) return -1;

  size_t written = fwrite(data, 1, size, file);
  int close_rc = fclose(file);

  return (written == size && close_rc == 0) ? 0 : -1;
}

static int
ensure_data_dir(void) {
  if(mkdir_if_needed(LZC_DATA_ROOT) != 0) return -1;
  return mkdir_if_needed(LZC_DATA_DIR);
}

static int
install_app(const appinst_api_t *api, const char *title_id, const char *dir) {
  if(api->install_title_dir) {
    int err = api->install_title_dir(title_id, dir, NULL);
    if(err == 0) return 0;
    lzc_log("launcher install AppInstallTitleDir failed rc=0x%08x",
           (unsigned)err);
  } else {
    lzc_log("launcher install AppInstallTitleDir not resolved");
  }

  if(!api->install_all) {
    return -ENOSYS;
  }

  int err = api->install_all(NULL);
  lzc_log("launcher install AppInstallAll rc=0x%08x", (unsigned)err);
  return err;
}

static int
uninstall_launcher_title(const appinst_api_t *api, const char *title_id,
                         const char *label) {
  if(!api->uninstall) {
    lzc_log("launcher install remove %s skipped: AppUnInstall missing", label);
    return -ENOSYS;
  }

  int err = api->uninstall(title_id);
  lzc_log("launcher install remove %s rc=0x%08x", label, (unsigned)err);
  return err;
}

static void
init_ps5_services(void) {
  int user_prio = 256;
  netctl_init_fn netctl_init = NULL;
  user_service_initialize_fn user_service_initialize = NULL;

  int netctl_resolve_rc =
      resolve_module_symbol(LZC_NETCTL_MODULE, LZC_NETCTL_PATH, "sceNetCtlInit",
                            (void **)&netctl_init);
  if(netctl_init) {
    int netctl_rc = netctl_init();
    lzc_log("launcher sceNetCtlInit rc=0x%08x", (unsigned)netctl_rc);
  } else {
    lzc_log("launcher sceNetCtlInit skipped resolve rc=0x%08x",
           (unsigned)netctl_resolve_rc);
  }

  int user_resolve_rc =
      resolve_module_symbol(LZC_USER_SERVICE_MODULE, LZC_USER_SERVICE_PATH,
                            "sceUserServiceInitialize",
                            (void **)&user_service_initialize);
  if(user_service_initialize) {
    int user_service_rc = user_service_initialize(&user_prio);
    lzc_log("launcher sceUserServiceInitialize rc=0x%08x",
           (unsigned)user_service_rc);
  } else {
    lzc_log("launcher sceUserServiceInitialize skipped resolve rc=0x%08x",
           (unsigned)user_resolve_rc);
  }
}

/* Kept for the web-launcher tile of 1.3.0 test builds; no longer called. */
__attribute__((unused)) static int
lzc_install_app_if_needed(void) {
  appinst_api_t api;
  char app_dir[256];
  char sce_sys_dir[256];
  char param_path[256];
  char icon_path[256];
  char pic0_path[256];
  char pic1_path[256];

  resolve_appinst(&api);

  int user_app_writable = probe_dir_writable(LZC_APP_ROOT);
  lzc_log("launcher install %s writable=%d", LZC_APP_ROOT,
         user_app_writable);

  snprintf(app_dir, sizeof(app_dir), LZC_APP_ROOT "/%s",
           LZC_LAUNCHER_TITLE_ID);
  snprintf(sce_sys_dir, sizeof(sce_sys_dir), "%s/sce_sys", app_dir);
  snprintf(param_path, sizeof(param_path), "%s/param.json", sce_sys_dir);
  snprintf(icon_path, sizeof(icon_path), "%s/icon0.png", sce_sys_dir);
  snprintf(pic0_path, sizeof(pic0_path), "%s/pic0.png", sce_sys_dir);
  snprintf(pic1_path, sizeof(pic1_path), "%s/pic1.png", sce_sys_dir);

  if(!api.initialize) {
    lzc_log("launcher install AppInst initialize missing");
    lzc_notify_message("Home tile setup failed", "Use web UI");
    return -1;
  }

  int err = api.initialize();
  if(err) {
    lzc_log("launcher install sceAppInstUtilInitialize failed rc=0x%08x",
           (unsigned)err);
    lzc_notify_message("Home tile setup failed", "Use web UI");
    return -1;
  }

  uninstall_launcher_title(&api, LZC_LAUNCHER_TITLE_ID,
                           "LZ4 Compression tile");

  if(mkdir_if_needed(app_dir) != 0 || mkdir_if_needed(sce_sys_dir) != 0) {
    lzc_log("launcher install mkdir failed errno=%d", errno);
    lzc_notify_message("Home tile setup failed", "Use web UI");
    return -1;
  }

  if(write_file(param_path, lzc_launcher_param_json,
                lzc_launcher_param_json_size) != 0) {
    lzc_log("launcher install failed writing %s errno=%d", param_path, errno);
    lzc_notify_message("Home tile setup failed", "Use web UI");
    return -1;
  }

  if(write_file(icon_path, lzc_launcher_icon0_png,
                lzc_launcher_icon0_png_size) != 0) {
    lzc_log("launcher install failed writing %s errno=%d", icon_path, errno);
    lzc_notify_message("Home tile setup failed", "Use web UI");
    return -1;
  }

  /* Home-screen background art (same picture for both slots). The tile
   * still works without it. */
  if(write_file(pic0_path, lzc_launcher_pic0_png,
                lzc_launcher_pic0_png_size) != 0 ||
     write_file(pic1_path, lzc_launcher_pic0_png,
                lzc_launcher_pic0_png_size) != 0) {
    lzc_log("launcher install warning failed writing background art errno=%d",
           errno);
  }

  err = install_app(&api, LZC_LAUNCHER_TITLE_ID, LZC_APP_PARENT);
  if(err) {
    lzc_log("launcher install install_app failed rc=0x%08x", (unsigned)err);
    lzc_notify_message("Home tile setup failed", "Use web UI");
    return -1;
  }

  if(ensure_data_dir() != 0) {
    lzc_log("launcher install warning failed creating %s errno=%d",
           LZC_DATA_DIR, errno);
  } else if(write_file(LZC_MARKER_PATH, g_install_marker,
                       sizeof(g_install_marker) - 1) != 0) {
    lzc_log("launcher install warning failed writing %s errno=%d",
           LZC_MARKER_PATH, errno);
  }

  return 1;
}

int
lzc_launcher_remove(void) {
  appinst_api_t api;
  char app_dir[256];
  char sce_sys_dir[256];
  char param_path[256];
  char icon_path[256];
  char pic0_path[256];
  char pic1_path[256];
  int rc = 0;

  pthread_mutex_lock(&g_launcher_install_lock);

  init_ps5_services();
  resolve_appinst(&api);

  if(!api.initialize) {
    lzc_log("launcher remove AppInst initialize missing");
    rc = -1;
    goto out;
  }

  int err = api.initialize();
  if(err) {
    lzc_log("launcher remove sceAppInstUtilInitialize failed rc=0x%08x",
           (unsigned)err);
    rc = -1;
    goto out;
  }

  err = uninstall_launcher_title(&api, LZC_LAUNCHER_TITLE_ID,
                                 "LZ4 Compression tile");
  if(err && err != -ENOSYS) {
    rc = err;
  }

  snprintf(app_dir, sizeof(app_dir), LZC_APP_ROOT "/%s",
           LZC_LAUNCHER_TITLE_ID);
  snprintf(sce_sys_dir, sizeof(sce_sys_dir), "%s/sce_sys", app_dir);
  snprintf(param_path, sizeof(param_path), "%s/param.json", sce_sys_dir);
  snprintf(icon_path, sizeof(icon_path), "%s/icon0.png", sce_sys_dir);
  snprintf(pic0_path, sizeof(pic0_path), "%s/pic0.png", sce_sys_dir);
  snprintf(pic1_path, sizeof(pic1_path), "%s/pic1.png", sce_sys_dir);

  unlink_if_exists(LZC_MARKER_PATH);
  unlink_if_exists(param_path);
  unlink_if_exists(icon_path);
  unlink_if_exists(pic0_path);
  unlink_if_exists(pic1_path);
  rmdir_if_exists(sce_sys_dir);
  rmdir_if_exists(app_dir);

  lzc_log("launcher remove complete rc=0x%08x", (unsigned)rc);

out:
  pthread_mutex_unlock(&g_launcher_install_lock);
  return rc;
}

static void *
launcher_thread(void *arg) {
  (void)arg;
  struct stat st;
  char param_path[256];

  /* The LZ4 Compression app (PPSA99420, a folder in /data/homebrew that
   * ShadowMountPlus registers) is the home-screen tile now. Remove the old
   * browser launcher tile if an earlier build installed it. */
  snprintf(param_path, sizeof(param_path), LZC_APP_ROOT "/%s/sce_sys/param.json",
           LZC_LAUNCHER_TITLE_ID);
  if(stat(param_path, &st) == 0) {
    int rc = lzc_launcher_remove();
    lzc_log("legacy web launcher tile removed rc=0x%08x", (unsigned)rc);
  } else {
    lzc_log("launcher: no legacy web tile");
  }
  return NULL;
}

int
lzc_launcher_start(void) {
  pthread_mutex_lock(&g_launcher_start_lock);
  if(g_launcher_started) {
    pthread_mutex_unlock(&g_launcher_start_lock);
    return 0;
  }
  g_launcher_started = 1;
  pthread_mutex_unlock(&g_launcher_start_lock);

  pthread_t thread;
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  int rc = pthread_create(&thread, &attr, launcher_thread, NULL);
  pthread_attr_destroy(&attr);
  if(rc != 0) {
    lzc_log("launcher skipped: pthread_create rc=%d", rc);
    lzc_notify_message("Home tile skipped", "Use web UI");
    return -1;
  }
  return 0;
}

/* ------------------------------------------------------------- relaunch */

typedef struct {
  uint32_t structsize, user_id, app_opt;
  uint64_t crash_report;
  uint32_t check_flag;
} lzc_launch_ctx_t;

typedef int (*user_service_get_foreground_fn)(int *);
int sceLncUtilGetAppId(const char *title_id);
int sceSystemServiceGetAppIdOfRunningBigApp(void);
int sceSystemServiceLaunchApp(const char *title_id, char **argv,
                              lzc_launch_ctx_t *ctx);

static char g_relaunch_title[16];
static pthread_mutex_t g_relaunch_lock = PTHREAD_MUTEX_INITIALIZER;
static int g_relaunch_busy = 0;

static void *
relaunch_thread(void *arg) {
  (void)arg;
  char title[16];
  pthread_mutex_lock(&g_relaunch_lock);
  snprintf(title, sizeof(title), "%s", g_relaunch_title);
  pthread_mutex_unlock(&g_relaunch_lock);

  int waited = 0;
  while(sceLncUtilGetAppId(title) >= 0 && waited < 30000) {
    usleep(100 * 1000);
    waited += 100;
  }
  if(sceLncUtilGetAppId(title) >= 0) {
    lzc_log("relaunch %s: still running after 30 s, giving up", title);
  } else if(sceSystemServiceGetAppIdOfRunningBigApp() > 0) {
    lzc_log("relaunch %s: another app is running, not launching", title);
  } else {
    usleep(500 * 1000);
    user_service_initialize_fn init = NULL;
    user_service_get_foreground_fn foreground = NULL;
    int prio = 256;
    (void)resolve_module_symbol(LZC_USER_SERVICE_MODULE, LZC_USER_SERVICE_PATH,
                                "sceUserServiceInitialize", (void **)&init);
    (void)resolve_module_symbol(LZC_USER_SERVICE_MODULE, LZC_USER_SERVICE_PATH,
                                "sceUserServiceGetForegroundUser",
                                (void **)&foreground);
    if(init) (void)init(&prio);
    lzc_launch_ctx_t ctx;
    int user = 0;
    memset(&ctx, 0, sizeof(ctx));
    ctx.structsize = sizeof(ctx);
    int user_rc = foreground ? foreground(&user) : -1;
    if(user_rc != 0) {
      lzc_log("relaunch %s: no foreground user rc=0x%08x", title,
             (unsigned)user_rc);
    } else {
      ctx.user_id = (uint32_t)user;
      int rc = sceSystemServiceLaunchApp(title, NULL, &ctx);
      lzc_log("relaunch %s rc=0x%08x", title, (unsigned)rc);
    }
  }
  pthread_mutex_lock(&g_relaunch_lock);
  g_relaunch_busy = 0;
  pthread_mutex_unlock(&g_relaunch_lock);
  return NULL;
}

int
lzc_relaunch_after_close(const char *title_id) {
  pthread_t thread;
  if(!title_id || strlen(title_id) != 9) return -1;
  pthread_mutex_lock(&g_relaunch_lock);
  if(g_relaunch_busy) {
    pthread_mutex_unlock(&g_relaunch_lock);
    return -1;
  }
  snprintf(g_relaunch_title, sizeof(g_relaunch_title), "%s", title_id);
  g_relaunch_busy = 1;
  pthread_mutex_unlock(&g_relaunch_lock);
  if(pthread_create(&thread, NULL, relaunch_thread, NULL) != 0) {
    pthread_mutex_lock(&g_relaunch_lock);
    g_relaunch_busy = 0;
    pthread_mutex_unlock(&g_relaunch_lock);
    return -1;
  }
  pthread_detach(thread);
  return 0;
}
