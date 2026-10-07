#include "common.h"

int _main(void) {
  if (rp_init("/data/.p5manager-offact-ps4.log")) return 0;
  rp_user user;
  if (rp_foreground_user(&user)) goto failed;
  uint64_t supplied = 0;
  int trigger = rp_read_trigger(&supplied);
  if (trigger < 0) { rp_log("Error: invalid account ID trigger; registry unchanged\n"); goto failed; }
  /* A linked Sony account is only a fallback for an empty console slot.
   * Never replace an account already assigned to the foreground user. */
  if (trigger > 0 && !user.account_id) {
    user.account_id = supplied;
  } else if (trigger > 0 && supplied != user.account_id) {
    rp_log("[offact-ps4] existing console account found; ignoring linked Sony account\n");
  }
  if (!user.account_id) { rp_log("Error: no existing or supplied account ID\n"); goto failed; }

  rp_set_int = (void *)rp_symbol("libSceRegMgr.sprx", "sceRegMgrSetInt");
  rp_set_bin = (void *)rp_symbol("libSceRegMgr.sprx", "sceRegMgrSetBin");
  rp_set_str = (void *)rp_symbol("libSceRegMgr.sprx", "sceRegMgrSetStr");
  if (!rp_set_int || !rp_set_bin || !rp_set_str) { rp_log("Error: registry writers unavailable\n"); goto failed; }
  char type[17] = {0};
  int flags = 0;
  if (rp_get_str(rp_key(user.slot, PS4_ACCOUNT_TYPE_BASE), type, sizeof(type)) ||
      rp_get_int(rp_key(user.slot, PS4_ACCOUNT_FLAGS_BASE), &flags)) {
    rp_log("Error: could not read PS4 activation state\n"); goto failed;
  }
  /* PS4 activation uses login_flag=6; PS5's 0x1002 is not applicable. */
  uint64_t previous_id=0;
  if (rp_get_bin(rp_key(user.slot, PS4_ACCOUNT_ID_BASE), &previous_id, 8)) goto failed;
  int already = previous_id == user.account_id && !strcmp(type, "np") && flags == 6;
  if (!already) {
    int a = rp_set_bin(rp_key(user.slot, PS4_ACCOUNT_ID_BASE), &user.account_id, 8);
    int b = rp_set_str(rp_key(user.slot, PS4_ACCOUNT_TYPE_BASE), "np", 3);
    int c = rp_set_int(rp_key(user.slot, PS4_ACCOUNT_FLAGS_BASE), 6);
    rp_log("[offact-ps4] SetAccountId=0x%x SetAccountType=0x%x SetLoginFlag=0x%x\n", a,b,c);
    if (a || b || c) goto failed;
  }
  rp_print_account(&user);
  rp_log("Activated: %s\nDone\n", already ? "already" : "yes");
  printf_notification("P5 Manager: PS4 account ready (%s)", user.name);
  rp_close(); return 0;
failed:
  rp_log("Activated: failed\nDone\n"); rp_close(); return 0;
}
