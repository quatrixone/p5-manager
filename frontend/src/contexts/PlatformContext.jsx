// PlatformContext — single source of truth for "is the user looking at PS4
// content, PS5 content, or both?". Read by every tab so we can hide
// platform-specific buttons (mkpfs PS5-only, GoldHEN PS4-only, etc.) and
// adapt port hints / templates / status pills.
//
// The mode is derived **entirely** from the active profile's
// `console_type` column — no UI switch, no manual override. Profiles with
// `console_type=null` (auto-detect not yet resolved by the periodic
// /status poll) fall back to `all`, so every action stays visible until
// the backend identifies the console.

import { createContext, useContext, useMemo } from 'react';

const PlatformContext = createContext({
  mode: 'all',
  activeProfileType: null,
});

export function PlatformProvider({ activeProfile, children }) {
  const activeProfileType = useMemo(() => {
    const ct = activeProfile?.console_type;
    if (ct === 'ps4' || ct === 'ps5') return ct;
    return null;
  }, [activeProfile]);

  // Effective mode: profile type, or 'all' when unknown.
  const mode = activeProfileType || 'all';

  const value = useMemo(() => ({
    mode,
    activeProfileType,
  }), [mode, activeProfileType]);

  return (
    <PlatformContext.Provider value={value}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatform() {
  return useContext(PlatformContext);
}

// Convenience predicate: does the active mode INCLUDE the given platform?
// In 'all' mode every platform is "included", so anything that should
// render in dual-platform views passes. Use this for filtering payloads,
// templates, etc.
export function platformMatches(mode, platform) {
  if (mode === 'all') return true;
  if (!platform) return true; // untagged items render everywhere
  return mode === platform;
}
