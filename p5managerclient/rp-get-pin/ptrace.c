// https://github.com/astrelsky/HEN-V/blob/8d45c365e592705fa23be72443df71ba471b7ee0/spawner/source/tracer.c
// https://github.com/ps5-payload-dev/websrv/blob/7734267a1e771f17d23838ce9bcd66f51c168297/src/ps5/pt.c

#include <sys/types.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <sys/time.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/sysctl.h>

#include <ps5/kernel.h>
#include <ps5/mdbg.h>

#include "ptrace.h"

// mdbg_copyin/copyout with PT_IO fallback. See header for rationale.
int safe_copyin(int pid, const void *src_local, uintptr_t dst_remote, size_t len)
{
    if (mdbg_copyin(pid, src_local, dst_remote, len) == 0) return 0;
    struct ptrace_io_desc io;
    io.piod_op = PIOD_WRITE_D;
    io.piod_offs = (void *)(uintptr_t)dst_remote;
    io.piod_addr = (void *)(uintptr_t)src_local;
    io.piod_len = len;
    if ((int)syscall(SYS_ptrace, PT_IO, pid, (caddr_t)&io, 0) < 0) return -1;
    return io.piod_len == len ? 0 : -1;
}

int safe_copyout(int pid, uintptr_t src_remote, void *dst_local, size_t len)
{
    if (mdbg_copyout(pid, src_remote, dst_local, len) == 0) return 0;
    struct ptrace_io_desc io;
    io.piod_op = PIOD_READ_D;
    io.piod_offs = (void *)(uintptr_t)src_remote;
    io.piod_addr = dst_local;
    io.piod_len = len;
    if ((int)syscall(SYS_ptrace, PT_IO, pid, (caddr_t)&io, 0) < 0) return -1;
    return io.piod_len == len ? 0 : -1;
}

int tracer_init(tracer_t *restrict self, int pid)
{
    memset(self, 0, sizeof(tracer_t));

    uint8_t privcaps[16] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
                            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff};

    pid_t mypid = getpid();
    if (mypid == pid)
    {
        return -1;
    }

    uint64_t og_authid = kernel_get_ucred_authid(mypid);
    if (og_authid == 0)
    {
        return -1;
    }

    uint8_t og_caps[16] = {0};
    if (kernel_get_ucred_caps(mypid, og_caps))
    {
        return -1;
    }

    if (kernel_set_ucred_authid(mypid, 0x4800000000010003l))
    {
        return -1;
    }

    if (kernel_set_ucred_caps(mypid, privcaps))
    {
        kernel_set_ucred_authid(mypid, og_authid);
        return -1;
    }

    if ((int)syscall(SYS_ptrace, PT_ATTACH, pid, 0, 0) < 0)
    {
        kernel_set_ucred_authid(mypid, og_authid);
        kernel_set_ucred_caps(mypid, og_caps);
        return -1;
    }

    int status = 0;
    if (waitpid(pid, &status, 0) < 0)
    {
        return -1;
    }

    self->pid = pid;
    self->original_authid = og_authid;
    memcpy(self->original_caps, og_caps, sizeof(og_caps));

    return 0;
}

int tracer_finalize(tracer_t *restrict self)
{
    if (self->pid == 0)
    {
        return -1;
    }

    if ((int)syscall(SYS_ptrace, PT_DETACH, self->pid, 0, 0))
    {
        return -1;
    }

    kernel_set_ucred_authid(getpid(), self->original_authid);
    kernel_set_ucred_caps(getpid(), self->original_caps);

    self->pid = 0;

    return 0;
}

static void set_args(reg_t *restrict regs, uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f)
{
    regs->r_rdi = (register_t)a;
    regs->r_rsi = (register_t)b;
    regs->r_rdx = (register_t)c;
    regs->r_rcx = (register_t)d;
    regs->r_r8 = (register_t)e;
    regs->r_r9 = (register_t)f;
}

#define LIBKERNEL_HANDLE 0x2001

uintptr_t tracer_call(tracer_t *restrict self, uintptr_t addr, uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f)
{
    if (addr == 0)
    {
        puts("invalid address");
        errno = EINVAL;
        return (uintptr_t)-1L;
    }

    reg_t jmp;
    if ((int)syscall(SYS_ptrace, PT_GETREGS, self->pid, (caddr_t)&jmp, 0) < 0)
    {
        puts("failed to get registers");
        return (uintptr_t)-1L;
    }

    const reg_t backup = jmp;
    
    jmp.r_rip = (register_t)addr;
    set_args(&jmp, a, b, c, d, e, f);

    if (self->libkernel_base == 0)
    {
        self->libkernel_base = kernel_dynlib_mapbase_addr(self->pid, LIBKERNEL_HANDLE);
        if (self->libkernel_base == 0)
        {
            puts("failed to get libkernel base for traced proc");
            return -1;
        }
    }

    jmp.r_rsp = (register_t)(jmp.r_rsp - sizeof(uintptr_t));

    if ((int)syscall(SYS_ptrace, PT_SETREGS, self->pid, (caddr_t)&jmp, 0) < 0)
    {
        puts("failed to set registers");
        return -1;
    }

    // Re-assert privileged authid + caps right before the write. We did
    // this in tracer_init, but PT_ATTACH / other kernel paths sometimes
    // revert ucred fields on PS5, and mdbg_copyin returns EPERM if our
    // authid drops. Cheap to redo, prevents spurious EPERMs.
    {
        uint8_t privcaps[16];
        memset(privcaps, 0xff, sizeof(privcaps));
        kernel_set_ucred_authid(getpid(), 0x4800000000010003l);
        kernel_set_ucred_caps(getpid(), privcaps);
    }

    // Write the trampoline return address. safe_copyin tries mdbg first
    // and silently falls back to PT_IO if mdbg returns EPERM (kstuff's
    // syscall hook blocks mdbg on some setups). Fails only when BOTH
    // paths fail, which would be a real memory-mapping issue.
    if (safe_copyin(self->pid, &self->libkernel_base, jmp.r_rsp, sizeof(self->libkernel_base)) != 0)
    {
        printf("tracer_call: failed to write return address (mdbg + PT_IO both errored)\n");
        return -1;
    }

    // Verify the trap canary (INT3) actually exists at libkernel_base
    // before we hand control to the target - if libkernel doesn't start
    // with 0xCC on this firmware, we'd loop forever waiting for a
    // SIGTRAP that can never fire. Only checked on the first call
    // per-process; libkernel doesn't move so re-checking is wasted work.
    static int canary_checked = 0;
    if (!canary_checked)
    {
        uint8_t canary = 0;
        if (safe_copyout(self->pid, self->libkernel_base, &canary, 1) != 0)
        {
            printf("tracer_call: failed to read trap canary at libkernel_base\n");
            return -1;
        }
        if (canary != 0xCC)
        {
            printf("tracer_call: libkernel_base@%lx has 0x%02x, not 0xCC - INT3 trap canary missing\n",
                   (uint64_t)self->libkernel_base, canary);
            return -1;
        }
        canary_checked = 1;
    }

    // call the function
    if ((int)syscall(SYS_ptrace, PT_CONTINUE, self->pid, (caddr_t)1, 0) < 0)
    {
        puts("failed to continue");
        return -1;
    }

    // Signal-forwarding wait loop. When kstuff / shadowmount / similar
    // payloads are also running, they periodically poke SceShellUI with
    // signals (SIGSTOP from monitoring, SIGCHLD from spawned helpers,
    // etc.). Each such signal makes waitpid() return early with a
    // non-SIGTRAP WSTOPSIG before our INT3 at the return address has
    // fired. The original code treated any non-SIGTRAP as a fatal error,
    // which is why running rp-get-pin alongside kstuff fails with
    // "process received signal 17 but SIGTRAP was expected".
    //
    // The fix mirrors chiaki / HEN-V / pyrebooter: keep PT_CONTINUE'ing
    // while either discarding the spurious signal (SIGSTOP/SIGCHLD which
    // are control-plane and would re-stop the target if redelivered) or
    // forwarding application-level signals so the target sees them. Exit
    // the loop only on SIGTRAP (our INT3) or on real failure.
    // Bounded polling wait loop. We use a wall-clock deadline so a stuck
    // tracer slot (kstuff holding SceShellUI, etc.) can't deadlock us
    // forever. WNOHANG + short sleep keeps CPU usage trivial while
    // letting us bail out cleanly.
    const int MAX_SWALLOW = 128;
    const int WALL_BUDGET_MS = 5000;
    const int POLL_SLEEP_MS = 10;
    int state = 0;
    int sigtrap_seen = 0;
    int swallow_count = 0;
    struct timespec ts0;
    clock_gettime(CLOCK_MONOTONIC, &ts0);
    uint64_t deadline_ms = (uint64_t)ts0.tv_sec * 1000 + ts0.tv_nsec / 1000000 + WALL_BUDGET_MS;

    while (1)
    {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        uint64_t now_ms = (uint64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
        if (now_ms >= deadline_ms)
        {
            printf("tracer_call: deadline %d ms hit (swallowed %d signals), bailing\n", WALL_BUDGET_MS, swallow_count);
            return -1;
        }

        pid_t r = waitpid(self->pid, &state, WNOHANG);
        if (r < 0)
        {
            puts("failed to wait");
            return -1;
        }
        if (r == 0)
        {
            usleep(POLL_SLEEP_MS * 1000);
            continue;
        }
        if (!WIFSTOPPED(state))
        {
            puts("process not stopped");
            return -1;
        }
        int sig = WSTOPSIG(state);
        if (sig == SIGTRAP)
        {
            sigtrap_seen = 1;
            break;
        }
        if (++swallow_count > MAX_SWALLOW)
        {
            printf("tracer_call: too many spurious signals (%d), giving up\n", swallow_count);
            return -1;
        }
        // Swallow control-plane stops; forward everything else.
        int forward = sig;
        if (sig == SIGSTOP || sig == SIGTSTP || sig == SIGTTIN || sig == SIGTTOU)
            forward = 0;
        printf("tracer_call: swallowing signal %d (#%d), continuing\n", sig, swallow_count);
        fflush(stdout);
        if ((int)syscall(SYS_ptrace, PT_CONTINUE, self->pid, (caddr_t)1, forward) < 0)
        {
            puts("failed to continue after signal");
            return -1;
        }
    }

    if (!sigtrap_seen)
    {
        printf("tracer_call: gave up waiting for SIGTRAP\n");
        return -1;
    }

    if ((int)syscall(SYS_ptrace, PT_GETREGS, self->pid, (caddr_t)&jmp, 0) < 0)
    {
        puts("failed to get registers");
        return -1;
    }

    // restore registers
    if ((int)syscall(SYS_ptrace, PT_SETREGS, self->pid, (caddr_t)&backup, 0) < 0)
    {
        perror("tracer_start_call set registers failed");
        return -1;
    }

    return jmp.r_rax;
}
