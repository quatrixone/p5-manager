# /frontend/builtin

Single source of truth for everything the manager ships **built-in**.
These files are imported by both the React frontend and the Node backend at
runtime (see `backend/src/lib/builtinLoader.js`), so editing any file here
immediately changes what the app exposes — no rebuild trickery, no DB
migration. Keep them small, readable, and dependency-free.

## Files

| File                | What lives here                                     | Consumed by                                 |
| ------------------- | --------------------------------------------------- | ------------------------------------------- |
| `payloads.js`       | `ESSENTIAL_PAYLOADS` — auto-downloaded on startup   | `backend/src/lib/defaultPayloads.js`        |
| `templates.js`      | `DEFAULT_TEMPLATES` — Autoload sequence templates   | `backend/src/routes/sequences.js`           |
| `inputScripts.json` | JSON array of Script Runner macros                  | `frontend ScriptRunner` + backend `/api/input-scripts/builtin` |

## Editing rules

* `payloads.js` / `templates.js` are **plain ESM** — `export const FOO = [ ... ]`.
  No external imports.
* `inputScripts.json` is **plain JSON** (not a JS module) — an array of
  `{ id, name, description, script, notes? }`. `script` is a single string
  with `\n` between lines (same DSL the editor takes: `<button> [ms] [Nx]`,
  `wait <ms>`, `text <string>`, `// comment`). `notes` is optional free-text
  for anything worth documenting about the macro (button-by-button
  navigation, firmware caveats, …) — JSON has no comment syntax, so this is
  where that goes instead of an inline `//`.
* IDs must stay **stable**: changing an `id` orphans saved Autoload runs and
  breaks user references. Add new entries; don't renumber.
* Built-in input scripts cannot be deleted from the UI. Edit them in place
  (✏️, or the step editor's "Save to built-in"), or "Use as template" /
  📋 to fork into a savable copy instead.
* Built-in payloads are re-fetched on every startup if the file is missing
  from `data/payloads/`, so removing an entry here doesn't delete already
  downloaded files — it just stops auto-restoring them.
