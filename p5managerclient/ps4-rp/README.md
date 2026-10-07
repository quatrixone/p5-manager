# PS4 Remote Play payloads (experimental)

These are PS4 ports of the two PS5 operations, built with the
Scene-Collective `ps4-payload-sdk`. PIN generation has succeeded in live testing,
but reliability and completed registration still need validation.
Both payloads ship with the application's defaults, Docker image and update
bundles. PS Control's Remote Play Settings provides account reading/activation
and Auto-fetch PIN for PS4 profiles. The existing activation and PIN API routes
select PS4 binaries from the profile's console type, read output over FTP and
persist the account ID without treating the local user name as a PSN online ID.

Live testing on PS4 firmware 11.00 with GoldHEN v2.2 and BinLoader port
9090 confirmed foreground account ID reading and detection of an already
activated account. The PIN payload resolved all three Remote Play symbols,
and generated a real eight-digit PIN after an earlier `0x80FC0101` error.
Earlier tests also restarted SceShellUI, so this remains a development payload.

* `offact-ps4.bin` reads the foreground user's account ID and reconciles
  activation using PS4's `NP_env="np"` and `login_flag=6`. If the host has
  supplied `/data/.p5manager-offact`, it uses that base64 account ID.
  Without the trigger it preserves the existing account ID; an empty
  account requires a supplied ID. It does not invent a PSN account.
* `rp-get-pin-ps4.bin` reads the foreground account, enables Remote Play,
  attaches to `SceShellUI`, resolves the loaded Remote Play functions,
  and calls `sceRemoteplayGeneratePinCode`. It polls
  `sceRemoteplayConfirmDeviceRegist` for up to 120 seconds. It does not
  ask someone to navigate Settings or type a PIN from the screen.

GoldHEN's BinLoader must be enabled, and FTP must be running. Unlike
PS5 elfldr, the PS4 binloader does not supply a stdout channel, so the
payloads write their results to `/data/.p5manager-offact-ps4.log` and
`/data/.p5manager-rp-get-pin-ps4.log`. The host script reads these over FTP.
Run one payload at a time and allow a previous PIN session to finish
before running another. The ports tried are 9020 and then 9090, or the
explicit `--loader-port`.

```sh
make -C p5managerclient/offact-ps4
make -C p5managerclient/rp-get-pin-ps4
python3 scripts/ps4-rp-test.py offact --ip 10.0.0.180
python3 scripts/ps4-rp-test.py get-pin --ip 10.0.0.180
```

The script removes an old result before sending the payload. A successful
get-pin returns both `account_id` and the real eight-digit `pin`, while the
payload stays alive to complete registration. Compilation alone does not
verify remote syscall permissions, exported symbols, or PIN generation
on a particular GoldHEN/firmware combination.

PS4 registry keys and activation values were checked against
[Apollo's offline activation source](https://github.com/bucanero/apollo-ps4/blob/main/source/offline_act.c).
The real PIN lifecycle follows
[idlesauce's PS5 implementation](https://github.com/idlesauce/ps5-remoteplay-get-pin).
