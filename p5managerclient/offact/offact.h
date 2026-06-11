/* offact.h - registry helpers vendored from ps5-payload-dev/offact
 *
 * Original Copyright (C) 2024 John Törnblom (GPLv3+).
 *
 * Local adaptation: pure registry helpers, no SDL/IME deps. Used by our
 * headless main.c which activates the foreground user instead of the
 * upstream's interactive listui.
 */

#pragma once

#include <stddef.h>
#include <stdint.h>

#define ACCOUNT_NUMB_MAX 16
#define ACCOUNT_TYPE_MAX 17
#define ACCOUNT_NAME_MAX 32

int OffAct_GetAccountName(int account_numb, char val[ACCOUNT_NAME_MAX]);

int OffAct_GetAccountId(int account_numb, uint64_t *val);
int OffAct_SetAccountId(int account_numb, uint64_t val);
uint64_t OffAct_GenAccountId(const char *name);

int OffAct_GetAccountType(int account_numb, char val[ACCOUNT_TYPE_MAX]);
int OffAct_SetAccountType(int account_numb, char val[ACCOUNT_TYPE_MAX]);

int OffAct_GetAccountFlags(int account_numb, int *val);
int OffAct_SetAccountFlags(int account_numb, int val);
