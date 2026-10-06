import { useEffect, useMemo, useRef, useState } from 'react';

// Searchable single-select: a filter input above a scrollable option list.
// Picking an option only marks it (onChange) - the caller decides what the
// action button next to it does, so a stray click never triggers anything.
//   items: [{ key, label, badge? }]
export default function SearchSelect({ items, value, onChange, placeholder = 'Search…', emptyText = 'Nothing found', autoFocus = false }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(it => it.label.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter' && filtered[cursor]) { e.preventDefault(); onChange(filtered[cursor].key); }
  };

  return (
    <div className="search-select">
      <input
        className="input"
        type="search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label={placeholder}
      />
      <div className="search-select-list" role="listbox" ref={listRef}>
        {filtered.length === 0 ? (
          <div className="text-sm text-muted search-select-empty">{emptyText}</div>
        ) : filtered.map((it, i) => (
          <button
            type="button"
            key={it.key}
            role="option"
            aria-selected={it.key === value}
            data-cursor={i === cursor}
            className={`search-select-option ${it.key === value ? 'selected' : ''} ${i === cursor ? 'cursor' : ''}`}
            onClick={() => { setCursor(i); onChange(it.key); }}
            title={it.label}
          >
            <span className="truncate">{it.label}</span>
            {it.badge && <span className="console-type-badge">{it.badge}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
