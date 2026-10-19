#ifndef LZC_DIAG_H
#define LZC_DIAG_H

void lzc_diag_init(void);
void lzc_diag_install_signal_handlers(void);
void lzc_checkpoint(const char *checkpoint);
void lzc_log(const char *fmt, ...);

#endif
