# /frontend/builtin

Single source of truth for everything the manager ships **built-in**.
These files are imported by both the React frontend and the Node backend at
runtime (see `backend/src/lib/builtinLoader.js`), so editing any file here
immediately changes what the app exposes — no rebuild trickery, no DB
migration. Keep them small, readable, and dependency-free.

## Files

| File              | What lives here                                     | Consumed by                                 |
| ----------------- | --------------------------------------------------- | ------------------------------------------- |
| `payloads.js`     | `ESSENTIAL_PAYLOADS` — auto-downloaded on startup   | `backend/src/lib/defaultPayloads.js`        |
| `templates.js`    | `DEFAULT_TEMPLATES` — Autoload sequence templates   | `backend/src/routes/sequences.js`           |
| `inputScripts.js` | `BUILTIN_INPUT_SCRIPTS` — Script Runner macros      | `frontend ScriptRunner` + backend `/api/input-scripts/builtin` |

## Editing rules

* **Plain ESM** — `export const FOO = [ ... ]`. No external imports.
* IDs must stay **stable**: changing an `id` orphans saved Autoload runs and
  breaks user references. Add new entries; don't renumber.
* Built-in input scripts cannot be deleted from the UI. Edit the file
  instead, or "Use as template" to fork into a savable copy.
* Built-in payloads are re-fetched on every startup if the file is missing
  from `data/payloads/`, so removing an entry here doesn't delete already
  downloaded files — it just stops auto-restoring them.
