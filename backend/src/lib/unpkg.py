#!/usr/bin/env python3
# PS4 NPDRM PKG unpacker, Python 3 port of flatz's original public-domain
# unpkg.py (rev 0x00000008, 2017). Ported to py3 by CelesteBlue and lightly
# trimmed / hardened here so it ships as a single hermetic file with the
# manager — no third-party imports, no network at runtime, no pip install.
#
# What it does:
#   * Parses the PKG header + file table
#   * Lists all entries (id, type, name, size, offset)
#   * Extracts every "unprotected" entry (filenames, param.sfo, icon0.png,
#     pic1.png, trophy meta, ...). The encrypted PFS payload is NOT
#     decrypted: that requires the per-PKG passcode + Sony keys which we
#     do not ship. Users get the metadata + plaintext companion files,
#     which is what 95% of PS4 PKG inspection workflows actually want.
#
# Usage:
#   unpkg.py <pkg_file> <output_dir>
#   unpkg.py --info <pkg_file>
#
# The /app/.venv-pkg/bin/unpkg wrapper invokes the first form.

import os
import struct
import sys


PKG_MAGIC = b'\x7FCNT'
PKG_TYPE_RETAIL_MASK = 0x80000000

# Entry-table flags. Values copied verbatim from flatz's reference.
FILE_TABLE_NAMES_ID = 0x200
FILE_TABLE_KEYMAP_ID = 0x401  # dummy keymap appears at this id
ENTRY_TYPE_NAME_TABLE = 0x200
ENTRY_TYPE_DIGEST_TABLE = 0x100
ENTRY_TYPE_SIG_TABLE = 0x101
ENTRY_TYPE_NAMES_KEY_TABLE_DIGEST = 0x102


def read_struct(f, fmt):
    sz = struct.calcsize(fmt)
    data = f.read(sz)
    if len(data) != sz:
        raise EOFError(f'short read: wanted {sz}, got {len(data)}')
    return struct.unpack(fmt, data)


class FileEntry:
    __slots__ = ('id', 'filename_offset', 'flags1', 'flags2', 'offset', 'size', 'pad', 'name')

    def __init__(self, raw):
        (self.id, self.filename_offset, self.flags1, self.flags2,
         self.offset, self.size, self.pad) = struct.unpack('>IIIIIIQ', raw)
        self.name = None

    @property
    def is_encrypted(self):
        # bit 0x80000000 of flags1 marks an encrypted entry (the PFS image
        # itself, plus encrypted variants of icon / pic1 in some PKGs).
        return (self.flags1 & 0x80000000) != 0


# Well-known entry IDs (subset). Anything not in this table gets dumped
# as "entry_<id>.bin" so the user still ends up with every readable
# blob even on weird custom PKGs.
KNOWN_ENTRY_NAMES = {
    0x0001: 'digests.bin',
    0x0010: 'entry_keys.bin',
    0x0020: 'image_key.bin',
    0x0080: 'general_digests.bin',
    0x0100: 'metadata.bin',
    0x0200: 'entry_names.bin',
    0x0400: 'license.dat',
    0x0401: 'license.info',
    0x0402: 'nptitle.dat',
    0x0403: 'npbind.dat',
    0x0404: 'selfinfo.dat',
    0x0406: 'imageinfo.dat',
    0x0407: 'target-deltainfo.dat',
    0x0408: 'origin-deltainfo.dat',
    0x0409: 'psreserved.dat',
    0x1000: 'param.sfo',
    0x1001: 'playgo-chunk.dat',
    0x1002: 'playgo-chunk.sha',
    0x1003: 'playgo-manifest.xml',
    0x1004: 'pronunciation.xml',
    0x1005: 'pronunciation.sig',
    0x1006: 'pic1.png',
    0x1007: 'pubtoolinfo.dat',
    0x1008: 'app/playgo-chunk.dat',
    0x1009: 'app/playgo-chunk.sha',
    0x100A: 'app/playgo-manifest.xml',
    0x100B: 'shareparam.json',
    0x100C: 'shareoverlayimage.png',
    0x100D: 'save_data.png',
    0x100E: 'shareprivacyguardimage.png',
    0x1200: 'icon0.png',
    0x1201: 'icon0_00.png',
    0x1220: 'pic0.png',
    0x1240: 'snd0.at9',
    0x1260: 'changeinfo/changeinfo.xml',
    0x1261: 'changeinfo/icon0.png',
    0x1280: 'icon0.dds',
    0x12A0: 'pic0.dds',
    0x12C0: 'pic1.dds',
}


def parse_pkg(pkg_path):
    """Return (header_dict, entries[]) — entries have .name populated when known."""
    if not os.path.isfile(pkg_path):
        raise FileNotFoundError(pkg_path)

    with open(pkg_path, 'rb') as f:
        magic = f.read(4)
        if magic != PKG_MAGIC:
            raise ValueError(f'not a PS4 PKG (magic={magic!r})')

        pkg_type, _, num_entries = read_struct(f, '>III')
        is_retail = (pkg_type & PKG_TYPE_RETAIL_MASK) != 0
        # num_entries is at offset 0x10
        f.seek(0x14)
        (num_system_entries,) = read_struct(f, '>H')
        f.seek(0x18)
        (file_table_offset,) = read_struct(f, '>I')
        f.seek(0x1C)
        (main_entries_data_size,) = read_struct(f, '>I')
        f.seek(0x40)
        (pkg_size,) = read_struct(f, '>Q')

        # Walk the file table.
        f.seek(file_table_offset)
        entries = []
        for _ in range(num_entries):
            raw = f.read(0x20)
            if len(raw) != 0x20:
                break
            e = FileEntry(raw)
            entries.append(e)

        # Try to resolve names: the entry with id == FILE_TABLE_NAMES_ID
        # holds NUL-terminated cstring table referenced by filename_offset.
        names_blob = None
        for e in entries:
            if e.id == FILE_TABLE_NAMES_ID:
                f.seek(e.offset)
                names_blob = f.read(e.size)
                break

        for e in entries:
            if names_blob is not None and e.filename_offset and e.filename_offset < len(names_blob):
                end = names_blob.find(b'\x00', e.filename_offset)
                if end < 0:
                    end = len(names_blob)
                try:
                    e.name = names_blob[e.filename_offset:end].decode('utf-8', errors='replace')
                except Exception:
                    e.name = None
            if not e.name:
                e.name = KNOWN_ENTRY_NAMES.get(e.id, f'entry_{e.id:04X}.bin')

    return {
        'pkg_type': pkg_type,
        'is_retail': is_retail,
        'num_entries': num_entries,
        'num_system_entries': num_system_entries,
        'file_table_offset': file_table_offset,
        'pkg_size': pkg_size,
    }, entries


def cmd_info(pkg_path):
    header, entries = parse_pkg(pkg_path)
    print(f'PKG: {pkg_path}')
    print(f'  type:           0x{header["pkg_type"]:08x} ({"retail" if header["is_retail"] else "non-retail"})')
    print(f'  num_entries:    {header["num_entries"]}')
    print(f'  num_system:     {header["num_system_entries"]}')
    print(f'  pkg_size:       {header["pkg_size"]} bytes')
    print(f'  file_table_off: 0x{header["file_table_offset"]:08x}')
    print()
    print(f'  {"id":>6}  {"flags1":>10}  {"flags2":>10}  {"offset":>10}  {"size":>12}  {"enc":>3}  name')
    for e in entries:
        enc = 'yes' if e.is_encrypted else 'no'
        print(f'  0x{e.id:04X}  0x{e.flags1:08x}  0x{e.flags2:08x}  0x{e.offset:08x}  {e.size:>12}  {enc:>3}  {e.name}')


def cmd_unpack(pkg_path, out_dir):
    header, entries = parse_pkg(pkg_path)
    os.makedirs(out_dir, exist_ok=True)
    extracted = 0
    skipped_encrypted = 0
    total = len(entries)

    with open(pkg_path, 'rb') as f:
        for idx, e in enumerate(entries, 1):
            name = e.name or f'entry_{e.id:04X}.bin'
            # Strip any leading slashes, refuse path traversal.
            safe_name = name.lstrip('/').replace('..', '__')
            dst = os.path.join(out_dir, safe_name)
            os.makedirs(os.path.dirname(dst), exist_ok=True)

            if e.is_encrypted:
                skipped_encrypted += 1
                print(f'  [{idx}/{total}] skip (encrypted)  0x{e.id:04X}  {name}')
                continue
            if e.size == 0:
                print(f'  [{idx}/{total}] skip (empty)      0x{e.id:04X}  {name}')
                continue

            try:
                f.seek(e.offset)
                remaining = e.size
                with open(dst, 'wb') as out:
                    while remaining > 0:
                        chunk = f.read(min(8 * 1024 * 1024, remaining))
                        if not chunk:
                            break
                        out.write(chunk)
                        remaining -= len(chunk)
                extracted += 1
                pct = (idx * 100) // total
                print(f'  [{idx}/{total}] ok ({pct}%)   0x{e.id:04X}  {name}  ({e.size} bytes)')
            except Exception as ex:
                print(f'  [{idx}/{total}] FAIL              0x{e.id:04X}  {name}: {ex}', file=sys.stderr)

    print()
    print(f'Extracted {extracted}/{total} entries → {out_dir}')
    if skipped_encrypted:
        print(f'  ({skipped_encrypted} encrypted entries skipped — PFS payload needs the per-PKG passcode + Sony keys)')


def main(argv):
    if len(argv) < 2:
        print(__doc__ or '', file=sys.stderr)
        print('Usage: unpkg.py <pkg> <out_dir>', file=sys.stderr)
        print('       unpkg.py --info <pkg>', file=sys.stderr)
        return 2

    if argv[1] in ('-V', '--version'):
        print('unpkg.py (p5-manager vendored port of flatz unpkg)')
        return 0

    if argv[1] in ('-i', '--info'):
        if len(argv) < 3:
            print('--info needs a PKG path', file=sys.stderr)
            return 2
        try:
            cmd_info(argv[2])
            return 0
        except Exception as e:
            print(f'error: {e}', file=sys.stderr)
            return 1

    if len(argv) < 3:
        print('Usage: unpkg.py <pkg> <out_dir>', file=sys.stderr)
        return 2

    pkg_path = argv[1]
    out_dir = argv[2]
    try:
        cmd_unpack(pkg_path, out_dir)
        return 0
    except Exception as e:
        print(f'error: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
