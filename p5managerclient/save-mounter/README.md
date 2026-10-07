# save-mounter

Mounts PS5 save data - the console's own, and PS4 saves of backwards-
compatible games - read/write under `/mnt/pfs/`, and creates new saves. A
TCP command server on port 9090; P5 Manager drives it from
**Tools → Save Mounter** (`backend/src/lib/saveMounter.js`).

`main.c` is the payload of
[n0llptr/Playstation-5-Save-Mounter](https://github.com/n0llptr/Playstation-5-Save-Mounter)
v2.0.1 (commit `1a0281e`), unchanged. It is under the **GNU General Public
License version 3** (see [LICENSE](LICENSE)). Credits from upstream: cow
(save mounting through the internal `sceFs*` functions) and earthonion
(title listing and save creation, from garlic-savemgr).

## Build

    make            # with p5managerclient/sdk, or PS5_PAYLOAD_SDK=<sdk>

`save-mounter.elf` is committed, like the other payloads here.

## Protocol

One command a line; the answer is `OK [value]` or `ERR <reason>`.

    GET_FW                      OK <major>.<minor>
    GET_USERS                   OK <n>, then n lines "<id hex> <name>"
    LIST_SAVES <uid>            OK <n>, then n title ids
    SEARCH <uid> <title>        OK <n>, then n lines dir\ttitle\tsubtitle\tdetail\tmtime
    MOUNT <uid> <title> <dir>   OK <mount point>
    UMOUNT                      OK (writes the save back)
    CREATE <uid> <title> <dir> <blocks of 32 KiB>   OK <mount point> (left mounted)
    READ_FILE <path>            OK <size>, then the bytes
    EXIT                        ends the payload
