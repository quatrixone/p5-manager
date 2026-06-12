// Tiny fetch wrapper used throughout the UI. Replaces the
// `fetch(url, {method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(...)})`
// + manual `res.ok` + `res.json()` boilerplate that was repeated dozens of
// times across every component.
//
// Conventions:
//   • Paths starting with `/api/...` or `http(s)://...` are used verbatim.
//   • Anything else gets the `/api` prefix prepended ("settings" → "/api/settings").
//   • Bodies are JSON-encoded automatically; pass `undefined`/`null` for none.
//   • Non-2xx responses throw an Error with `.status` and `.data` attached so
//     callers can branch on `err.status` without re-parsing the response.
//   • `apiSafe.*` is the same surface but swallows failures and returns `null`,
//     for "fire-and-forget" or "best-effort" fetches.

const API_BASE = '/api';

function resolveUrl(path) {
  if (!path) return API_BASE;
  // Absolute URLs pass through untouched (used by a couple of components
  // that fetch raw GitHub content for setlogserver.lua etc).
  if (/^https?:/i.test(path)) return path;
  // Already namespaced under /api — use as-is so callers can opt out of
  // the auto-prefix when needed (e.g. /api/v2 once we add versioning).
  if (path.startsWith('/api/') || path === '/api') return path;
  // "/profiles" → "/api/profiles". This is the path 99% of callers use,
  // and the previous implementation was returning `path` unchanged here
  // which made every request fall through to the SPA fallback and
  // silently swallow real responses as HTML — symptom: empty profile
  // list, empty payload list, broken scan, etc. until a hard refresh.
  if (path.startsWith('/')) return `${API_BASE}${path}`;
  // "profiles" → "/api/profiles" (bare path, no leading slash).
  return `${API_BASE}/${path}`;
}

async function parseResponse(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { return await res.json(); } catch (_) { return null; }
  }
  try { return await res.text(); } catch (_) { return null; }
}

async function request(method, path, body, init = {}) {
  const opts = { method, ...init, headers: { ...(init.headers || {}) } };
  if (body !== undefined && body !== null) {
    if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(resolveUrl(path), opts);
  const data = await parseResponse(res);
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data.error || data.message)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (path, init) => request('GET', path, null, init),
  post: (path, body, init) => request('POST', path, body, init),
  put: (path, body, init) => request('PUT', path, body, init),
  patch: (path, body, init) => request('PATCH', path, body, init),
  del: (path, init) => request('DELETE', path, null, init),
  // Escape hatch when the caller needs the raw Response (e.g. streaming,
  // file download, blob, custom status handling).
  raw: (path, init) => fetch(resolveUrl(path), init),
};

export const apiSafe = {
  get: async (path, init) => { try { return await api.get(path, init); } catch (_) { return null; } },
  post: async (path, body, init) => { try { return await api.post(path, body, init); } catch (_) { return null; } },
  put: async (path, body, init) => { try { return await api.put(path, body, init); } catch (_) { return null; } },
  patch: async (path, body, init) => { try { return await api.patch(path, body, init); } catch (_) { return null; } },
  del: async (path, init) => { try { return await api.del(path, init); } catch (_) { return null; } },
};

// Convenience helper for the very common "PUT key/value into /api/settings" pattern.
export function putSetting(key, value) {
  return api.put('/settings', { key, value });
}

export default api;
