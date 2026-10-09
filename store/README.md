# Marketplace

What **Tools → Marketplace** in P5 Manager lists: homebrew apps, Autoload
templates and input scripts shared by users. The app reads
[`index.json`](index.json) and the item files from this folder on `main`.

## Adding something

In the app: **Tools → Marketplace → Publish** picks one of your scripts or
Autoload sequences and opens a prefilled
[submission issue](../.github/ISSUE_TEMPLATE/store-submission.yml). A
maintainer reviews it and adds the `store-accepted` label; the
[Marketplace workflow](../.github/workflows/store.yml) then opens a pull
request with the item, and it is listed once that is merged.

Homebrew is submitted the same way, with the item written by hand (below).
It is **only linked**: the files stay on their author's release page. The
workflow downloads each one once to pin its SHA-256 and size, and the app
checks every download against them.

## Items

One JSON file each, named `<id>.json`, in `templates/`, `scripts/` or
`homebrew/`. Common fields:

| Field          | |
|----------------|---|
| `kind`         | `template`, `script` or `homebrew` |
| `id`           | 3-64 lowercase letters, digits, dashes; never changes |
| `name`         | up to 80 characters |
| `description`  | up to 500 characters: what it does, what it needs |
| `author`       | up to 40 characters |
| `version`      | whole number, raised with every change (the app offers the update) |
| `console_type` | `ps4` or `ps5`; left out = both (required for homebrew) |

- **template**: `steps` (as in a saved Autoload sequence: `wait`, `wol`,
  `check_port`, `payload`, `download`, `extract`, `ftp_upload`, `convert`,
  `input_script`, `rp_session`), optional `requiresProfile`,
  `autoTrigger: "loader_down"`. Scripts go in as text (`script`), payloads
  by file name (`payloadName`).
- **script**: `script`, in the input script language (`<button> [ms] [Nx]`,
  `wait <ms>`, `text <string>`, …).
- **homebrew**: `files`, 1-5 of `{ type: "pkg" | "elf" | "bin" | "lua",
  url, sha256, size }` (`sha256`/`size` filled in on acceptance), optional
  `app_version`, `homepage`, `license`. Payloads go into the app's payload
  library; a PS5 `.pkg` into the install queue; a PS4 `.pkg` to Remote
  Package Installer on the console.

Nothing pirated, and nothing that links to it.

## Checks

    node scripts/build-store-index.mjs          # rebuild index.json
    node scripts/build-store-index.mjs --check  # what CI runs

The rules are in [`backend/src/lib/storeItem.js`](../backend/src/lib/storeItem.js),
shared by the app and the workflow.

## Platform catalogs and direct import

The Marketplace has separate PS4 and PS5 views, initially matching the active
console. Cross-platform scripts/templates may appear in either view. Payload
items use `kind: "payload"`, live in `payloads/`, and use the homebrew file
schema with ELF/BIN/LUA files only. Import downloads and checks them before
adding them to the payload library. Script import adds a saved script with its
platform tag. Template import asks for a compatible console and creates a
saved Autoload sequence immediately; it does not start it. Updating an imported
script or sequence replaces its imported definition.

## Encrypted catalog links

All URL-bearing strings in committed `frontend/builtin/*.json` and `store/`
items/index are encoded as `p5enc:v1:` using AES-256-GCM. The backend decodes
catalogs before validation/use; built-in editing, publishing and submission
acceptance encode them before writing. Nested steps, descriptions and URLs in
script text are covered too. Legacy plain catalogs remain readable.

The decoder key is distributed with this open-source application. This hides
plain links in the JSON; it does not make public download URLs secret and must
never be used for account credentials. Runtime API data and the editor remain
readable so links and scripts can be used normally.

The Marketplace check rejects plain links in item files and verifies decoded
index content. `node scripts/prepare-catalog.mjs` refreshes the existing public
PS5 payload checksums and encrypts built-ins without compiling the application.
