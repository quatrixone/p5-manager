# Dual-pane file manager — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two file browser panes side by side in File Ops, with drag & drop copy/move between server disk, remote sources and PS5 consoles, executed by the server-side queue.

**Architecture:** The existing FTP upload queue in `backend/src/routes/convert.js` becomes a general transfer queue (new item fields, one new endpoint). The frontend wraps two `FileBrowser` instances in a `DualPane` that decides, via a pure `planTransfer` function, whether a drop is a direct call (rename, local copy/move) or a queued transfer.

**Tech Stack:** Node 24 / Express / basic-ftp, React 18 / Vite, `node --test` for pure-function tests.

**Spec:** `docs/superpowers/specs/2026-10-06-dual-pane-file-manager-design.md`

**Execution note:** the user asked to go straight through to deploy and push, so this plan lists tasks, interfaces and tests without embedding the full code of every step; it is executed inline in the authoring session.

## Global Constraints

- Remote sources (SMB/FTP) are a source only, never a destination.
- PS5 → PS5 copies stage through the server's temp dir (`getDiskTmpRoot()`).
- A drop always shows Copy / Move / Cancel; nothing transfers before a choice.
- Move deletes the source only after the destination size was verified.
- Existing `/convert/ftp/upload/queue` callers and persisted queue items keep working unchanged.
- Single-pane mode and the Convert tab's `FileBrowser` behave exactly as before.

## Review Focus

- Folder dropped into itself or into its own sub-folder: rejected, nothing queued.
- Name collision in the destination: nothing queued until the user picks Overwrite.
- Console unreachable mid-move: item fails, source files stay.
- Not enough free space on the server for staging: item fails with a clear message before downloading.
- Empty folder dropped: reported as "nothing to transfer", no phantom queue items.

---

### Task 1: Pure path helpers (backend)

**Files:** Create `backend/src/lib/transferPaths.js`, `backend/src/lib/transferPaths.test.js`; modify `backend/package.json` (`"test": "node --test src"`).

**Produces:**
- `cleanDir(p: string): string` — collapses slashes, strips trailing slash, keeps `/`.
- `joinPath(base: string, name: string): string`
- `isSameOrInside(parent: string, child: string): boolean`
- `destDirFor(destBase: string, baseName: string, relPath: string): string` — directory a file at `relPath` inside dropped folder `baseName` lands in.

- [ ] Tests: root handling, nested relPath, folder-into-itself, sibling with common prefix (`/a/b` vs `/a/bc`).
- [ ] Implement, run `npm test`.

### Task 2: Transfer queue (backend)

**Files:** Modify `backend/src/routes/convert.js`.

**Consumes:** Task 1 helpers; existing `withFtp`, `withSourceFtp`, `uploadFileResilient`, `walkLocalDirFiles`, `walkSourceDirFiles`, `isLocalPathAllowed`, `getDiskTmpRoot`, `ftpUploadQ`.

**Produces:**
- Item fields: `op`, `source_kind: 'ps5-ftp'`, `source_ip`, `dest_kind: 'ps5-ftp' | 'local'`, `batch_id`, `source_root`, `source_is_dir`.
- `POST /api/convert/transfer/queue` body `{ op, overwrite, src: { kind, ip?, source_id?, items: [{ path, is_dir }] }, dst: { kind, ip?, path } }` → `{ success, count, batch_id }`, `409 { error, conflicts }`, `400` for folder-into-itself / empty selection / remote destination.
- `walkPs5DirFiles(ip, basePath) → [{ remotePath, relPath, size }]`.

- [ ] Executor: fetch source (ps5 / remote) to `.part` in the destination (local dest) or temp dir (ps5 dest), free-space check, write destination, verify size, delete source on move, remove emptied source folders when the batch finished cleanly.
- [ ] Endpoint with validation and conflict detection.
- [ ] Verify against a local FTP server stand-in on a throwaway backend: every row of the spec table, conflict, folder-into-itself, failure keeps the source.

### Task 3: `planTransfer` (frontend)

**Files:** Create `frontend/src/lib/transferPlan.js`, `frontend/src/lib/transferPlan.test.js`; modify `frontend/package.json` (`"test": "node --test src/lib"`).

**Produces:** `planTransfer(src, dst, op) → { route: 'noop' | 'unsupported' | 'ftp-rename' | 'local-copy' | 'local-move' | 'queue', reason? }` where `src`/`dst` are `{ kind: 'local' | 'smb' | 'ftp', ftpIp, smbId, path }`.

- [ ] One test per row of the spec's scope table, plus same-folder drop.

### Task 4: FileBrowser as a pane

**Files:** Modify `frontend/src/components/FileBrowser.jsx`.

**Produces (all optional props):** `paneId`, `initialLocation`, `onLocationChange(loc)`, `onDropItems(payload, destPath, point)`, `onSendToOther(op, payload)`, `reloadSignal`. Drag payload: `{ pane, kind, ftpIp, smbId, path, items: [{ name, isDir, size }] }` under MIME `application/x-p5m-items`.

- [ ] Rows draggable; pane body and folder rows are drop targets with a highlight.
- [ ] Selection bar gets "Copy to other pane" / "Move to other pane".

### Task 5: DualPane, TransferMenu, File Ops toggle, Queue labels

**Files:** Create `frontend/src/components/DualPane.jsx`, `frontend/src/components/TransferMenu.jsx`; modify `frontend/src/components/FileOps.jsx`, `frontend/src/components/Queue.jsx`, `frontend/src/styles.css`.

- [ ] DualPane runs the planned route, handles 409 with an Overwrite step, starts the upload queue, reloads both panes when the batch settles.
- [ ] "Two panes" toggle in File Ops → Browse, remembered in `localStorage`; right pane remembers its own location.
- [ ] Queue shows direction and Copy/Move for transfer items.
- [ ] Build, screenshot at desktop and phone width.
