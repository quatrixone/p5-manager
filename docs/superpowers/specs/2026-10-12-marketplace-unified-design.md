# Unified Marketplace: one list, user sources, install and update everywhere

Date: 2026-10-12

## What this is for

Today the Marketplace tab holds three separate screens — New, Marketplace
and FPKGi Catalog Hub — and only the curated Marketplace can install
anything. The user wants one list for everything, their own catalog JSONs
beside ours, and a card that says plainly whether an item is installed and
offers Install or Update, from New just as much as from the list.

Success: a person opens Marketplace, searches once, and sees every item we
know about; the card tells them what they already have and installs or
updates it, or says why it cannot right now.

## Decisions taken with the user

- One merged list (not sections, not tabs), filtered by source, category,
  kind, console and "updates only".
- Custom sources accept both formats, detected from the content.
- Sources are managed from a panel inside Marketplace, stored in the database.
- Catalog packages may be installed even without a SHA-256, behind an
  explicit "unverified package" confirmation.
- A console-dependent action is disabled while the console is off; payloads,
  scripts and templates install regardless.
- "Installed" comes from the Library (the console) plus our own records.
- Built-in payloads join scripts and templates in being read from the store.

## Architecture

Server-side merge. Each source is an adapter returning the same item shape;
`/store/browse` merges, filters, sorts and paginates. The alternatives —
merging in the browser, or precomputing one file — either push whole
catalogs to a phone on every keystroke or keep a second, staler truth about
what is installed.

### Backend

1. `lib/catalogSource.js` — generalises `lib/fpkgiCatalog.js`: fetch a JSON
   source (https only, no credentials, 32 MiB cap, 15-minute TTL, disk cache
   under `DATA_DIR/marketplace/sources/`), keep the last copy on failure and
   report it as `warning`. Format detection: `{DATA:{…}}` is an FPKGi
   catalog, `{items:[…]}` a P5 Manager store index; anything else is a
   readable error naming what was expected.
2. `store_sources` table (`id, name, url, format, enabled, created_at,
   last_fetched_at, last_error`) with `GET/POST/PATCH/DELETE /store/sources`.
3. `GET /store/browse?platform&source&category&kind&q&updates&page&limit&refresh`
   returns `{ items, total, page, pages, warnings[] }`. Each item carries
   `origin` (`marketplace` | `fpkgi` | `source:<id>`), `installable`,
   `verified`, `installed`, `update`. Curated items sort first, then catalog
   items by name. A failing source becomes a warning, never an empty page.
4. `lib/installedState.js` — merges `store_installs` with the last Library
   snapshot. Every successful Library read writes
   `DATA_DIR/marketplace/library-<profileId>.json`; with the console off the
   state is served from it and marked with the time it was taken. Homebrew is
   matched by `homebrew_id` / the title ID in the package name.
5. Catalog installs reuse the existing paths — PS5 through
   `/convert/install/queue`, PS4 through Remote Package Installer — and are
   recorded in `store_installs` with their origin so the version can be
   tracked. Without a SHA-256 the request must carry an explicit
   acknowledgement, and the install is logged as unverified.
6. `builtinLoader` reads `payloads.json` from the store like `inputScripts`
   and `templates`, with the same cache and fallback to the copy in the app.
   Vendored payloads stay tied to the app release.

### Frontend

7. `lib/marketplaceView.js` — pure helpers for filtering, ordering and the
   button text, so the behaviour is testable (frontend tests cover `lib/` only).
8. `Marketplace.jsx` becomes one list: one search box, one filter row, one
   grid. `CatalogHub.jsx` disappears into a shared `MarketplaceCard`, which
   New uses as well, so both offer Install and Update.
9. `SourcesPanel.jsx` — add a source by URL and name, enable, disable, delete,
   refresh, and see the last fetch and the last error.

## Behaviour that must hold

- A card never claims an item is installed without saying where that came
  from: the console (with the time of the snapshot) or our own records.
- Install is disabled, with the reason written out, when the item needs a
  console that is not reachable.
- An unverified package is labelled on the card, in the confirmation and in
  the log line.
- One broken source degrades to a warning; the rest of the list still loads.

## Testing

Backend: format detection; rejection of http, credentials and oversized
JSON; a failing source leaving the others intact; merge, filter and
pagination; installed/update state from fresh and stale snapshots; refusal
to install a console-dependent item while the console is off.
Frontend: `marketplaceView` filters, ordering and button text.
Manual: desktop and phone screenshots, then the Docker stack.

## Out of scope

Bulk downloads, installing whole catalogs, fixing bad upstream metadata, and
any change to how the curated store is published and accepted.
