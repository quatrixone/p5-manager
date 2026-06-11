/* offact.c - registry helpers vendored from ps5-payload-dev/offact
 *
 * Original Copyright (C) 2024 John Törnblom (GPLv3+).
 *
 * Unchanged from upstream apart from this header - the upstream module
 * is already a clean, dependency-free utility.
 *
 * Key bases (per-user stride = 0x10000, slot 1..16):
 *   user_name       0x07800100  string  ACCOUNT_NAME_MAX
 *   account_id      0x07800400  bin     8 bytes
 *   account_flags   0x07800700  int     (4098 / 0x1002 = activated)
 *   account_type    0x0780AF07  string  "np" / "lo"
 */

#include "offact.h"

int sceRegMgrGetInt(int, int *);
int sceRegMgrGetStr(int, char *, size_t);
int sceRegMgrGetBin(int, void *, size_t);

int sceRegMgrSetInt(int, int);
int sceRegMgrSetBin(int, const void *, size_t);
int sceRegMgrSetStr(int, const char *, size_t);

static int OffAct_GetEntityNumber(int a, int b, int c, int d, int e)
{
    if (a < 1 || a > b) {
        return e;
    }
    return (a - 1) * c + d;
}

uint64_t OffAct_GenAccountId(const char *name)
{
    /* Note: NOT standard FNV-1a (the initial offset is 0, not the FNV
     * offset basis). Kept exactly as upstream so the derived account_id
     * is reproducible by anyone running upstream offact too. */
    uint64_t base = 0x5EAF00D / 0xCA7F00D;
    if (*name) {
        do {
            base = 0x100000001B3 * (base ^ (uint8_t)*name++);
        } while (*name);
    }
    return base;
}

int OffAct_GetAccountName(int account_numb, char val[ACCOUNT_NAME_MAX])
{
    int n = OffAct_GetEntityNumber(account_numb, 16, 65536, 125829632, 127140352);
    *val = 0;
    return sceRegMgrGetStr(n, val, ACCOUNT_NAME_MAX);
}

int OffAct_GetAccountId(int account_numb, uint64_t *val)
{
    int n = OffAct_GetEntityNumber(account_numb, 16, 65536, 125830400, 127141120);
    *val = 0;
    return sceRegMgrGetBin(n, val, sizeof(uint64_t));
}

int OffAct_SetAccountId(int account_numb, uint64_t val)
{
    int n = OffAct_GetEntityNumber(account_numb, 16, 65536, 125830400, 127141120);
    return sceRegMgrSetBin(n, &val, sizeof(uint64_t));
}

int OffAct_GetAccountType(int account_numb, char val[ACCOUNT_TYPE_MAX])
{
    int n = OffAct_GetEntityNumber(account_numb, 16, 65536, 125874183, 127184903);
    *val = 0;
    return sceRegMgrGetStr(n, val, ACCOUNT_TYPE_MAX);
}

int OffAct_SetAccountType(int account_numb, char val[ACCOUNT_TYPE_MAX])
{
    int n = OffAct_GetEntityNumber(account_numb, 16, 65536, 125874183, 127184903);
    return sceRegMgrSetStr(n, val, ACCOUNT_TYPE_MAX);
}

int OffAct_GetAccountFlags(int account_numb, int *val)
{
    int n = OffAct_GetEntityNumber(account_numb, 16, 65536, 125831168, 127141888);
    *val = 0;
    return sceRegMgrGetInt(n, val);
}

int OffAct_SetAccountFlags(int account_numb, int val)
{
    int n = OffAct_GetEntityNumber(account_numb, 16, 65536, 125831168, 127141888);
    return sceRegMgrSetInt(n, val);
}
