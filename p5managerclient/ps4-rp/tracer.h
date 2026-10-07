#pragma once
#include "common.h"

/* FreeBSD amd64 PT_GETREGS ABI used by PS4. */
typedef struct {
  uint64_t r15,r14,r13,r12,r11,r10,r9,r8,rdi,rsi,rbp,rbx,rdx,rcx,rax;
  uint32_t trapno;
  uint16_t fs,gs;
  uint32_t err;
  uint16_t es,ds;
  uint64_t rip,cs,rflags,rsp,ss;
} rp_regs;

typedef struct {
  int pid;
  int attached;
  int stopped;
  uintptr_t scratch;
  uintptr_t stack;
  uintptr_t buffer;
  uint64_t saved_authid;
  uint64_t saved_caps[2];
  int elevated;
  uint16_t firmware;
  uint8_t ptrace_check1[16];
  uint8_t ptrace_check2[16];
  int patched;
  uint8_t system_debug_check[16];
  uintptr_t target_proc;
  uint32_t target_flags;
  int target_unprotected;
  uint64_t saved_proc_authid;
  uint64_t saved_proc_caps[2];
  int proc_cred_distinct;
  uint64_t saved_attributes;
  uint64_t saved_proc_attributes;
} rp_tracer;

int rp_trace_attach(rp_tracer *t, int pid);
int rp_trace_detach(rp_tracer *t);
int rp_trace_pause(rp_tracer *t);
int rp_trace_resume(rp_tracer *t);
int rp_trace_read(rp_tracer *t, uintptr_t addr, void *dst, size_t size);
int rp_trace_write(rp_tracer *t, uintptr_t addr, const void *src, size_t size);
int rp_trace_call(rp_tracer *t, uintptr_t function, uint64_t a, uint64_t b,
                  uint64_t c, uint64_t d, uint64_t e, uint64_t f, uint64_t *result);
uintptr_t rp_trace_symbol(rp_tracer *t, const char *name);
