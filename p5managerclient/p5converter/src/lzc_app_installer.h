#ifndef LZC_APP_INSTALLER_H
#define LZC_APP_INSTALLER_H

#define LZC_LAUNCHER_TITLE_ID "PSLZ40001"

int lzc_launcher_start(void);
int lzc_launcher_remove(void);

/* Opens title_id again once it has closed (up to 30 s), for the foreground
 * user, from a background thread. Lets the app reopen after an update
 * without an ELF loader on port 9021. 0 when the thread started. */
int lzc_relaunch_after_close(const char *title_id);

#endif
