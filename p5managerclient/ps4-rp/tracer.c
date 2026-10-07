#include "tracer.h"

#define SIGSTOP_PS4 17
#define SIGTRAP_PS4 5
#define MAP_SIZE 0x10000u
#define PT_STEP_PS4 9
uint16_t get_firmware(void);
int rp_sys_ptrace(int request, int pid, void *address, int data);
SYSCALL(rp_sys_ptrace, 26);
int rp_sys_wait4(int pid, int *status, int options, void *usage);
SYSCALL(rp_sys_wait4, 7);

/* The SDK jailbreak grants filesystem access, but ptrace checks the
 * debugger PAID separately. Save and restore the payload's own credential. */
struct debug_credential_args { void *handler; rp_tracer *tracer; };
static int debug_credentials(struct thread *td, struct debug_credential_args *args) {
  rp_tracer *t=args->tracer;
  uint8_t *cred=*(uint8_t **)((uint8_t *)td+304);
  if(!cred) return -1;
  uint64_t *authid=(void*)(cred+88), *caps=(void*)(cred+104);
  uint8_t *proc_cred=(uint8_t*)td->td_proc->p_ucred;
  uint8_t *target=(uint8_t*)td->td_proc;
  for(int i=0;i<512 && target;i++) {
    if(*(int*)(target+0xb0)==t->pid) break;
    target=*(uint8_t**)target;
  }
  if(target && *(int*)(target+0xb0)!=t->pid) target=NULL;
  if(!t->elevated) {
    t->saved_authid=*authid;
    t->saved_attributes=*(uint64_t*)(cred+96);
    t->saved_caps[0]=caps[0]; t->saved_caps[1]=caps[1];
    *authid=0x3800000000000007ULL;
    caps[0]=caps[1]=~0ULL;
    *(uint64_t*)(cred+96)=~0ULL;
    if(proc_cred && proc_cred!=cred) {
      uint64_t *proc_auth=(void*)(proc_cred+88), *proc_caps=(void*)(proc_cred+104);
      t->saved_proc_authid=*proc_auth;
      t->saved_proc_attributes=*(uint64_t*)(proc_cred+96);
      t->saved_proc_caps[0]=proc_caps[0]; t->saved_proc_caps[1]=proc_caps[1];
      *proc_auth=0x3800000000000007ULL; proc_caps[0]=proc_caps[1]=~0ULL;
      *(uint64_t*)(proc_cred+96)=~0ULL;
      t->proc_cred_distinct=1;
    }
    t->elevated=1;
    if(t->firmware==1100) {
      uint8_t *base=(uint8_t *)(__readmsr(0xC0000082)-0x1c0);
      for(int i=0;i<16;i++) {
        t->ptrace_check1[i]=base[0x384285+i];
        t->ptrace_check2[i]=base[0x384771+i];
        t->system_debug_check[i]=base[0x3d0de0+i];
      }
      /* Verified 11.00 ptrace checks, matching ps4debug's two patches.
       * Refuse other instruction layouts rather than guessing offsets. */
      if(t->ptrace_check1[0]==0x77 && t->ptrace_check1[1]==0x1c &&
          t->ptrace_check2[0]==0x48 && t->ptrace_check2[1]==0x8b &&
          t->ptrace_check2[2]==0x41 && t->ptrace_check2[3]==0x08 && t->ptrace_check2[4]==0x44) {
        uint64_t cr0=readCr0(); writeCr0(cr0&~X86_CR0_WP);
        volatile uint8_t *one=base+0x384285, *two=base+0x384771;
        one[0]=0xeb;
        two[0]=0xe9; two[1]=0x7c; two[2]=0x02; two[3]=0; two[4]=0;
        writeCr0(cr0);
        t->patched=1;
      }
      if(target) {
        t->target_proc=(uintptr_t)target;
        t->target_flags=*(uint32_t*)(target+0x430);
        *(volatile uint32_t*)(target+0x430)=t->target_flags&~0x20000u;
        t->target_unprotected=1;
      }
    }
  } else {
    if(t->target_unprotected && target && (uintptr_t)target==t->target_proc) {
      *(volatile uint32_t*)(target+0x430) |= t->target_flags&0x20000u;
      t->target_unprotected=0;
    }
    if(t->patched) {
      uint8_t *base=(uint8_t *)(__readmsr(0xC0000082)-0x1c0);
      uint64_t cr0=readCr0(); writeCr0(cr0&~X86_CR0_WP);
      volatile uint8_t *one=base+0x384285, *two=base+0x384771;
      one[0]=t->ptrace_check1[0];
      for(int i=0;i<5;i++) two[i]=t->ptrace_check2[i];
      writeCr0(cr0); t->patched=0;
    }
    *authid=t->saved_authid;
    *(uint64_t*)(cred+96)=t->saved_attributes;
    caps[0]=t->saved_caps[0]; caps[1]=t->saved_caps[1];
    if(t->proc_cred_distinct && proc_cred) {
      uint64_t *proc_auth=(void*)(proc_cred+88), *proc_caps=(void*)(proc_cred+104);
      *proc_auth=t->saved_proc_authid;
      *(uint64_t*)(proc_cred+96)=t->saved_proc_attributes;
      proc_caps[0]=t->saved_proc_caps[0]; proc_caps[1]=t->saved_proc_caps[1];
      t->proc_cred_distinct=0;
    }
    t->elevated=0;
  }
  return 0;
}

static int pt(rp_tracer *t, int request, void *addr, int data) {
  return rp_sys_ptrace(request, t->pid, addr, data);
}

static int wait_stop(rp_tracer *t, int timeout_ms, int *signal) {
  for (int i=0; i<timeout_ms/10; i++) {
    int status=0;
    int rc=rp_sys_wait4(t->pid,&status,1,0);
    if (rc==t->pid) {
      if ((status & 0xff)!=0x7f) { rp_log("[ptrace] target exited status=0x%x\n",status); t->attached=0; t->stopped=0; return -1; }
      t->stopped=1;
      if(signal) *signal=(status>>8)&0xff;
      return 0;
    }
    if(rc<0 && errno!=4) return -1;
    sceKernelUsleep(10000);
  }
  return -1;
}

/* A SIGSTOP may catch a thread returning from a blocking syscall. Let
 * its kernel return finish before replacing registers for an RPC. */
static int settle_stop(rp_tracer *t) {
  if(!t->stopped || pt(t,PT_STEP_PS4,(void*)1,0)) return -1;
  t->stopped=0;
  int sig=0;
  if(wait_stop(t,3000,&sig) || sig!=SIGTRAP_PS4) {
    rp_log("[ptrace] single step failed signal=%d\n",sig);
    return -1;
  }
  return 0;
}

int rp_trace_pause(rp_tracer *t) {
  if(t->stopped) return 0;
  if(!t->attached || (int)syscall(37,t->pid,SIGSTOP_PS4)) return -1;
  if(wait_stop(t,3000,NULL)) return -1;
  return settle_stop(t);
}

int rp_trace_resume(rp_tracer *t) {
  if(!t->stopped || pt(t,PT_CONTINUE,(void*)1,0)) return -1;
  t->stopped=0;
  return 0;
}

static int transfer(rp_tracer *t, int op, uintptr_t addr, void *data, size_t size) {
  struct ptrace_io_desc io={op,(void*)addr,data,size};
  if(!t->stopped || pt(t,PT_IO,&io,0)) return -1;
  return io.piod_len==size ? 0 : -1;
}
int rp_trace_read(rp_tracer *t, uintptr_t addr, void *dst, size_t size) {
  return transfer(t,PIOD_READ_D,addr,dst,size);
}
int rp_trace_write(rp_tracer *t, uintptr_t addr, const void *src, size_t size) {
  return transfer(t,PIOD_WRITE_D,addr,(void*)src,size);
}

/* Bootstrap only: execute one syscall in the stopped thread and restore
 * its instructions and complete register state before returning. */
static int remote_syscall(rp_tracer *t, uint64_t number, uint64_t a, uint64_t b,
                          uint64_t c, uint64_t d, uint64_t e, uint64_t f, uint64_t *result) {
  rp_regs saved, regs;
  unsigned char code[3], fpregs[4096] __attribute__((aligned(16)));
  const unsigned char syscall_trap[3]={0x0f,0x05,0xcc};
  if(!t->stopped || pt(t,PT_GETREGS,&saved,0) || pt(t,PT_GETFPREGS,fpregs,0)) return -1;
  regs=saved;
  uintptr_t instruction=t->scratch && number!=73 ? t->scratch+0x10 : saved.rip;
  if(rp_trace_read(t,instruction,code,3)) return -1;
  if(rp_trace_write(t,instruction,syscall_trap,3)) return -1;
  regs.rip=instruction;
  regs.rax=number; regs.rdi=a; regs.rsi=b; regs.rdx=c; regs.r10=d; regs.r8=e; regs.r9=f;
  int ok=0;
  if(!pt(t,PT_SETREGS,&regs,0) && !rp_trace_resume(t)) {
    int sig=0;
    if(!wait_stop(t,3000,&sig) && sig==SIGTRAP_PS4 && !pt(t,PT_GETREGS,&regs,0) && regs.rip==instruction+3) {
      *result=regs.rax;
      ok=!(regs.rflags&1); /* FreeBSD reports syscall errno via carry. */
      if(!ok && number!=591) rp_log("[ptrace] remote syscall %llu errno=%llu\n",(unsigned long long)number,(unsigned long long)regs.rax);
    }
  }
  if(!t->stopped && rp_trace_pause(t)) return -1;
  if(!ok && number!=591) {
    rp_regs failure;
    if(!pt(t,PT_GETREGS,&failure,0)) rp_log("[ptrace] syscall %llu failed rip=%p rax=%llx\n",(unsigned long long)number,(void*)failure.rip,(unsigned long long)failure.rax);
  }
  int restore=rp_trace_write(t,instruction,code,3);
  restore |= pt(t,PT_SETFPREGS,fpregs,0);
  restore |= pt(t,PT_SETREGS,&saved,0);
  return ok && !restore ? 0 : -1;
}

int rp_trace_attach(rp_tracer *t, int pid) {
  memset(t,0,sizeof(*t)); t->pid=pid;
  t->firmware=get_firmware();
  if(pid<=0 || pid==getpid()) return -1;
  if(kexec((void*)debug_credentials,t)) { rp_log("Error: could not set debugger credentials\n"); return -1; }
  rp_log("[ptrace] patched=%d target=%p flags=0x%x\n",t->patched,(void*)t->target_proc,t->target_flags);
  if(pt(t,PT_ATTACH,NULL,0)) {
    rp_log("Error: SceShellUI ptrace attach errno=%d\n",errno);
    rp_log("[ptrace] fw=%u previous authid=%016llx\n",t->firmware,(unsigned long long)t->saved_authid);
    for(int i=0;i<16;i++) rp_log("%02x",t->ptrace_check1[i]);
    rp_log("\n");
    for(int i=0;i<16;i++) rp_log("%02x",t->system_debug_check[i]);
    rp_log("\npatched=%d\n",t->patched);
    for(int i=0;i<16;i++) rp_log("%02x",t->ptrace_check2[i]);
    rp_log("\n");
    kexec((void*)debug_credentials,t);
    return -1;
  }
  t->attached=1;
  rp_log("[ptrace] attached\n");
  if(wait_stop(t,3000,NULL)) { rp_trace_detach(t); return -1; }
  if(settle_stop(t)) { rp_trace_detach(t); return -1; }
  rp_log("[ptrace] target stopped\n");
  uint64_t memory=0;
  /* A private stack avoids modifying SceShellUI's active stack/red zone. */
  if(remote_syscall(t,477,0,MAP_SIZE,7,0x1002,(uint64_t)-1,0,&memory)) {
    rp_log("Error: could not allocate SceShellUI RPC scratch memory\n");
    rp_trace_detach(t); return -1;
  }
  t->scratch=memory; t->buffer=memory+0x4000; t->stack=memory+MAP_SIZE-0x100;
  rp_log("[ptrace] scratch=%p\n",(void*)memory);
  const unsigned char trap=0xcc;
  if(rp_trace_write(t,memory,&trap,1)) { rp_trace_detach(t); return -1; }
  return 0;
}

int rp_trace_call(rp_tracer *t, uintptr_t function, uint64_t a, uint64_t b,
                  uint64_t c, uint64_t d, uint64_t e, uint64_t f, uint64_t *result) {
  rp_regs saved, regs;
  unsigned char fpregs[4096] __attribute__((aligned(16)));
  if(!function || !t->scratch || !t->stopped || pt(t,PT_GETREGS,&saved,0) || pt(t,PT_GETFPREGS,fpregs,0)) return -1;
  regs=saved;
  regs.rip=function; regs.rsp=(t->stack&~15ULL)-8;
  regs.rdi=a; regs.rsi=b; regs.rdx=c; regs.rcx=d; regs.r8=e; regs.r9=f;
  if(rp_trace_write(t,regs.rsp,&t->scratch,8)) return -1;
  int ok=0;
  int call_signal=0;
  if(!pt(t,PT_SETREGS,&regs,0) && !rp_trace_resume(t)) {
    int sig=0;
    int stopped=wait_stop(t,3000,&sig);
    call_signal=sig;
    if(!stopped && sig==SIGTRAP_PS4 && !pt(t,PT_GETREGS,&regs,0) && regs.rip==t->scratch+1) {
      *result=regs.rax; ok=1;
    }
  }
  if(!t->stopped && rp_trace_pause(t)) return -1;
  if(!ok && !pt(t,PT_GETREGS,&regs,0))
    rp_log("[ptrace] call stop signal=%d rip=%p rsp=%p rax=%llx\n",call_signal,(void*)regs.rip,(void*)regs.rsp,(unsigned long long)regs.rax);
  int restore=pt(t,PT_SETFPREGS,fpregs,0);
  restore |= pt(t,PT_SETREGS,&saved,0);
  if(!ok) rp_log("Error: remote call %p did not return before its deadline\n",(void*)function);
  return ok && !restore ? 0 : -1;
}

uintptr_t rp_trace_symbol(rp_tracer *t, const char *name) {
  int handles[256]={0}, count=0;
  uint64_t rc=0;
  uintptr_t remote_handles=t->buffer, remote_count=t->buffer+0x400;
  uintptr_t remote_name=t->buffer+0x410, remote_addr=t->buffer+0x600;
  if(strlen(name)>=0x180 || rp_trace_write(t,remote_count,&count,4) ||
      remote_syscall(t,592,remote_handles,256,remote_count,0,0,0,&rc) || rc ||
      rp_trace_read(t,remote_count,&count,4) || count<0 || count>256 ||
      rp_trace_read(t,remote_handles,handles,count*sizeof(int)) ||
      rp_trace_write(t,remote_name,name,strlen(name)+1)) return 0;
  for(int i=0;i<count;i++) {
    uintptr_t addr=0;
    if(rp_trace_write(t,remote_addr,&addr,8)) return 0;
    if(!remote_syscall(t,591,handles[i],remote_name,remote_addr,0,0,0,&rc) && !rc &&
        !rp_trace_read(t,remote_addr,&addr,8) && addr) return addr;
  }
  return 0;
}

int rp_trace_detach(rp_tracer *t) {
  if(!t->attached) {
    if(t->elevated) kexec((void*)debug_credentials,t);
    return 0;
  }
  if(rp_trace_pause(t)) return -1;
  if(t->scratch) {
    uint64_t ignored=0;
    remote_syscall(t,73,t->scratch,MAP_SIZE,0,0,0,0,&ignored);
    t->scratch=0;
  }
  int rc=pt(t,PT_DETACH,(void*)1,0);
  if(!rc) {
    t->attached=0; t->stopped=0;
    if(t->elevated) kexec((void*)debug_credentials,t);
  }
  return rc;
}
