// One list out of every catalog we can read. Each group is one origin -
// the curated store, the FPKGi hub, a source the user added - already
// parsed into the shared item shape; what is left is to filter, order and
// page them together, and to carry the failures as warnings so one dead
// source never empties the screen.

const MAX_LIMIT = 100;

// Curated items are the ones we can verify and update, so they lead; the
// rest follows alphabetically, with the id breaking ties so pages are stable.
function order(a, b) {
  const curated = (i) => (i.origin === 'marketplace' ? 0 : 1);
  return curated(a) - curated(b) || a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id));
}

export function browse(groups, { platform = 'ps5', source = 'all', kind = 'all', category = 'all', query = '', updatesOnly = false, page = 1, limit = 48 } = {}) {
  const q = String(query || '').trim().toLowerCase().slice(0, 200);
  limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(limit)) || 48));
  const warnings = [];
  let items = [];
  for (const group of groups) {
    if (group.warning) warnings.push(group.warning);
    if (source !== 'all' && group.origin !== source) continue;
    items = items.concat(group.items || []);
  }
  items = items
    .filter((i) => !i.console_type || i.console_type === platform)
    .filter((i) => kind === 'all' || i.kind === kind)
    .filter((i) => category === 'all' || i.category === category)
    .filter((i) => !updatesOnly || i.update)
    .filter((i) => !q || `${i.name} ${i.description || ''} ${i.author || ''} ${i.title_id || ''}`.toLowerCase().includes(q))
    .sort(order);
  const pages = Math.max(1, Math.ceil(items.length / limit));
  page = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  return { items: items.slice((page - 1) * limit, page * limit), total: items.length, page, pages, limit, warnings };
}
