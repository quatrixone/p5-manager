import { useEffect, useRef } from 'react';

// Polling hook that automatically pauses while the tab is hidden and
// resumes (with an immediate fire) when it becomes visible again.
//
// Why this exists: every long-lived screen in the manager — Queue,
// LogServer, FileOps, the App-level status pill, etc. — used to call
// `setInterval(fetchSomething, 1000-5000ms)` in its useEffect. With a
// few tabs open in a phone PWA or a backgrounded desktop browser, those
// timers add up to a real always-on CPU + network cost (each fetch
// allocates a Response object, parses JSON, then runs a setState that
// invalidates the React subtree even if the data didn't change).
// document.visibilityState gives us a free signal from the browser to
// gate all of that.
//
// Usage:
//
//   useVisiblePolling(fetchStatus, 2000);          // 2 s tick, paused when hidden
//   useVisiblePolling(fetchStatus, 2000, [profileId]); // restart on dep change
//
// Contract:
//   - callback fires immediately on first mount AND on every transition
//     from hidden → visible (so a returning user always sees fresh data
//     instead of stale-up-to-`interval` data)
//   - interval=0 or null disables polling entirely (initial call still
//     runs once); useful for "fetch once when this profile is selected"
//   - callback can be async; we don't await it (overlapping calls are
//     the caller's problem — almost every consumer already debounces
//     via React state batching)
//
export default function useVisiblePolling(callback, intervalMs, deps = []) {
  // Latch the latest callback so the effect itself doesn't have to
  // re-run (and tear down/recreate timers) whenever the parent
  // re-renders with a fresh closure. This matches the standard
  // useRef pattern for setInterval in React.
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    let timer = null;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      try {
        const r = cbRef.current?.();
        // Swallow rejections so a single bad request doesn't kill the
        // timer chain; consumers should report errors via their own
        // setState / notification path.
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch (_) { /* ignore */ }
    };

    const start = () => {
      if (timer || cancelled) return;
      if (!intervalMs) return;
      timer = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Fire once immediately so the UI doesn't show up-to-interval-
        // old data after the user returns to the tab.
        tick();
        start();
      } else {
        stop();
      }
    };

    // Initial fire is unconditional — first paint should never show a
    // skeleton longer than necessary even if the tab opens already
    // hidden (rare on desktop, common in mobile PWAs).
    tick();
    if (document.visibilityState === 'visible') start();

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);
}
