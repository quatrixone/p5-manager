/* Copyright (C) 2026 P5 Manager
 *
 * Headless fake-PKG installer payload for PS5. Reads the staged .pkg path
 * from a trigger file the host wrote via FTP, calls
 * sceAppInstUtilInstallByPackage(), and polls
 * sceAppInstUtilGetInstallStatus() until the package becomes playable or
 * the installer errors out.
 *
 * Stdout format — the manager parses these lines via regex on the
 * payload's elfldr socket, so don't break the prefixes:
 *
 *   [pkg-install] trigger: /data/.p5manager-install
 *   [pkg-install] pkg:     /data/pkg-stage/foo.pkg
 *   [pkg-install] name:    foo.pkg
 *   [pkg-install] init ok
 *   status: installing
 *   progress: 12.34%
 *   status: playable
 *   [pkg-install] done
 *
 * On any fatal step it prints `status: error` followed by a
 * `[pkg-install] error: <message>` line and exits 1.
 *
 * Adapted from etaHEN's PS5 PKG installation writeup
 * (https://github.com/etaHEN/etaHEN/blob/2.0b/PS5%20technical%20writeups/pkg-writeup.md)
 * plus the public ps5-payload-dev SDK samples. We do NOT link
 * libSceAppInstUtil at compile time — instead the payload runs
 * sceKernelLoadStartModule() and resolves the entry points by name, so the
 * binary stays portable across firmware revisions where stub linkage drifts.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>
#include <stdbool.h>
#include <sys/stat.h>

/* Default trigger path the manager writes to via FTP. Override at
 * compile time with -DTRIGGER_PATH=\"...\" if you reconfigure
 * `pkg_trigger_file` in P5 Manager's settings. */
#ifndef TRIGGER_PATH
#define TRIGGER_PATH "/data/.p5manager-install"
#endif

/* libkernel.sprx is already linked by the SDK runtime. */
extern int sceKernelLoadStartModule(const char *path, size_t argc,
                                    const void *argv, unsigned int flags,
                                    void *unk1, int *result);
extern void *sceKernelDlsym(int handle, const char *name);

/* The three structs `sceAppInstUtilInstallByPackage` expects. Layout is
 * Sony-internal; sizes here come from etaHEN's writeup of the ShellUI
 * managed wrapper. */
#define PLAYGO_SCENARIO_ID_SIZE 3
#define CONTENT_ID_SIZE          0x30
#define LANGUAGE_SIZE            8
#define NUM_LANGUAGES            30
#define NUM_IDS                  64

typedef char playgo_scenario_id_t[PLAYGO_SCENARIO_ID_SIZE];
typedef char language_t[LANGUAGE_SIZE];
typedef char content_id_t[CONTENT_ID_SIZE];

typedef struct {
    content_id_t content_id;
    int          content_type;
    int          content_platform;
} SceAppInstallPkgInfo;

typedef struct {
    const char *uri;
    const char *ex_uri;
    const char *playgo_scenario_id;
    const char *content_id;
    const char *content_name;
    const char *icon_url;
} MetaInfo;

typedef struct {
    language_t           languages[NUM_LANGUAGES];
    playgo_scenario_id_t playgo_scenario_ids[NUM_IDS];
    content_id_t         content_ids[NUM_IDS];
    unsigned char        unknown[6480];
} PlayGoInfo;

typedef struct {
    int32_t error_code;
    int32_t version;
    char    description[512];
    char    type[9];
} SceAppInstallErrorInfo;

typedef struct {
    char                   status[16];
    char                   src_type[8];
    uint32_t               remain_time;
    uint64_t               downloaded_size;
    uint64_t               initial_chunk_size;
    uint64_t               total_size;
    uint32_t               promote_progress;
    SceAppInstallErrorInfo error_info;
    int32_t                local_copy_percent;
    bool                   is_copy_only;
} SceAppInstallStatusInstalled;

/* libSceAppInstUtil exports we need. */
typedef int (*sceAppInstUtilInitialize_t)(void);
typedef int (*sceAppInstUtilInstallByPackage_t)(MetaInfo *meta,
                                                SceAppInstallPkgInfo *pkg_info,
                                                PlayGoInfo *playgo);
typedef int (*sceAppInstUtilGetInstallStatus_t)(const char *content_id,
                                                SceAppInstallStatusInstalled *status);

static void die(const char *msg) {
    printf("status: error\n");
    printf("[pkg-install] error: %s\n", msg);
    fflush(stdout);
    exit(1);
}

/* Read up to `max-1` bytes of `path` into `out` and return the number of
 * bytes read, or -1 on error. Always null-terminates. */
static ssize_t slurp(const char *path, char *out, size_t max) {
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    size_t n = fread(out, 1, max - 1, f);
    out[n] = '\0';
    fclose(f);
    return (ssize_t)n;
}

/* Parse the trigger file. We accept two formats so the manager can switch
 * without breaking older payloads:
 *
 *   1. PLAIN (preferred): first line = absolute pkg path, optional
 *      subsequent line = content_name override. Lines starting with `#`
 *      are ignored.
 *   2. JSON: `{ "pkg_path": "...", "content_name": "..." }` — we do a
 *      cheap string-search for the keys (no real parser).
 */
static void parse_trigger(const char *buf, char *pkg_path, size_t pkg_path_sz,
                          char *name, size_t name_sz) {
    pkg_path[0] = '\0';
    name[0]     = '\0';

    /* JSON path first — if we see "pkg_path" we use the JSON pattern. */
    const char *j = strstr(buf, "\"pkg_path\"");
    if (j) {
        const char *q1 = strchr(j + 10, '"');
        if (q1) {
            q1 = strchr(q1 + 1, '"');
            if (q1) {
                const char *q2 = strchr(q1 + 1, '"');
                if (q2 && (size_t)(q2 - q1 - 1) < pkg_path_sz) {
                    memcpy(pkg_path, q1 + 1, q2 - q1 - 1);
                    pkg_path[q2 - q1 - 1] = '\0';
                }
            }
        }
        const char *n = strstr(buf, "\"content_name\"");
        if (n) {
            const char *qa = strchr(n + 14, '"');
            if (qa) {
                qa = strchr(qa + 1, '"');
                if (qa) {
                    const char *qb = strchr(qa + 1, '"');
                    if (qb && (size_t)(qb - qa - 1) < name_sz) {
                        memcpy(name, qa + 1, qb - qa - 1);
                        name[qb - qa - 1] = '\0';
                    }
                }
            }
        }
        return;
    }

    /* PLAIN: first non-empty, non-# line = path; next = name. */
    const char *p = buf;
    int line = 0;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t len = eol ? (size_t)(eol - p) : strlen(p);
        if (len && p[0] != '#') {
            if (line == 0 && len < pkg_path_sz) {
                memcpy(pkg_path, p, len);
                pkg_path[len] = '\0';
            } else if (line == 1 && len < name_sz) {
                memcpy(name, p, len);
                name[len] = '\0';
            }
            line++;
            if (line >= 2) break;
        }
        if (!eol) break;
        p = eol + 1;
    }
    /* Trim a trailing \r if the host wrote CRLF. */
    size_t n = strlen(pkg_path);
    if (n && pkg_path[n - 1] == '\r') pkg_path[n - 1] = '\0';
    n = strlen(name);
    if (n && name[n - 1] == '\r') name[n - 1] = '\0';
}

int main(int argc, char *argv[]) {
    (void)argc; (void)argv;

    /* Line-buffer stdout so each progress line shows up on the elfldr
     * socket as soon as we print it (the host parses status lines in
     * real time). */
    setvbuf(stdout, NULL, _IOLBF, 0);

    printf("[pkg-install] starting (build %s %s)\n", __DATE__, __TIME__);
    printf("[pkg-install] trigger: %s\n", TRIGGER_PATH);

    /* Read trigger file. */
    char raw[2048];
    ssize_t n = slurp(TRIGGER_PATH, raw, sizeof(raw));
    if (n < 0) die("trigger file not found - did the host write it?");
    if (n == 0) die("trigger file is empty");

    char pkg_path[1024], pkg_name[256];
    parse_trigger(raw, pkg_path, sizeof(pkg_path), pkg_name, sizeof(pkg_name));
    if (!pkg_path[0]) die("trigger file has no pkg path on the first line");

    /* Validate the staged .pkg exists. */
    struct stat st;
    if (stat(pkg_path, &st) != 0) {
        printf("[pkg-install] stat(%s) failed\n", pkg_path);
        die("staged .pkg not found on PS5 filesystem");
    }
    if (!pkg_name[0]) {
        const char *bn = strrchr(pkg_path, '/');
        snprintf(pkg_name, sizeof(pkg_name), "%s", bn ? bn + 1 : pkg_path);
    }
    printf("[pkg-install] pkg:     %s\n", pkg_path);
    printf("[pkg-install] name:    %s\n", pkg_name);
    printf("[pkg-install] size:    %lld bytes\n", (long long)st.st_size);

    /* Load libSceAppInstUtil.sprx + resolve our three entry points. */
    int mod_h = sceKernelLoadStartModule(
        "/system/common/lib/libSceAppInstUtil.sprx", 0, NULL, 0, NULL, NULL);
    if (mod_h < 0) {
        printf("[pkg-install] sceKernelLoadStartModule: 0x%x\n", mod_h);
        die("failed to load libSceAppInstUtil.sprx");
    }

    sceAppInstUtilInitialize_t       p_init = (sceAppInstUtilInitialize_t)
        sceKernelDlsym(mod_h, "sceAppInstUtilInitialize");
    sceAppInstUtilInstallByPackage_t p_install = (sceAppInstUtilInstallByPackage_t)
        sceKernelDlsym(mod_h, "sceAppInstUtilInstallByPackage");
    sceAppInstUtilGetInstallStatus_t p_status  = (sceAppInstUtilGetInstallStatus_t)
        sceKernelDlsym(mod_h, "sceAppInstUtilGetInstallStatus");
    if (!p_init || !p_install || !p_status) {
        die("could not resolve sceAppInstUtil* symbols (firmware mismatch?)");
    }

    int err = p_init();
    if (err) {
        printf("[pkg-install] sceAppInstUtilInitialize: 0x%x\n", err);
        die("sceAppInstUtilInitialize failed");
    }
    printf("[pkg-install] init ok\n");

    /* Build the three input structs. We zero everything and fill in
     * empty strings for the language/scenario arrays because Sony
     * memcpy's them into stack buffers — leaving them undefined causes
     * the call to return SCE_APP_INSTALLER_ERROR_PARAM. */
    PlayGoInfo            playgo;
    SceAppInstallPkgInfo  pkg_info;
    memset(&playgo,   0, sizeof(playgo));
    memset(&pkg_info, 0, sizeof(pkg_info));
    for (size_t i = 0; i < NUM_LANGUAGES; i++) playgo.languages[i][0] = '\0';
    for (size_t i = 0; i < NUM_IDS; i++) {
        playgo.playgo_scenario_ids[i][0] = '\0';
        playgo.content_ids[i][0]         = '\0';
    }

    MetaInfo meta = {
        .uri               = pkg_path,
        .ex_uri            = "",
        .playgo_scenario_id= "",
        .content_id        = "",
        .content_name      = pkg_name,
        .icon_url          = "",
    };

    err = p_install(&meta, &pkg_info, &playgo);
    if (err) {
        printf("[pkg-install] sceAppInstUtilInstallByPackage: 0x%x\n", err);
        die("sceAppInstUtilInstallByPackage rejected the request (auth ID? PSN-signed pkg? game in use?)");
    }
    printf("[pkg-install] queued. content_id=%s\n", pkg_info.content_id);

    /* Poll status. The install proceeds asynchronously in the DPI daemon;
     * we follow it for up to ~30 minutes (caller-side timeout matches). */
    SceAppInstallStatusInstalled st_inst;
    int last_pct = -1;
    const char *last_status = "";
    for (int i = 0; i < 1800; i++) { /* 1800 * 1s = 30 min */
        memset(&st_inst, 0, sizeof(st_inst));
        int rc = p_status(pkg_info.content_id, &st_inst);
        if (rc) {
            printf("[pkg-install] GetInstallStatus: 0x%x\n", rc);
            die("status poll failed");
        }

        const char *s = st_inst.status[0] ? st_inst.status : "preparing";
        if (strcmp(s, last_status) != 0) {
            printf("status: %s\n", s);
            last_status = s;
        }
        if (st_inst.total_size > 0) {
            int pct = (int)((double)st_inst.downloaded_size * 100.0 / (double)st_inst.total_size);
            if (pct != last_pct) {
                printf("progress: %d%%\n", pct);
                last_pct = pct;
            }
        }
        if (strcmp(s, "playable") == 0) {
            printf("[pkg-install] done\n");
            return 0;
        }
        if (strcmp(s, "error") == 0 || strcmp(s, "none") == 0) {
            printf("[pkg-install] install error_code: 0x%x\n", st_inst.error_info.error_code);
            return 1;
        }
        sleep(1);
    }

    printf("status: error\n");
    printf("[pkg-install] timed out after 30 minutes — install still running on PS5\n");
    return 1;
}
