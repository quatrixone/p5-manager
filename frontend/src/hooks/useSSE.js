import { useEffect, useRef, useCallback, useState } from 'react';

export function useSSE(url, onMessage) {
  const esRef = useRef(null);
  const onMessageRef = useRef(onMessage);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!url) return;

    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        onMessageRef.current(data);
      } catch (_) {}
    };

    es.onerror = () => {
      es.close();
      setTimeout(() => {
        if (esRef.current === es) {
          esRef.current = null;
        }
      }, 3000);
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [url]);
}

export function useKeyboard(shortcuts) {
  const shortcutsRef = useRef(shortcuts);

  useEffect(() => {
    shortcutsRef.current = shortcuts;
  }, [shortcuts]);

  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
      }

      const key = e.key;
      const h = shortcutsRef.current[key];
      if (h) {
        e.preventDefault();
        h(e);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = (e) => setMatches(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

export function useLongPress(callback, delay = 500) {
  const timeout = useRef(null);
  const target = useRef(null);

  const start = useCallback((e) => {
    target.current = e.target;
    timeout.current = setTimeout(() => callback(e), delay);
  }, [callback, delay]);

  const cancel = useCallback(() => {
    if (timeout.current) {
      clearTimeout(timeout.current);
      timeout.current = null;
    }
  }, []);

  return {
    onMouseDown: start,
    onMouseUp: cancel,
    onMouseLeave: cancel,
    onTouchStart: start,
    onTouchEnd: cancel,
  };
}