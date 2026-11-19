#ifndef LZC_NOTIFY_H
#define LZC_NOTIFY_H

void lzc_notify_operation_done(const char *action, const char *game,
                              const char *status, const char *detail);
void lzc_notify_message(const char *title, const char *detail);

#endif
