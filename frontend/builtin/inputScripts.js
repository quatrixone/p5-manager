// Built-in Script Runner macros.
//
// These appear at the top of the Script Runner panel as a separate
// "Built-in" section. They cannot be deleted from the UI — to change
// them, edit this file. Hit "Use as template" in the UI to fork one
// into a regular saved script.
//
// Format (must match what the user types in the editor):
//   id:          stable string (kept across reloads, prefixed `builtin:`)
//   name:        display name
//   description: shown under the name; one-liner
//   script:      the actual script body. Same DSL as the editor:
//                  <button> [duration_ms] [Nx]
//                  wait <ms>
//                  text <string>
//                  // comment
//
// Holding the PS button for ~1500 ms opens the PS5 Power overlay, where
// the default highlighted option is "Enter Rest Mode". From there:
//   * one  `down`  + `cross`  → Restart PS5
//   * just `cross`            → Enter Rest Mode
//   * two  `down`  + `cross`  → Turn Off PS5
// Tweak the timings if your console reacts faster or slower.

export const BUILTIN_INPUT_SCRIPTS = [
    {
    id: 'builtin:close-game',
    name: 'Close current game',
    description: 'Open Control Center, navigate to the running game card and pick Close Game.',
    script: [
      "ps",
      "wait 400",
      "down",
      "wait 400",
      "right",
      "wait 400",
      "cross",
      "wait 400",
      "cross",
      "wait 400",
      "down",
      "wait 400",
      "down",
      "wait 400",
      "cross",
      "wait 2500",
      "ps",
      "wait 400",
      "down",
      "wait 400",
      "left",
      "wait 400",
      "cross",
    ].join('\n'),
  },
  {
    // Open a specific installed game from the PS5 Game Library by walking
    // to the right-most "Game Library" tile on Home (always the last item
    // in the games row, regardless of how many recent games are pinned),
    // opening the Library's built-in search and typing enough of the name
    // to filter the grid down to a single result.
    //
    // Why search over position-based navigation? Position shifts every
    // time a game is installed/uninstalled (the grid is alphabetised).
    // Search is layout-stable: as long as the title contains the chosen
    // query string the script keeps working.
    //
    // Why "racer" (5 chars)? Short enough that the manual OSK walk stays
    // within ~25 keystrokes (no timing drift), distinct enough that the
    // Library grid filters down to a single game on a typical homebrew
    // PS5. If your library has multiple titles containing "racer", lengthen
    // the query to "racer revenge" or change to another unique substring.
    //
    // PS5 Library OSK layout (3 letter rows used here):
    //     row 0:  q w e r t y u i o p
    //     row 1:  a s d f g h j k l
    //     row 2:  z x c v b n m
    // Numbers / modes / space sit ABOVE row 0 and BELOW row 2 on real
    // hardware; we never go there for an all-lowercase query so they
    // don't need to be modelled. After the anchor sequence focus is at
    // (row 0, col 0) = 'q'; each subsequent block walks the delta then
    // commits with `cross`.
    //
    // Run with the Remote Play video preview open so you can watch each
    // step land where you expect.
    id: 'builtin:open-game-sw-revenge',
    name: 'Open game: Star Wars Racer Revenge',
    description: 'Home → Game Library → Search "racer" → Play. Layout-stable: keeps working as you install/uninstall games. Watch live via Remote Play preview.',
    script: [
      "# --- recorded 23. 6. 2026 15:45:40 ---",
      "ps",
      "wait 1581",
      "down",
      "wait 1045",
      "cross",
      "wait 3045",
      "up",
      "wait 922",
      "cross",
      "wait 1097",
      "right",
      "wait 421",
      "right",
      "wait 247",
      "right",
      "wait 440",
      "right",
      "wait 469",
      "right",
      "wait 378",
      "right",
      "wait 375",
      "right",
      "wait 378",
      "right",
      "wait 416",
      "right",
      "wait 388",
      "right",
      "wait 418",
      "right",
      "wait 938",
      "cross",
      "wait 1887",
      "left",
      "wait 1283",
      "down",
      "wait 603",
      "up",
      "wait 1322",
      "cross",
      "wait 2593",
      "up",
      "wait 806",
      "left",
      "wait 404",
      "cross",
      "wait 1856",
      "left",
      "wait 555",
      "cross",
      "wait 807",
      "down",
      "wait 344",
      "down",
      "wait 554",
      "right",
      "wait 581",
      "cross",
      "wait 739",
      "up",
      "wait 363",
      "up",
      "wait 889",
      "left",
      "wait 480",
      "cross",
      "wait 654",
      "down",
      "wait 352",
      "down",
      "wait 637",
      "right",
      "wait 301",
      "right",
      "wait 246",
      "right",
      "wait 487",
      "cross",
      "wait 755",
      "up",
      "wait 765",
      "left",
      "wait 453",
      "cross",
      "wait 733",
      "up",
      "wait 639",
      "left",
      "wait 365",
      "left",
      "wait 335",
      "cross",
      "wait 1617",
      "R2",
      "wait 1158",
      "down",
      "wait 1031",
      "cross",
      "wait 1353",
      "cross",
      "wait 12252",
      "cross",
      "wait 1023",
      "cross",
      "wait 828",
      "cross",
      "wait 1623",
      "cross",
      "wait 4503",
      "touchpad 500",
      "wait 707",
      "touchpad@1500,471 500",
      "wait 1297",
      "down",
      "wait 464",
      "down",
      "wait 424",
      "down",
      "wait 1109",
      "cross",
      "wait 7788",
      "down",
      "wait 412",
      "down",
      "wait 407",
      "down",
      "wait 1663",
      "cross",
    ].join('\n'),
  },
];
