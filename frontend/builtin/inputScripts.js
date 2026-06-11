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
      '// Tap PS to open Control Center',
      'ps',
      'wait 900',
      '// First card on the bottom row is the running game switcher',
      'down',
      'wait 200',
      'options',
      'wait 700',
      '// "Close Game" is the second item on most firmwares',
      'down',
      'wait 200',
      'cross',
      'wait 900',
      '// Confirm "OK"',
      'cross',
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
      '// ── PRE-CONDITION ────────────────────────────────────────────',
      '// Run while the PS5 is on the Home screen (focus may be on any',
      '// tile / row). If you are inside a game or Control Center, press',
      '// PS by hand first to land on Home.',
      '',
      '// ── 1. Anchor focus in the games row ─────────────────────',
      '// UP 4x guarantees we hit the top tab bar from anywhere on Home;',
      '// DOWN drops back into the games row at the last-focused tile.',
      'up 4x',
      'wait 250',
      'down',
      'wait 250',
      '',
      '// ── 2. Walk right to the Game Library tile ───────────────',
      '// Always the last entry in the games row. 30 RIGHTs is more than',
      '// any plausible pinned-games row; extras no-op at the wall.',
      'right 30x',
      '// Library auto-expands an inline preview after focus lands.',
      'wait 1500',
      '',
      '// ── 3. Enter the Game Library grid ────────────────────────',
      '// DOWN drops focus into the alphabetised grid at row 0, col 0.',
      'down',
      'wait 800',
      '',
      '// ── 4. Go up to the Library top-bar and reach Search ─────',
      '// From inside the grid, UP returns focus to the top bar (Filter /',
      '// Sort / Search icons). On the firmware tested, the search 🔍',
      '// icon sits at the FAR RIGHT of the top bar. 20 RIGHTs is far more',
      '// than any plausible layout — extras no-op at the wall.',
      '// If your firmware places search on the LEFT instead, swap the',
      '// next two lines for `left 20x` + `wait 250`.',
      'up',
      'wait 350',
      'right 20x',
      'wait 350',
      '',
      '// ── 5. Open the search panel + on-screen keyboard ────────',
      'cross',
      '// Search panel slides in: input field on top, OSK at bottom.',
      '// 1.5 s gives the panel time to fully render before any key input',
      '// (a fresh OSK swallows the first few presses).',
      'wait 1500',
      '',
      '// ── 6. Anchor on the OSK key \'q\' ──────────────────────────',
      '// PS5 Library OSK is taller than the classic three-row layout',
      '// (numbers + qwerty + asdf + zxcv + modes/space). 6 UPs guarantee',
      '// we hit the top of the OSK regardless of where initial focus',
      '// landed; if any of them overshoot into the input field, the',
      '// subsequent DOWNs walk us back down into the letter rows.',
      '// After this block: cursor at row 0, col 0 = q.',
      'up 6x',
      'wait 200',
      'left 10x',
      'wait 200',
      'down 2x',
      'wait 200',
      '',
      '// ── 7. Type "racer" via manual OSK navigation ────────────',
      '// Coordinates are (row, col) starting from (0,0) = q.',
      '//   r = (0, 3)   a = (1, 0)   c = (2, 2)   e = (0, 2)   r = (0, 3)',
      '',
      '// r: right 3 from q',
      'right 3x',
      'wait 150',
      'cross',
      'wait 250',
      '',
      '// a: down 1, left 3',
      'down',
      'wait 100',
      'left 3x',
      'wait 100',
      'cross',
      'wait 250',
      '',
      '// c: down 1, right 2',
      'down',
      'wait 100',
      'right 2x',
      'wait 100',
      'cross',
      'wait 250',
      '',
      '// e: up 2 (column stays at 2)',
      'up 2x',
      'wait 100',
      'cross',
      'wait 250',
      '',
      '// r: right 1',
      'right',
      'wait 100',
      'cross',
      'wait 400',
      '',
      '// ── 8. Close the OSK / apply the filter ──────────────────',
      '// On the PS5 Library search panel, OPTIONS hides the OSK and',
      '// leaves the filtered result grid visible behind it. If your',
      '// firmware uses a different "Done" gesture, swap this for one of:',
      '//   `touchpad`  — many PS5 OSK builds map this to Confirm',
      '//   `r2`        — also commonly bound to Done',
      'options',
      'wait 1200',
      '',
      '// ── 9. Drop into the filtered grid ───────────────────────',
      '// DOWN moves focus from the search input down to the first',
      '// (and typically only) matching tile.',
      'down',
      'wait 800',
      '',
      '// ── 10. Open the game tile ───────────────────────────────',
      'cross',
      'wait 1500',
      '',
      '// ── 11. Confirm Play ─────────────────────────────────────',
      '// On an installed game tile, the default highlight is "Play".',
      'cross',
    ].join('\n'),
  },
];
