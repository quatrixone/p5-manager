/* offact - headless variant (PSN-aware)
 *
 * Unlike upstream ps5-payload-dev/offact (which is a fullscreen SDL
 * homebrew that lets the user pick a slot + type an account ID via
 * IME), this build is meant to be sent straight to elfldr (port 9021)
 * by the P5 Manager backend.
 *
 * Behaviour:
 *
 *   1. Resolves the foreground PS5 user via sceUserServiceGetForegroundUser
 *   2. Maps that user_id to its registry slot 1..16
 *   3. Reads the user's display name (online_id, falls back to user_name)
 *   4. Reads the REAL PSN account_id from the registry slot
 *
 *      The host-supplied PSN account_id (from the manager's PSN OAuth
 *      flow) lives in the trigger file at TRIGGER_PATH (default
 *      /data/.p5manager-offact). When present it is the **source of
 *      truth** and we sync the registry slot to match it:
 *
 *      a. registry account_id == 0    -> adopt trigger id
 *      b. registry account_id == trigger id  -> in sync, just ensure
 *                                              type "np" + flags 0x1002
 *      c. registry account_id != trigger id  -> overwrite registry id
 *                                              with the linked PSN id
 *                                              (the manager intentionally
 *                                              re-linked the profile, we
 *                                              follow it - no --force
 *                                              required)
 *
 *      If no trigger file is present, we fall back to the on-console
 *      registry id (existing PSN sign-in) and only fix the flags.
 *      If neither the trigger nor the registry has a non-zero
 *      account_id, we refuse to activate ("sign in to PSN first or
 *      run PSN OAuth in P5 Manager"). We never invent an id.
 *
 *   5. Output (parsed by backend/src/routes/remoteplay.js):
 *
 *        User: <name>
 *        Account ID: <base64 of the 8 raw bytes>
 *        Account ID (hex): 0x<16 hex>
 *        Slot: <1..16>
 *        Activated: yes|already|failed
 *
 *   `Activated: already` = registry was already in sync with the linked
 *                          PSN id and the flags were correct.
 *   `Activated: yes`     = we wrote (adopted the trigger id, replaced a
 *                          mismatched id, or re-applied missing flags).
 *
 *   `--force` (or OFFACT_FORCE=1) re-writes type + flags even when
 *   they're already correct, useful for diagnostics.
 *
 * Trigger file format (text, written by the host via FTP):
 *
 *   <base64 of 8 raw account_id bytes>\n
 *   <online_id (optional, ignored if first line is malformed)>\n
 *
 *   Lines starting with '#' are ignored. Whitespace is trimmed.
 */

#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <errno.h>

#include "offact.h"
#include "utils.h"

#define USER_ID_KEY_BASE         125829376U  /* 0x07800000 */
#define USER_ID_KEY_FALLBACK     127140096U  /* 0x07950000 */
#define ONLINE_ID_KEY_BASE       125874188U  /* 0x0780B00C */
#define ONLINE_ID_KEY_FALLBACK   127184908U  /* 0x0796000C */

#define ACCOUNT_FLAGS_ACTIVATED  0x1002      /* 4098 */

/* Default trigger path the manager writes to via FTP. Override at
 * compile time with -DTRIGGER_PATH=\"...\" if you reconfigure the
 * matching `offact_trigger_file` key in P5 Manager's settings. */
#ifndef TRIGGER_PATH
#define TRIGGER_PATH "/data/.p5manager-offact"
#endif

int sceUserServiceInitialize(void *);
int sceUserServiceGetForegroundUser(int *);
int sceRegMgrGetInt(int, int *);
int sceRegMgrGetStr(int, char *, size_t);

static int regmgr_key(int slot, uint32_t primary, uint32_t fallback)
{
    if (slot < 1 || slot > 16) {
        return (int)fallback;
    }
    return (int)((uint32_t)(slot - 1) * 65536U + primary);
}

/* Map foreground user_id -> registry slot (1..16). The PS5 stores each
 * user's user_id in the per-slot USER_ID key; we just iterate. Returns
 * -1 if the foreground user isn't present in the registry (shouldn't
 * happen on a healthy system - they have to be there to be logged in). */
static int find_user_registry_slot(int user_id)
{
    for (int i = 1; i <= 16; i++) {
        int32_t v = 0;
        int rc = sceRegMgrGetInt(regmgr_key(i, USER_ID_KEY_BASE, USER_ID_KEY_FALLBACK), &v);
        if (rc == 0 && v == user_id) {
            return i;
        }
    }
    return -1;
}

/* Read trigger file into `out` (NUL-terminated). Returns bytes read or
 * -1 if the file doesn't exist / can't be opened. */
static int slurp_trigger(const char *path, char *out, size_t max)
{
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    size_t n = fread(out, 1, max - 1, f);
    out[n] = '\0';
    fclose(f);
    return (int)n;
}

/* Trim trailing \r / whitespace in place. */
static void rtrim(char *s)
{
    size_t n = strlen(s);
    while (n > 0 && (s[n - 1] == '\r' || s[n - 1] == '\n' ||
                     s[n - 1] == ' '  || s[n - 1] == '\t')) {
        s[--n] = '\0';
    }
}

/* Parse the host-written trigger blob. Sets *account_id (host endian)
 * and copies online_id (if present, max name_max-1 chars). Returns 1
 * when a usable account_id was parsed, 0 otherwise. */
static int parse_trigger(const char *buf, uint64_t *account_id,
                         char *online_id, size_t name_max)
{
    *account_id = 0;
    if (online_id && name_max > 0) online_id[0] = '\0';

    char b64[64] = {0};
    char name[64] = {0};

    const char *p = buf;
    int line = 0;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t len = eol ? (size_t)(eol - p) : strlen(p);
        /* Skip blank + comment lines. */
        if (len > 0 && p[0] != '#') {
            if (line == 0 && len < sizeof(b64)) {
                memcpy(b64, p, len);
                b64[len] = '\0';
                rtrim(b64);
            } else if (line == 1 && len < sizeof(name)) {
                memcpy(name, p, len);
                name[len] = '\0';
                rtrim(name);
            }
            line++;
            if (line >= 2) break;
        }
        if (!eol) break;
        p = eol + 1;
    }

    if (!b64[0]) return 0;

    unsigned char raw[16];
    int n = base64_decode(b64, raw, sizeof(raw));
    if (n != 8) return 0;

    /* The host writes the 8 raw bytes in the same little-endian byte
     * order that rp-get-pin.elf prints them, so we copy straight back
     * to a uint64_t. */
    memcpy(account_id, raw, 8);

    if (online_id && name[0] && name_max > 1) {
        size_t cn = strlen(name);
        if (cn >= name_max) cn = name_max - 1;
        memcpy(online_id, name, cn);
        online_id[cn] = '\0';
    }
    return 1;
}

int main(int argc, char *argv[])
{
    /* elfldr connects stdout to the inbound TCP socket as a regular file
     * descriptor -> FreeBSD libc defaults to full buffering. Force
     * unbuffered so every printf reaches the host backend immediately. */
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    printf("[offact] starting, pid=%d\n", getpid());
    printf("[offact] trigger path: %s\n", TRIGGER_PATH);

    int force = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--force") == 0 || strcmp(argv[i], "force") == 0) {
            force = 1;
        }
    }
    if (getenv("OFFACT_FORCE") && getenv("OFFACT_FORCE")[0] == '1') {
        force = 1;
    }

    if (sceUserServiceInitialize(0) < 0) {
        /* Non-fatal - the regmgr calls work without UserService too, but
         * GetForegroundUser obviously won't. Continue and let that fail
         * with a clearer error. */
        printf("[offact] sceUserServiceInitialize failed (continuing)\n");
    }

    int user_id = 0;
    int rc = sceUserServiceGetForegroundUser(&user_id);
    if (rc != 0 || user_id == 0) {
        printf("[offact] sceUserServiceGetForegroundUser failed: 0x%x\n", (uint32_t)rc);
        notifyf("OffAct: no foreground user (sign in first)");
        printf("Activated: failed\n");
        return 1;
    }
    printf("[offact] foreground user_id=0x%x\n", (uint32_t)user_id);

    int slot = find_user_registry_slot(user_id);
    if (slot < 1) {
        printf("[offact] could not find user_id 0x%x in registry slots 1..16\n",
               (uint32_t)user_id);
        notifyf("OffAct: foreground user not in registry");
        printf("Activated: failed\n");
        return 1;
    }
    printf("[offact] foreground user is at registry slot %d\n", slot);

    /* Read display name. Prefer the PSN online_id (the handle users see
     * everywhere - "QuatrixOne") and fall back to the local user_name
     * (the local-only "name on this PS5") if the online slot is empty. */
    char online_id[ACCOUNT_TYPE_MAX] = {0};
    char user_name[ACCOUNT_NAME_MAX] = {0};
    sceRegMgrGetStr(regmgr_key(slot, ONLINE_ID_KEY_BASE, ONLINE_ID_KEY_FALLBACK),
                    online_id, sizeof(online_id) - 1);
    OffAct_GetAccountName(slot, user_name);

    /* The real PSN-derived account_id from the registry. */
    uint64_t reg_account_id = 0;
    OffAct_GetAccountId(slot, &reg_account_id);

    char current_type[ACCOUNT_TYPE_MAX] = {0};
    OffAct_GetAccountType(slot, current_type);

    int current_flags = 0;
    OffAct_GetAccountFlags(slot, &current_flags);

    printf("[offact] current: account_id=0x%016lx type=\"%s\" flags=0x%x online_id=\"%s\" user_name=\"%s\"\n",
           (unsigned long)reg_account_id, current_type, current_flags,
           online_id, user_name);

    /* Parse the host-supplied trigger file (if any). It carries the
     * PSN account_id that the manager linked via PSN OAuth - this is
     * the *source of truth* whenever it's available. We sync the
     * registry slot to it: adopt when empty, overwrite when different,
     * just ensure flags when already matching. */
    uint64_t trigger_account_id = 0;
    char trigger_online_id[ACCOUNT_NAME_MAX] = {0};
    int trigger_ok = 0;
    {
        char buf[512];
        int n = slurp_trigger(TRIGGER_PATH, buf, sizeof(buf));
        if (n >= 0) {
            trigger_ok = parse_trigger(buf, &trigger_account_id,
                                       trigger_online_id, sizeof(trigger_online_id));
            if (trigger_ok) {
                printf("[offact] trigger file present: account_id=0x%016lx online_id=\"%s\"\n",
                       (unsigned long)trigger_account_id, trigger_online_id);
            } else {
                printf("[offact] trigger file present but unparseable - ignoring\n");
            }
        } else {
            printf("[offact] no trigger file at %s (will fall back to on-console registry)\n",
                   TRIGGER_PATH);
        }
    }

    /* Decide the target account_id and how we arrived at it. The
     * trigger always wins when present; the registry is the fallback.
     *
     *   reason values (for logging / status messages):
     *     "adopt"     trigger present, registry empty - first link
     *     "overwrite" trigger != registry            - manager re-linked
     *     "sync"      trigger == registry            - in sync
     *     "registry"  no trigger, use existing reg id
     *     ""          no trigger AND empty registry  - hard fail below
     */
    uint64_t account_id;
    const char *reason;
    if (trigger_ok) {
        account_id = trigger_account_id;
        if (reg_account_id == 0)                        reason = "adopt";
        else if (reg_account_id == trigger_account_id)  reason = "sync";
        else                                            reason = "overwrite";
    } else {
        account_id = reg_account_id;
        reason = reg_account_id ? "registry" : "";
    }

    /* Use the trigger's online_id only if we don't already have one
     * on-console. The on-console value comes from PSN sign-in and
     * usually beats whatever we'd send from the host. */
    const char *display = online_id[0] ? online_id
                        : (trigger_online_id[0] ? trigger_online_id
                        : (user_name[0] ? user_name : "User"));

    if (account_id == 0) {
        /* No registry id, no trigger file. Refuse: we never invent. */
        printf("[offact] no PSN account linked AND no trigger file at %s; refusing to activate\n",
               TRIGGER_PATH);
        notifyf("OffAct: no PSN account linked\nSign in to PSN on this profile or run PSN OAuth in P5 Manager first");
        printf("User: %s\n", display);
        printf("Account ID: \n");
        printf("Account ID (hex): 0x0000000000000000\n");
        printf("Slot: %d\n", slot);
        printf("Activated: failed\n");
        return 1;
    }

    int type_ok = (current_type[0] == 'n' && current_type[1] == 'p');
    int flags_ok = (current_flags & ACCOUNT_FLAGS_ACTIVATED) == ACCOUNT_FLAGS_ACTIVATED;
    int id_changed = (account_id != reg_account_id);
    int already_activated = type_ok && flags_ok && !id_changed;

    const char *status_word;
    if (already_activated && !force) {
        status_word = "already";
        printf("[offact] registry already in sync (id matches linked PSN, type=\"np\", flags=0x1002) - leaving alone\n");
    } else {
        /* Write account_id only when it differs from what's already
         * there. Type + flags are cheap so we re-write them whenever
         * they're not the activated pair (or --force is set). */
        int wrc1 = id_changed ? OffAct_SetAccountId(slot, account_id) : 0;
        int wrc2 = (type_ok  && !force) ? 0 : OffAct_SetAccountType(slot, "np");
        int wrc3 = (flags_ok && !force) ? 0 : OffAct_SetAccountFlags(slot, ACCOUNT_FLAGS_ACTIVATED);

        printf("[offact] writing (reason=%s): SetAccountId=0x%x SetAccountType=0x%x SetAccountFlags=0x%x\n",
               reason, (uint32_t)wrc1, (uint32_t)wrc2, (uint32_t)wrc3);
        if (id_changed) {
            printf("[offact] account_id changed: 0x%016lx -> 0x%016lx\n",
                   (unsigned long)reg_account_id, (unsigned long)account_id);
        }

        if (wrc1 != 0 || wrc2 != 0 || wrc3 != 0) {
            notifyf("OffAct: write failed (rc=0x%x/0x%x/0x%x)",
                    (uint32_t)wrc1, (uint32_t)wrc2, (uint32_t)wrc3);
            printf("Activated: failed\n");
            return 1;
        }

        status_word = "yes";
    }

    /* Encode the 8 raw little-endian bytes as base64, matching what
     * rp-get-pin.elf prints. The host backend uses the same regex for
     * both payloads. */
    uint8_t bytes[8];
    memcpy(bytes, &account_id, 8);
    char *b64 = base64_encode(bytes, 8);

    printf("User: %s\n", display);
    printf("Account ID: %s\n", b64 ? b64 : "");
    printf("Account ID (hex): 0x%016lx\n", (unsigned long)account_id);
    printf("Slot: %d\n", slot);
    printf("Activated: %s\n", status_word);

    /* Human-readable summary for the on-screen notification. We pick
     * the phrasing from the resolved `reason` so the user gets a clear
     * signal whether we linked a new PSN account, re-linked to a
     * different one, or just confirmed the existing link. */
    const char *headline =
        (strcmp(reason, "adopt")     == 0) ? "linked PSN account" :
        (strcmp(reason, "overwrite") == 0) ? "re-linked PSN account" :
        (strcmp(reason, "sync")      == 0) ? "PSN link in sync" :
                                             "activated PSN";
    notifyf("OffAct: %s\nUser: %s\nID: 0x%016lx",
            headline, display, (unsigned long)account_id);

    if (b64) free(b64);
    return 0;
}
