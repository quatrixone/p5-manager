#pragma once
#include "ps4.h"

/* Registry keys verified against Apollo's PS4 activation implementation. */
#define PS4_USER_ID_BASE 0x07800100u
#define PS4_USER_NAME_BASE 0x07800200u
#define PS4_ACCOUNT_ID_BASE 0x07800500u
#define PS4_ACCOUNT_FLAGS_BASE 0x07800800u
#define PS4_ACCOUNT_TYPE_BASE 0x0780b007u
#define PS4_RP_ENABLE_KEY 0x41810000u
#define PS4_TRIGGER_PATH "/data/.p5manager-offact"

extern int (*rp_get_int)(uint32_t, int *);
extern int (*rp_get_bin)(uint32_t, void *, size_t);
extern int (*rp_get_str)(uint32_t, char *, size_t);
extern int (*rp_set_int)(uint32_t, int);
extern int (*rp_set_bin)(uint32_t, const void *, size_t);
extern int (*rp_set_str)(uint32_t, const char *, size_t);

typedef struct {
  int user_id;
  int slot;
  uint64_t account_id;
  char name[64];
} rp_user;

int rp_init(const char *log_path);
void rp_log(const char *format, ...);
void rp_close(void);
uintptr_t rp_symbol(const char *module, const char *name);
uint32_t rp_key(int slot, uint32_t base);
int rp_foreground_user(rp_user *user);
void rp_print_account(const rp_user *user);
int rp_read_trigger(uint64_t *account_id);
int rp_find_process(const char *name);
