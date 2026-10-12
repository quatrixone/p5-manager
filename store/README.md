# Marketplace

What **Marketplace** in P5 Manager lists: homebrew apps, Autoload
templates and input scripts shared by users. The app reads
[`index.json`](index.json) and the item files from this folder on `main`.

## Adding something

In the app: **Marketplace → Publish** picks one of your scripts or
Autoload sequences and opens a prefilled
[submission issue](../.github/ISSUE_TEMPLATE/store-submission.yml). A
maintainer reviews it and adds the `store-accepted` label; the
[Marketplace workflow](../.github/workflows/store.yml) then opens a pull
request with the item, and it is listed once that is merged.

Homebrew and payloads can also be submitted from Publish, using the item JSON
editor (schema below).
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


## Icons, updates and runtime scripts

Marketplace cards and details show app icons. The backend reads the public
Homebrew Store SQLite catalog (`https://api.pkg-zone.com/store.db`) and uses
`homebrews.main_icon_path`, matching by `homebrew_id` (a title id) or an exact,
unambiguous app name. An optional HTTPS `icon` field takes precedence. This
imports icon metadata only; downloads retain Marketplace SHA-256 checks.
Items absent from Homebrew Store, missing images and failed image loads use
category icons. Homebrew Store may block automated requests; a failed refresh
keeps cached metadata and displays a source warning.

`P5M_HOMEBREW_CATALOG_URL` can point to a compatible SQLite catalog mirror.
Icon metadata caches for one hour, and **Check updates** refreshes it explicitly.
The **Updates** filter shows imported items whose catalog `version` exceeds
its recorded installation version. **Update** uses the same verified install
path and replaces an imported script or template rather than duplicating it.
Replacing imported scripts/templates asks before overwriting their edits.
The submission workflow increments integer `version` when accepting an update.
Maintainers editing curated items directly must increment it themselves.

Curated scripts and templates have stable `builtin_id` fields. Their canonical
sources are ordinary Marketplace items in `scripts/` and `templates/`;
`node scripts/build-store-index.mjs` also generates two runtime manifests in
`builtin/`. CI checks both manifests against the item sources. Scripts and
templates no longer ship in frontend, Docker or Windows application packages.

The runtime fetches manifests from `P5M_STORE_URL` (default: this repository's
`main` branch), refreshes after ten minutes, and keeps the last validated
copy in `DATA_DIR/marketplace`. A first run needs network access. Later
network failures use the persisted copy. **Check updates** and the Script
Runner's **Marketplace** refresh report failures rather than claim success.
Edited curated fields persist in separate overrides, survive catalog refresh
and restarts, and retain the editor's previous-version backup. Unedited fields
continue to receive upstream changes. Existing Autoload `builtin:*` references
resolve to these current scripts. Installed templates do not appear twice in
the template gallery.

To test this PR before merge, set `P5M_STORE_URL` to
`https://raw.githubusercontent.com/quatrixone/p5-manager/claude/chiaki-streaming-backend-lbjgqk/store/`.
After merge the default main catalog contains the new manifests.


## Publishing and author updates without OAuth

No OAuth application, client id, client secret or access token is required.
In **Publish**, enter your GitHub username, pick a local script/sequence or
provide homebrew/payload JSON, then click **Publish on GitHub**. This opens a
prefilled issue. Sign in on GitHub and submit it using your own account.
The username is remembered locally as a convenience; it is not an authenticated
session or proof of identity.

Choose **Update my item** and select your existing listing. Items are filtered
by the entered author name. **Show all items** helps locate a listing after
renaming your GitHub account. Select the updated local script/sequence or edit
the package JSON. Drafts retain the item id and suggest the next version.
They cannot modify the live catalog or installed copies.

A maintainer reviews the issue and adds `store-accepted`. The workflow reads
`github.event.issue.user.id` and `.login`, ignoring the draft's author, owner
id and requested version. New accepted submissions store `github_owner_id`;
only that same account id may update an existing item, including after login
renames. Legacy items without an owner id match their author login until their
first accepted update pins the account id. Maintainer-curated entries remain
maintainer-managed. An issue submitted by another account cannot update your
listing, even if its JSON claims your username or id.

The accepted update advances the version from the current repository item.
After its PR is merged, **Check updates** offers it to users with older copies.
Both new items and updates require review. Homebrew checksums and sizes are
verified during acceptance. Setting a GitHub username in the app never grants
permission to publish directly.

## PS4 homebrew metadata

The backend also reads the PS4 homebrew catalog at
https://github.com/Dinos17/FPKGi-Catalog-Hub/blob/main/ps4/homebrew.json.
`P5M_PS4_HOMEBREW_URL` can override this compatible JSON metadata source.
Title ids and names supply covers for PS4 entries, with one-hour caching and
an explicit refresh through **Check updates**. Ambiguous duplicate title ids
require a matching name; PS4 metadata does not match PS5-only entries.
Unavailable metadata keeps cached covers and reports a warning.

This supplemental source does not automatically import its package URLs.
The reviewed Marketplace now includes PS4 Cheats Manager, PS4 WebDAV Client
and Apollo Save Tool for PS4, linked to their authors' GitHub releases with
verified SHA-256 and size. PS4 PKG installation uses Remote Package Installer.


## Full external catalog browser

**Marketplace → FPKGi Catalog Hub** loads all catalog files from
Dinos17/FPKGi-Catalog-Hub for PS4 and PS5, with eleven categories: Games,
Applications, Game updates, DLC, Demos, Homebrew, Emulators, Themes, PS1, PS2,
and PSP. PS5's PS1/PS2 views use the shared PS4-format catalogs. PS5 PSP reads
`ps5/psp.json`. Empty source categories remain available and show an empty-state
message. Native PS4 entries are not silently relabeled as native PS5 games.

The browser preserves package variants, shows title id, source version,
region, size, minimum firmware and covers, and searches/paginates on the
server (48 items per page). It loads source files directly, with a 15-minute
cache in `DATA_DIR/marketplace/fpkgi`, coalesced requests, a 32 MiB file bound,
and persistent offline fallback. `P5M_FPKGI_CATALOG_URL` may override the
compatible repository-root URL. A refresh failure reports stale data.

External listings are separate from reviewed, SHA-256-pinned Marketplace
items and do not create installations or imported versions. They expose HTTPS
package links; the current source does not supply SHA-256. Source category
`updates` means game/application patches, distinct from the Marketplace's
installed-item update filter. Source metadata is displayed as supplied, even
when source names or versions appear incorrect.

The reader is independently written. The source's merger/code is not copied;
no external catalog snapshot or package binaries are committed. The UI credits
Dinos17 and links to the catalog source and its CATALOG-LICENSE.md. Runtime
caches are local to the user's installation. Catalog terms and package rights
are separate; the catalog license does not license referenced packages.

## New and automatic activity checks

**New** is the default Marketplace section. It shows newly discovered and
changed listings from both reviewed Marketplace items and the external PS4/PS5
catalogs. Entries show source, platform, version and local detection time;
filters separate new and updated items, with search and pagination. Clicking
an activity opens its Marketplace detail or matching external catalog.

On the first check, existing entries are marked newly discovered. Activity dates
are local observations, not source release dates. An unchanged item retains
its activity date; changes advance it. Successfully removed entries disappear.
A failed source retains its last activity and reports a warning.

After the first New request, the backend checks Marketplace and all source
catalogs every 15 minutes while it runs, even with the browser closed. At most
four external catalog requests run concurrently. Curated runtime manifests also
refresh through the existing override-preserving path. New snapshots persist
in `DATA_DIR/marketplace/news.json`, retaining detected activity after restart.
The open UI reloads New and checks installed-item update badges every 15
minutes. It offers updates; it does not install or run them automatically.
