import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../lib/api.js';

// Declarative wrapper for a single GET endpoint. Replaces the
// "useState + useEffect + try/catch + setLoading" pattern that appeared
// in every list/detail component.
//
// Usage:
//
//   const { data: profiles, loading, error, reload } = useApi('/profiles');
//   const { data, reload } = useApi(`/payloads/${id}`, { deps: [id], skip: !id });
//
// Options:
//   • deps     — extra dependency array; refetch when any value changes.
//                The path is already a dep, so changing `path` re-fetches.
//   • skip     — if true, do nothing and keep `data` at its initial value.
//   • initial  — initial value of `data` (default: null).
//   • transform— optional `(raw) => mapped` to massage the response.
//
// The hook stays mounted across renders; `reload()` re-fetches and
// guards setState behind an `alive` ref so a fast unmount during the
// in-flight request doesn't leak a state update.
export default function useApi(path, opts = {}) {
  const { deps = [], skip = false, initial = null, transform } = opts;
  const [data, setData] = useState(initial);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!skip && !!path);
  const aliveRef = useRef(true);

  const reload = useCallback(async () => {
    if (skip || !path) return null;
    setLoading(true);
    try {
      const raw = await api.get(path);
      const out = transform ? transform(raw) : raw;
      if (aliveRef.current) {
        setData(out);
        setError(null);
      }
      return out;
    } catch (err) {
      if (aliveRef.current) setError(err);
      return null;
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, skip]);

  useEffect(() => {
    aliveRef.current = true;
    reload();
    return () => { aliveRef.current = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps]);

  return { data, error, loading, reload, setData };
}
