# /frontend/builtin

Single source of truth for everything the manager ships **built-in**.
These files are read by the backend at runtime and served to the UI
(see `backend/src/lib/builtinLoader.js`), so editing any file here
immediately changes what the app exposes — no rebuild trickery, no DB
migration.

## Files

| File                | What lives here                                     | Consumed by                                 |
| ------------------- | --------------------------------------------------- | ------------------------------------------- |
| `payloads.json`     | payloads auto-downloaded on startup                 | `backend/src/lib/defaultPayloads.js`        |
| `templates.json`    | Autoload sequence templates                         | `backend/src/routes/sequences.js`           |
| `inputScripts.json` | Script Runner macros                                | `frontend ScriptRunner` + backend `/api/input-scripts/builtin` |

## Editing rules

* All three are **plain JSON arrays**; the editor refuses anything else.
  JSON has no comments: what is worth saying about an entry goes into its
  optional `notes` field.
* `payloads.json`: `{ filename, url, console_type, port, tag, description,
  notes? }`. `url` may point at a `.zip` (the first `.elf`/`.lua`/`.bin`
  in it is kept); `console_type` is `ps4` or `ps5` (untagged shows
  everywhere); `port` is the sender's default (PS5 ELF 9021, Lua 9026,
  PS4 9020).
* `templates.json`: `{ id, name, description, console_type?,
  requiresProfile, autoTrigger?, notes?, steps }`, steps as in a saved
  sequence. PS5 and cross-platform templates start with `rp_session start`
  (wakes the console and holds it awake) and end with `rp_session standby`.
* `inputScripts.json` — an array of
  `{ id, name, description, script, notes? }`. `script` is a single string
  with `\n` between lines (same DSL the editor takes: `<button> [ms] [Nx]`,
  `wait <ms>`, `text <string>`, `lstick` / `rstick <x> <y> [ms]`, `home`,
  `// comment`). `notes` is optional free-text
  for anything worth documenting about the macro (button-by-button
  navigation, firmware caveats, …) — JSON has no comment syntax, so this is
  where that goes instead of an inline `//`.
* IDs must stay **stable**: changing an `id` orphans saved Autoload runs and
  breaks user references. Add new entries; don't renumber.
* Built-in input scripts cannot be deleted from the UI. Edit them in place
  (✏️, or the step editor's "Save to built-in"), or "Use as template" /
  📋 to fork into a savable copy instead.
* Built-in payloads are re-fetched on every startup if the file is missing
  from the payloads folder (`/data/payloads` in the Docker setup), so
  removing an entry here doesn't delete already downloaded files — it just
  stops auto-restoring them.
* A template may carry `autoTrigger: 'loader_down'`; a sequence saved from
  it then runs by itself when its console is on but the loader port is
  closed. An Autoload script step can name a built-in script by id
  (`scriptId: 'builtin:…'`) and gets its current text at run time.
