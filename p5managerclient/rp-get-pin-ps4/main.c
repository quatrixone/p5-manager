#include "tracer.h"

int _main(void) {
  if(rp_init("/data/.p5manager-rp-get-pin-ps4.log")) return 0;
  rp_user user;
  rp_tracer tracer={0};
  uintptr_t generate=0,confirm=0,cancel=0;
  uint64_t result=0;
  int pin_generated=0;
  if(rp_foreground_user(&user)) goto end;
  if(!user.account_id) { rp_log("Error: foreground user has no account ID; run offact first\n"); goto end; }
  rp_print_account(&user);
  int enabled=0;
  if(rp_get_int(PS4_RP_ENABLE_KEY,&enabled)) { rp_log("Error: cannot read Remote Play enable setting\n"); goto end; }
  if(!enabled) {
    rp_set_int=(void*)rp_symbol("libSceRegMgr.sprx","sceRegMgrSetInt");
    if(!rp_set_int || rp_set_int(PS4_RP_ENABLE_KEY,1)) { rp_log("Error: could not enable Remote Play\n"); goto end; }
  }
  int pid=rp_find_process("SceShellUI");
  rp_log("[rp-get-pin-ps4] SceShellUI pid=%d\n",pid);
  if(rp_trace_attach(&tracer,pid)) goto end;
  generate=rp_trace_symbol(&tracer,"sceRemoteplayGeneratePinCode");
  confirm=rp_trace_symbol(&tracer,"sceRemoteplayConfirmDeviceRegist");
  if(!confirm) confirm=rp_trace_symbol(&tracer,"sceRemotePlayConfirmDeviceRegist");
  cancel=rp_trace_symbol(&tracer,"sceRemoteplayNotifyPinCodeError");
  rp_log("[rp-get-pin-ps4] Generate=%p Confirm=%p Cancel=%p\n",(void*)generate,(void*)confirm,(void*)cancel);
  if(!generate || !confirm || !cancel) { rp_log("Error: could not resolve PS4 Remote Play functions\n"); goto end; }
  if(rp_trace_call(&tracer,cancel,1,0,0,0,0,0,&result)) goto end;
  uint32_t buffers[3]={0};
  if(rp_trace_write(&tracer,tracer.buffer,buffers,sizeof(buffers))) goto end;
  for(int attempt=0;attempt<20;attempt++) {
    if(rp_trace_call(&tracer,generate,tracer.buffer,0,0,0,0,0,&result)) goto end;
    if((uint32_t)result==0) break;
    rp_log("[rp-get-pin-ps4] GeneratePinCode rc=0x%x attempt=%d\n",(uint32_t)result,attempt+1);
    if((uint32_t)result!=0x80fc0004) { rp_log("Error: PIN generation rc=0x%x\n",(uint32_t)result); goto end; }
    if(rp_trace_resume(&tracer)) goto end;
    sceKernelUsleep(500000);
    if(rp_trace_pause(&tracer)) goto end;
  }
  if((uint32_t)result) { rp_log("Error: PIN generation rc=0x%x\n",(uint32_t)result); goto end; }
  pin_generated=1;
  if(rp_trace_read(&tracer,tracer.buffer,buffers,sizeof(buffers))) goto end;
  if(buffers[0]>99999999) { rp_log("Error: invalid PIN value\n"); goto end; }
  rp_log("Pin code: %04u %04u\nTimeout: 120 seconds\n",buffers[0]/10000,buffers[0]%10000);
  printf_notification("P5 Manager PS4 PIN: %04u %04u",buffers[0]/10000,buffers[0]%10000);
  /* Keep ShellUI running between calls while the client pairs. */
  if(rp_trace_resume(&tracer)) goto end;
  uint64_t deadline=sceKernelGetProcessTime()+120000000ULL;
  while(sceKernelGetProcessTime()<deadline) {
    sceKernelUsleep(250000);
    if(rp_trace_pause(&tracer)) goto end;
    if(rp_trace_call(&tracer,confirm,tracer.buffer+4,tracer.buffer+8,0,0,0,0,&result) ||
        rp_trace_read(&tracer,tracer.buffer+4,&buffers[1],8)) goto end;
    if((uint32_t)result) { rp_log("Error: registration confirm rc=0x%x\n",(uint32_t)result); goto end; }
    if(buffers[1]==2) {
      rp_log("Pairing: %s\nPairing error: 0x%x\n",buffers[2] ? "failed" : "success",buffers[2]);
      goto end;
    }
    if(rp_trace_resume(&tracer)) goto end;
  }
  rp_log("Pairing: timeout\n");
end:
  if(tracer.attached) {
    if(pin_generated && cancel && !rp_trace_pause(&tracer))
      rp_trace_call(&tracer,cancel,1,0,0,0,0,0,&result);
    if(rp_trace_detach(&tracer)) rp_log("Error: SceShellUI detach failed\n");
  } else if(tracer.elevated) rp_trace_detach(&tracer);
  rp_log("Done\n"); rp_close(); return 0;
}
