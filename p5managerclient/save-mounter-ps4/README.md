# save-mounter-ps4

Mounts one PS4 save **decrypted**, so P5 Manager can copy it off over FTP -
what Apollo Save Tool's "export decrypted save files" does, without anyone
touching the console. Driven from **File Ops → Saves**
(`backend/src/lib/ps4SaveExport.js`).

A PS4 save is two files in `/user/home/<user>/savedata/<title>/`:

| file | what it is |
|---|---|
| `sdimg_<name>` | the PFS image, encrypted |
| `<name>.bin` | the sealed key, 0x60 bytes |

The key is sealed with the console's own key, so only that PS4 can open the
save - no PC, no PS5, no other PS4. Unsealing is `ioctl(0xC0845302)` on
`/dev/sbl_srv`; the plain 0x20-byte key then goes to `sceFsMountSaveData`
from the VSH-private `libSceFsInternalForVsh.sprx`.

libPS4's `jailbreak()` already leaves the payload with uid 0, the sony
credential, process authority `0x3801000000000013` and no sandbox, which is
exactly what that call needs - so unlike Apollo there is no `mknod` of
`/dev/pfsctldev`, `/dev/lvdctl` and `/dev/sbl_srv` here.

The save is mounted where it lies, at `/data/p5manager-save-ps4-mount`;
P5 Manager only reads it.

## Protocol

One command line in `/data/.p5manager-save-ps4`, read when the payload is
sent to GoldHEN's BinLoader (port 9090, 9020 on older builds). The answer
goes to `/data/.p5manager-save-ps4.log`, which P5 Manager reads over FTP.

    MOUNT <user id hex> <title id> <save name>   → "Source: …", "Mount point: …"
    UMOUNT                                       → "Unmounted"

Every run ends with `Done`; anything that went wrong is one `Error: …` line.

## Build

    make        # with ~/.cache/ps4-pin/ps4-payload-sdk, or PS4SDK=<path>

`save-mounter-ps4.bin` is committed, like the other payloads here.

## Credits

Method and ioctl numbers from [hzhreal/PS4-vsh-utils](https://github.com/hzhreal/PS4-vsh-utils)
(MIT) and [bucanero/apollo-ps4](https://github.com/bucanero/apollo-ps4)
(GPL-3.0). The code here is our own.
