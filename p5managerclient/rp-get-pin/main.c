#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>
#include <sys/sysctl.h>
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <sys/syscall.h>
#include <errno.h>
#include <stdint.h>
#include <time.h>
#include <signal.h>

#include <ps5/kernel.h>
#include <ps5/mdbg.h>
#include "ptrace.h"
#include "utils.h"

#define SCE_REGMGR_ENT_KEY_REMOTEPLAY_rp_enable 1098973184

#define PAIRING_TIMEOUT_MS 120 * 1000 // 120s - you can change this to anything, it seems the pin doesnt expire by itself, the 300s timeout in shellui is handled by shellui

int sceUserServiceInitialize(void *);
int sceUserServiceGetForegroundUser(int *);
int sceRegMgrGetInt(int, int *);
int sceRegMgrGetBin(int, void *, size_t);
int sceRegMgrGetStr(int, char *, size_t);
int sceRegMgrSetInt(int, int);

volatile sig_atomic_t exit_requested = 0;

void sigterm_handler(int signum) {
    exit_requested = 1;
    printf("Exiting gracefully...\n");
}

uint32_t SCE_REGMGR_ENT_NUM(uint32_t a, uint32_t b, uint32_t c, uint32_t d, uint32_t e)
{
    if (a < 1 || a > b)
    {
        return e;
    }
    return (a - 1) * c + d;
}

uint32_t SCE_REGMGR_ENT_KEY_USER_01_16_user_id(uint32_t a)
{
    return SCE_REGMGR_ENT_NUM(a, 16u, 65536u, 125829376u, 127140096u);
}

uint32_t SCE_REGMGR_ENT_KEY_USER_01_16_account_id(uint32_t a)
{
    return SCE_REGMGR_ENT_NUM(a, 16u, 65536u, 125830400u, 127141120u);
}

int get_current_user_registry_index()
{
    sceUserServiceInitialize(0);

    int user = 0;
    int res = sceUserServiceGetForegroundUser(&user);
    if (res != 0)
    {
        notifyf_printf("failed to get foreground user: 0x%X", res);
        return -1;
    }

    for (int i = 1; i <= 16; i++)
    {
        int32_t user_id = 0;
        res = sceRegMgrGetInt(SCE_REGMGR_ENT_KEY_USER_01_16_user_id(i), &user_id);
        if (res == 0 && user_id == user)
        {
            return i;
        }
    }

    notifyf_printf("failed to find user in registry");
    return -1;
}

// i couldnt get sceRemoteplayInitialize to work from here, it just blocks forever, my best guess is that it only works from a bigapp..?
// didnt look into this, decided to just ptrace SceShellUI

int main()
{
    // Switch to unbuffered stdio BEFORE anything else so even an early
    // crash flushes whatever printfs we've done. Default on FreeBSD when
    // stdout is a socket is full buffering; unbuffered means every byte
    // hits the elfldr socket immediately.
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    printf("[rp-get-pin] starting, pid=%d\n", getpid());

    signal(SIGTERM, sigterm_handler);

    syscall(SYS_thr_set_name, -1, OUTPUT_FILENAME);

    // Old-instance cleanup. We use SIGTERM (graceful) here so the old
    // copy runs its tracer_finalize() in main, which PT_DETACHes from
    // SceShellUI cleanly. This is critical: SIGKILL leaves SceShellUI in
    // a state where libSceRemoteplay's GeneratePinCode permanently
    // returns 0x80FC0004 (service not initialized) - presumably because
    // SceShellUI's internal RP state machine doesn't recover from an
    // abrupt tracer kill.
    //
    // The old instance's waitpid() is now bounded by ptrace.c's 5 s
    // WALL_BUDGET_MS, so even if it was stuck in ptrace contention it
    // will exit waitpid soon after we set exit_requested=1 via SIGTERM
    // and reach tracer_finalize within ~5-6 s.
    //
    // If SIGTERM doesn't get rid of the old instance after 15 attempts
    // (15 * 500 ms = 7.5 s), escalate to SIGKILL as a last resort and
    // warn the user that SceShellUI may need rebooting.
    int found_old = 0;
    int pid_old;
    int term_iter = 0;
    while ((pid_old = find_pid(OUTPUT_FILENAME)) > 0)
    {
        ++term_iter;
        if (term_iter == 1)
        {
            printf("[rp-get-pin] old instance pid=%d, sending SIGTERM\n", pid_old);
        }
        if (term_iter <= 15)
        {
            kill(pid_old, SIGTERM);
        }
        else
        {
            // Last-ditch attempt; SceShellUI may need a reboot afterwards.
            printf("[rp-get-pin] SIGTERM failed to clear pid=%d after %d tries; escalating to SIGKILL\n",
                   pid_old, term_iter - 1);
            kill(pid_old, SIGKILL);
            usleep(100 * 1000);
            break;
        }
        found_old = 1;
        usleep(500 * 1000);
    }

    if (found_old)
    {
        // After graceful exit, SceShellUI is still the same instance and
        // libSceRemoteplay is already mapped, so we only need a short
        // settle time before re-attaching.
        printf("[rp-get-pin] old instance cleared, settling 1 s\n");
        usleep(1000 * 1000);
    }

    int32_t original_rp_enable_val = 0;
    if (sceRegMgrGetInt(SCE_REGMGR_ENT_KEY_REMOTEPLAY_rp_enable, &original_rp_enable_val))
    {
        notifyf_printf("Failed to get REMOTEPLAY_rp_enable");
        return -1;
    }

    if (original_rp_enable_val != 1)
    {
        int32_t new_val = 1;
        if (sceRegMgrSetInt(SCE_REGMGR_ENT_KEY_REMOTEPLAY_rp_enable, new_val))
        {
            notifyf_printf("Failed to set REMOTEPLAY_rp_enable");
            return -1;
        }

        int32_t verify_val = -1;
        if (sceRegMgrGetInt(SCE_REGMGR_ENT_KEY_REMOTEPLAY_rp_enable, &verify_val))
        {
            notifyf_printf("Failed to verify REMOTEPLAY_rp_enable");
            return -1;
        }

        if (verify_val != new_val)
        {
            notifyf_printf("Failed to set REMOTEPLAY_rp_enable: 0x%X", verify_val);
            return -1;
        }
    }

    pid_t shellui_pid = find_pid("SceShellUI");
    if (shellui_pid <= 0)
    {
        printf("[rp-get-pin] find_pid(\"SceShellUI\") returned %d; dumping all processes:\n", shellui_pid);
        dump_all_pids();
        notifyf_printf("Failed to find SceShellUI");
        return -1;
    }

    // Resolve sceRemoteplayGeneratePinCode with retries. After a respawn,
    // libSceRemoteplay.sprx may not be mapped yet for several seconds.
    // We poll every 250 ms for up to 8 s (32 attempts).
    uintptr_t sceRemoteplayGeneratePinCode_addr = 0;
    for (int i = 0; i < 32; i++)
    {
        sceRemoteplayGeneratePinCode_addr = resolve_symbol_from_lib_for_pid(
            shellui_pid, "libSceRemoteplay.sprx", "sceRemoteplayGeneratePinCode");
        if (sceRemoteplayGeneratePinCode_addr != 0) break;
        // Also re-find the pid in case SceShellUI crashed again.
        pid_t fresh = find_pid("SceShellUI");
        if (fresh > 0 && fresh != shellui_pid)
        {
            printf("[rp-get-pin] SceShellUI pid changed %d -> %d while resolving\n", shellui_pid, fresh);
            shellui_pid = fresh;
        }
        usleep(250 * 1000);
    }
    if (sceRemoteplayGeneratePinCode_addr == 0)
    {
        notifyf_printf("Failed to resolve sceRemoteplayGeneratePinCode");
        return -1;
    }

    // int32_t sceRemotePlayConfirmDeviceRegist(int32_t* status, int32_t* errorCode);
    uintptr_t sceRemotePlayConfirmDeviceRegist_addr = resolve_symbol_from_lib_for_pid(shellui_pid, "libSceRemoteplay.sprx", "sceRemoteplayConfirmDeviceRegist");
    if (sceRemotePlayConfirmDeviceRegist_addr == 0)
    {
        notifyf_printf("Failed to resolve sceRemotePlayConfirmDeviceRegist");
        return -1;
    }

    // int32_t sceRemoteplayNotifyPinCodeError(int32_t errorcode);
    uintptr_t sceRemoteplayNotifyPinCodeError_addr = resolve_symbol_from_lib_for_pid(shellui_pid, "libSceRemoteplay.sprx", "sceRemoteplayNotifyPinCodeError");
    if (sceRemoteplayNotifyPinCodeError_addr == 0)
    {
        notifyf_printf("Failed to resolve sceRemoteplayNotifyPinCodeError");
        return -1;
    }

    uintptr_t calloc_addr = resolve_symbol_from_lib_for_pid(shellui_pid, "libSceLibcInternal.sprx", "calloc");
    if (calloc_addr == 0)
    {
        notifyf_printf("Failed to resolve calloc");
        return -1;
    }

    uintptr_t free_addr = resolve_symbol_from_lib_for_pid(shellui_pid, "libSceLibcInternal.sprx", "free");
    if (free_addr == 0)
    {
        notifyf_printf("Failed to resolve free");
        return -1;
    }

    int user_registry_index = get_current_user_registry_index();
    if (user_registry_index == -1)
    {
        notifyf_printf("Failed to get current user registry index");
        return -1;
    }

    uint8_t account_id[8] = {0};
    int res = sceRegMgrGetBin(SCE_REGMGR_ENT_KEY_USER_01_16_account_id(user_registry_index), &account_id, sizeof(account_id));
    if (res != 0)
    {
        notifyf_printf("Failed to get account id: 0x%X", res);
        return -1;
    }

    char *base64_account_id = base64_encode(account_id, sizeof(account_id));
    if (base64_account_id == NULL)
    {
        notifyf_printf("Failed to base64 encode account id");
        return -1;
    }

    // Fetch the PSN online_id (human display name) via regmgr.
    //
    // Key 0x0780B00C is SCE_REGMGR_ENT_KEY_USER_01_16_NP_online_id and
    // is documented as a 17-byte NUL-terminated string in np-fake-signin
    // and apollo-ps4. Per-user offset is (slot - 1) * 0x10000.
    //
    // We avoid sceUserServiceGetNpOnlineId entirely - on kstuff-modified
    // PS5s it blocks forever in a non-cancellable kernel wait and the
    // process becomes unkillable even with SIGKILL.
    //
    // Falling back to "(unknown)" is non-fatal: the PIN flow keeps
    // working, the host just doesn't get the display name.
    char online_id_str[18] = "(unknown)";
    {
        uint32_t key = 0x0780B00Cu + ((uint32_t)user_registry_index - 1u) * 0x10000u;
        char buf[17] = {0};
        int rc = sceRegMgrGetStr(key, buf, sizeof(buf));
        if (rc == 0 && buf[0] >= 0x20 && (uint8_t)buf[0] <= 0x7e)
        {
            memcpy(online_id_str, buf, sizeof(buf));
            online_id_str[sizeof(buf)] = '\0';
        }
        else
        {
            printf("[rp-get-pin] online_id lookup failed: key=0x%08x rc=0x%x\n",
                   key, (uint32_t)rc);
        }
    }

    tracer_t tracer;
    if (tracer_init(&tracer, shellui_pid))
    {
        notifyf_printf("Failed to init tracer");
        return -1;
    }
    printf("[rp-get-pin] attached to SceShellUI (pid=%d), generating PIN\n", shellui_pid);

    uintptr_t buffers_addr = tracer_call(&tracer, calloc_addr, 3, sizeof(uint32_t), 0, 0, 0, 0);
    if (buffers_addr == 0 || buffers_addr == -1)
    {
        notifyf_printf("Failed to allocate pincode buffer");
        goto end;
    }

    uintptr_t pincode_buf_addr = buffers_addr;
    uintptr_t status_buf_addr = buffers_addr + sizeof(uint32_t);
    uintptr_t errorcode_buf_addr = status_buf_addr + sizeof(uint32_t);

    tracer_call(&tracer, sceRemoteplayNotifyPinCodeError_addr, 1, 0, 0, 0, 0, 0); // invalidate previous pin if there is one, ignore error

    // sceRemoteplayGeneratePinCode can return 0x80FC0004 (Remote Play
    // service not ready) for up to ~10 s after a SceShellUI respawn,
    // even though the symbol address resolved. We retry up to 30 times
    // with a 500 ms backoff (= ~15 s budget). Logs only every 4th attempt
    // to keep the stdout log small. Also clears the pin-error sticky
    // state between attempts so a stale 0x80FC0004 from a previous call
    // doesn't keep being returned.
    res = -1;
    for (int rp_try = 0; rp_try < 30; rp_try++)
    {
        res = tracer_call(&tracer, sceRemoteplayGeneratePinCode_addr, pincode_buf_addr, 0, 0, 0, 0, 0);
        if (res == 0) break;
        if (rp_try % 4 == 0)
        {
            printf("[rp-get-pin] GeneratePinCode returned 0x%X, retrying (attempt %d/30)\n",
                   (uint32_t)res, rp_try + 1);
        }
        usleep(500 * 1000);
        tracer_call(&tracer, sceRemoteplayNotifyPinCodeError_addr, 1, 0, 0, 0, 0, 0);
    }
    if (res != 0)
    {
        notifyf_printf("Failed to generate pincode: 0x%X", res);
        goto end;
    }

    uint32_t pincode = 0;
    if (safe_copyout(shellui_pid, pincode_buf_addr, &pincode, sizeof(pincode)))
    {
        notifyf_printf("Failed to read pincode");
        goto end;
    }

    // unpause
    if ((int)syscall(SYS_ptrace, PT_CONTINUE, shellui_pid, (caddr_t)1, 0) < 0)
    {
        notifyf_printf("Failed to continue shellui");
        goto end;
    }

    // Order matters: host backend's parser keys off these prefixes, so
    // keep "Pin code:" / "User:" / "Account ID:" / "Timeout:" exactly as
    // shown (backend regex is anchored on the colon).
    printf("Pin code: %04u %04u\nUser: %s\nAccount ID: %s\nTimeout: %d seconds\n",
           pincode / 10000, pincode % 10000,
           online_id_str, base64_account_id,
           PAIRING_TIMEOUT_MS / 1000);
    fflush(stdout);

    int status = 0;
    int errorcode = 0;

    uint32_t notification_timeout_ms = 5750;
    uint64_t loop_start_ts = get_ms_time();
    uint64_t last_notification_ts = 0;
    uint32_t iteration_sleep_ms = 250;

    while (1)
    {
        uint64_t current_ts = get_ms_time();
        if (current_ts - last_notification_ts > notification_timeout_ms)
        {
            // Don't printf here so the terminal won't keep scrolling
            notifyf("Pin code: %04u %04u\nUser: %s\nAccount ID: %s\n\nSeconds left: %u",
                    pincode / 10000, pincode % 10000,
                    online_id_str, base64_account_id,
                    (PAIRING_TIMEOUT_MS - (current_ts - loop_start_ts)) / 1000);
            last_notification_ts = current_ts;
        }

        // Stop shellui
        if ((int)kill(shellui_pid, SIGSTOP) < 0)
        {
            notifyf_printf("Failed to stop shellui");
            goto end;
        }

        // Wait for shellui to stop
        int status = 0;
        if (waitpid(shellui_pid, &status, 0) < 0)
        {
            notifyf_printf("Failed to wait for shellui");
            goto end;
        }

        // Call sceRemoteplayNotifyPinCodeError if timeout or exit requested
        if (current_ts - loop_start_ts > PAIRING_TIMEOUT_MS || exit_requested)
        {
            res = tracer_call(&tracer, sceRemoteplayNotifyPinCodeError_addr, 1, 0, 0, 0, 0, 0);
            if (res != 0)
            {
                notifyf_printf("Failed to call sceRemoteplayNotifyPinCodeError: 0x%X", res);
                goto end;
            }
            
            if (exit_requested)
            {
                notifyf_printf("Cancelled pairing");
            }
            else
            {
                notifyf_printf("Pairing timed out");
            }

            break;
        }

        res = tracer_call(&tracer, sceRemotePlayConfirmDeviceRegist_addr, status_buf_addr, errorcode_buf_addr, 0, 0, 0, 0);
        if (res != 0)
        {
            notifyf_printf("Failed to call sceRemotePlayConfirmDeviceRegist: 0x%X", res);
            goto end;
        }

        if (safe_copyout(shellui_pid, status_buf_addr, &status, sizeof(status)))
        {
            notifyf_printf("Failed to read status");
            goto end;
        }

        if (safe_copyout(shellui_pid, errorcode_buf_addr, &errorcode, sizeof(errorcode)))
        {
            notifyf_printf("Failed to read errorcode");
            goto end;
        }

        // 0x80FC1040 SCE_REMOTEPLAY_ERROR_INTERNAL_NP_ONLINE_ID_INVALID - this happens when you enter another users id (thats exists locally) or just an non existent users id
        // 0x80FC1041 SCE_REMOTEPLAY_ERROR_INTERNAL_REGIST_DEVICE_MISS
        // 0x80FC1042 SCE_REMOTEPLAY_ERROR_INTERNAL_REGIST_DEVICE_LIMITED
        // 0x80FC1043 SCE_REMOTEPLAY_ERROR_INTERNAL_REGIST_COMMAND_INVLID
        // 0x80FC1044 SCE_REMOTEPLAY_ERROR_INTERNAL_REGIST_COMMAND_DATA_INVLID
        // 0x80FC1045 SCE_REMOTEPLAY_ERROR_INTERNAL_REGIST_NETWORK_CLOSED
        // 0x80FC1046 SCE_REMOTEPLAY_ERROR_INTERNAL_REGIST_NETWORK_TIMEOUT
        // 0x80FC1047 SCE_REMOTEPLAY_ERROR_INTERNAL_REGIST_PINCODE_INVALID

        if (status == 2)
        {
            notifyf_printf("Pairing successful");
            break;
        }
        else if (status == 3)
        {
            if (errorcode == 0x80FC1047)
            {
                notifyf_printf("Pairing failed: Invalid pin code");
            }
            else if (errorcode == 0x80FC1040)
            {
                notifyf_printf("Pairing failed: Invalid account id");
            }
            else
            {
                notifyf_printf("Pairing failed: 0x%X", errorcode);
            }
            break;
        }
        else if (status == 4)
        {
            break;
        }

        // Continue shellui
        if ((int)syscall(SYS_ptrace, PT_CONTINUE, shellui_pid, (caddr_t)1, 0) < 0)
        {
            notifyf_printf("Failed to continue shellui");
            goto end;
        }

        usleep(iteration_sleep_ms * 1000);
    }

    res = 0;
end:
    if (buffers_addr != 0)
    {
        tracer_call(&tracer, free_addr, buffers_addr, 0, 0, 0, 0, 0);
    }

    tracer_finalize(&tracer);
    return res;
}
