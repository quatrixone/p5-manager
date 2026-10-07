import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FileBrowser from './FileBrowser';
import TransferMenu from './TransferMenu';
import { api, apiSafe } from '../lib/api.js';
import { planTransfer } from '../lib/transferPlan.js';

const RIGHT_KEY = 'fileops.dualPane.right';
const MOVES_KEY = 'fileops.dualPane.consoleMoves';

const fmtGB = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
const fmtEta = (sec) => (sec >= 90 ? `~${Math.round(sec / 60)} min left` : `~${Math.max(1, Math.round(sec))} s left`);

const joinPath = (loc, name) => (loc.kind === 'local'
  ? (loc.path === '/' ? `/${name}` : `${loc.path.replace(/\/$/, '')}/${name}`)
  : (loc.path ? `${loc.path.replace(/\/+$/, '')}/${name}` : name));

// Two FileBrowser panes side by side. Dragging rows from one pane onto the
// other (or onto a folder in it) asks Copy / Move / Cancel and then runs the
// route planTransfer() picks: an instant rename, a direct copy/move on the
// server disk, or the server-side transfer queue.
export default function DualPane({ profiles, onNotification, onOpenQueue, onPickConvert, enableConvertActions, onConsolePlatformChange }) {
  const [locs, setLocs] = useState({ left: null, right: null });
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState(null); // { src, dst, items, point, op?, conflicts?, busy? }
  const watched = useRef(new Set()); // batch ids still in the queue

  // Moves the console carries out itself (same console, rename). Within one
  // drive they are instant; across drives zftpd copies in the background and
  // tells nobody, so we measure it: what is left under the source, plus the
  // file currently in flight at the destination. Kept in localStorage so the
  // bar survives a reload while the console keeps working.
  const [consoleMoves, setConsoleMoves] = useState(() => {
    try { return JSON.parse(localStorage.getItem(MOVES_KEY) || '[]'); } catch (_) { return []; }
  });
  const consoleMovesRef = useRef(consoleMoves);
  useEffect(() => {
    consoleMovesRef.current = consoleMoves;
    try { localStorage.setItem(MOVES_KEY, JSON.stringify(consoleMoves)); } catch (_) {}
  }, [consoleMoves]);
  useEffect(() => {
    const tick = async () => {
      const moves = consoleMovesRef.current;
      if (moves.length === 0) return;
      const next = [];
      let finished = false;
      for (const m of moves) {
        const d = await apiSafe.post('/convert/ftp/du', { ip: m.ip, paths: [m.src, m.dst] });
        if (!d?.sizes) { next.push(m); continue; } // console busy / unreachable: keep waiting
        const left = d.sizes[m.src];
        const inFlight = d.sizes[m.dst]?.tmp || 0;
        if (!left || (left.size === 0 && left.tmp === 0 && inFlight === 0)) {
          finished = true;
          if (m.total > 0 && Date.now() - m.startedAt > 4000) onNotification?.(`Move finished: ${m.name}`, 'success');
          continue;
        }
        const done = Math.max(0, Math.min(m.total, m.total - left.size + inFlight));
        const now = Date.now();
        const dt = (now - (m.sampleAt || m.startedAt)) / 1000;
        const inst = dt > 0 ? Math.max(0, done - (m.done || 0)) / dt : 0;
        // Smoothed so one slow poll doesn't make the estimate jump around.
        const rate = m.rate ? m.rate * 0.6 + inst * 0.4 : inst;
        next.push({ ...m, done, rate, sampleAt: now });
      }
      setConsoleMoves(next);
      if (finished) setReload(r => r + 1);
    };
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, [onNotification]);

  const rightInitial = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(RIGHT_KEY) || 'null'); } catch (_) { return null; }
  }, []);
  const onLeftLoc = useCallback((loc) => setLocs(l => ({ ...l, left: loc })), []);
  const onRightLoc = useCallback((loc) => {
    setLocs(l => ({ ...l, right: loc }));
    try { localStorage.setItem(RIGHT_KEY, JSON.stringify(loc)); } catch (_) {}
  }, []);
  const onLeftPlatform = useCallback(platform => onConsolePlatformChange?.(platform), [onConsolePlatformChange]);
  const onRightPlatform = useCallback(platform => onConsolePlatformChange?.(platform), [onConsolePlatformChange]);

  const profileName = (ip) => profiles.find(p => p.ip_address === ip)?.name || ip;
  const describe = (loc) => {
    if (!loc) return '';
    if (loc.kind === 'local') return `Server ${loc.path}`;
    if (loc.kind === 'ftp') return `${profileName(loc.ftpIp)} ${loc.path}`;
    return `Remote ${loc.path || '/'}`;
  };

  // Queued transfers finish later: re-list both panes once none of our
  // batches has anything left to do.
  useEffect(() => {
    const t = setInterval(async () => {
      if (watched.current.size === 0) return;
      const q = await apiSafe.get('/convert/queue/all');
      const items = q?.upload?.items;
      if (!Array.isArray(items)) return;
      let settled = false;
      for (const id of Array.from(watched.current)) {
        const mine = items.filter(i => i.batch_id === id);
        if (mine.some(i => ['queued', 'running'].includes(i.status))) continue;
        watched.current.delete(id);
        settled = true;
        const failed = mine.filter(i => i.status === 'failed').length;
        if (failed) onNotification?.(`${failed} of ${mine.length} file(s) failed - see Tasks`, 'error');
        else if (mine.length) onNotification?.(`Transfer finished (${mine.length} file${mine.length === 1 ? '' : 's'})`, 'success');
      }
      if (settled) setReload(r => r + 1);
    }, 2000);
    return () => clearInterval(t);
  }, [onNotification]);

  const execute = async (op, t, overwrite = false) => {
    const plan = planTransfer(t.src, t.dst, op);
    if (plan.route === 'noop') { setPending(null); return; }
    if (plan.route === 'unsupported') { setPending(null); onNotification?.(plan.reason, 'error'); return; }
    setPending(p => (p ? { ...p, op, busy: true } : p));
    try {
      if (plan.route === 'ftp-rename') {
        // A rename onto an existing name is up to the FTP server: zftpd merges
        // folders (and copies for real when the target is another drive).
        // Never do that silently - refuse and let the user sort it out.
        const there = await api.post('/convert/ftp/browse', { ip: t.dst.ftpIp, path: t.dst.path });
        const taken = t.items.map(it => it.name).filter(n => (there.files || []).some(f => f.name === n));
        if (taken.length) {
          setPending(null);
          onNotification?.(`Already in the destination: ${taken.slice(0, 5).join(', ')}${taken.length > 5 ? '…' : ''}. Open that folder and move the contents instead.`, 'error');
          return;
        }
        const pairs = t.items.map(it => ({ name: it.name, src: joinPath(t.src, it.name), dst: joinPath(t.dst, it.name) }));
        // Sizes first: once the move runs there is nothing left to measure against.
        const before = await apiSafe.post('/convert/ftp/du', { ip: t.src.ftpIp, paths: pairs.map(x => x.src) });
        for (const x of pairs) {
          await api.post('/convert/ftp/move', { ip: t.src.ftpIp, src: x.src, dst: x.dst });
        }
        const startedAt = Date.now();
        setConsoleMoves(list => [
          ...list,
          ...pairs.map(x => ({
            id: `${startedAt}:${x.src}`, ip: t.src.ftpIp, name: x.name, src: x.src, dst: x.dst,
            total: before?.sizes?.[x.src]?.size || 0, done: 0, rate: 0, startedAt,
          })),
        ]);
        onNotification?.(`Move started on the console: ${t.items.length} item(s)`, 'success');
        setReload(r => r + 1);
      } else if (plan.route === 'local-copy' || plan.route === 'local-move') {
        const endpoint = plan.route === 'local-move' ? 'move' : 'copy';
        const conflicts = [];
        for (const it of t.items) {
          try {
            await api.post(`/convert/local/${endpoint}`, {
              src: joinPath(t.src, it.name), dst: joinPath(t.dst, it.name), isDir: it.isDir, overwrite,
            });
          } catch (e) {
            if (e.status !== 409) throw e;
            conflicts.push(it.name);
          }
        }
        setReload(r => r + 1);
        if (conflicts.length) {
          setPending({ ...t, op, items: t.items.filter(i => conflicts.includes(i.name)), conflicts, busy: false });
          return;
        }
        onNotification?.(`${op === 'move' ? 'Moved' : 'Copied'} ${t.items.length} item(s)`, 'success');
      } else {
        const d = await api.post('/convert/transfer/queue', {
          op,
          overwrite,
          src: {
            kind: t.src.kind,
            ip: t.src.ftpIp || undefined,
            source_id: t.src.kind === 'smb' ? Number(t.src.smbId) : undefined,
            items: t.items.map(it => ({ path: joinPath(t.src, it.name), is_dir: it.isDir })),
          },
          dst: { kind: t.dst.kind, ip: t.dst.ftpIp || undefined, path: t.dst.path },
        });
        watched.current.add(d.batch_id);
        // A drop means "do it now": make sure the queue is running.
        await apiSafe.post('/convert/ftp/upload/queue/resume');
        onNotification?.(`${op === 'move' ? 'Move' : 'Copy'} started: ${d.count} file(s) - progress in Tasks`, 'success');
      }
      setPending(null);
    } catch (e) {
      if (e.status === 409 && Array.isArray(e.data?.conflicts)) {
        setPending({ ...t, op, conflicts: e.data.conflicts, busy: false });
        return;
      }
      setPending(null);
      onNotification?.(e.message, 'error');
    }
  };

  const handleDrop = (targetPane) => (payload, destPath, point) => {
    const target = locs[targetPane];
    if (!target) return;
    const src = { kind: payload.kind, ftpIp: payload.ftpIp, smbId: payload.smbId, path: payload.path };
    const dst = { ...target, path: destPath };
    // A folder dropped onto its own row.
    const items = payload.items.filter(it => !(src.kind === dst.kind && joinPath(src, it.name) === destPath));
    if (items.length === 0) return;
    const plan = planTransfer(src, dst, 'copy');
    if (plan.route === 'noop') return;
    if (plan.route === 'unsupported') { onNotification?.(plan.reason, 'error'); return; }
    setPending({ src, dst, items, point });
  };

  const sendToOther = (fromPane) => (op, payload) => {
    const dst = locs[fromPane === 'left' ? 'right' : 'left'];
    if (!dst) { onNotification?.('Open a folder in the other pane first', 'error'); return; }
    if (!payload.items.length) return;
    const src = { kind: payload.kind, ftpIp: payload.ftpIp, smbId: payload.smbId, path: payload.path };
    const t = { src, dst, items: payload.items, point: { x: window.innerWidth / 2, y: window.innerHeight / 2 } };
    setPending({ ...t, op, busy: true });
    execute(op, t);
  };

  const paneProps = {
    profiles,
    onNotification,
    enableFtp: true,
    enableExtract: true,
    enableDelete: true,
    enableFtpUpload: true,
    enableDeviceUpload: true,
    enableConvertActions,
    onOpenQueue,
    onPickConvert,
    reloadSignal: reload,
  };

  return (
    <>
    {consoleMoves.filter(m => m.total > 0 && Date.now() - m.startedAt > 2500).map(m => {
      const pct = Math.min(100, Math.round((m.done / m.total) * 100));
      return (
        <div key={m.id} className="console-move">
          <div className="flex justify-between gap-sm text-xs">
            <span className="truncate" title={`${m.src} → ${m.dst}`}>
              🎮 {profileName(m.ip)} is moving <b>{m.name}</b> → {m.dst}
            </span>
            <span className="text-muted" style={{ whiteSpace: 'nowrap' }}>
              {pct}% · {fmtGB(m.done)} / {fmtGB(m.total)}
              {m.rate > 0 ? ` · ${fmtGB(m.rate)}/s · ${fmtEta((m.total - m.done) / m.rate)}` : ''}
            </span>
          </div>
          <div className="console-move-bar"><div style={{ width: `${pct}%` }} /></div>
        </div>
      );
    })}
    <div className="dual-pane">
      <FileBrowser
        {...paneProps}
        paneId="left"
        title="Pane 1"
        onLocationChange={onLeftLoc}
        onConsolePlatformChange={onLeftPlatform}
        onDropItems={handleDrop('left')}
        onSendToOther={sendToOther('left')}
      />
      <FileBrowser
        {...paneProps}
        paneId="right"
        title="Pane 2"
        defaultKind="ftp"
        initialLocation={rightInitial}
        enableSaveDefault={false}
        jobKeyPrefix="mm.fb.right"
        onLocationChange={onRightLoc}
        onConsolePlatformChange={onRightPlatform}
        onDropItems={handleDrop('right')}
        onSendToOther={sendToOther('right')}
      />
      <TransferMenu
        pending={pending}
        destLabel={describe(pending?.dst)}
        onChoose={(op) => execute(op, pending)}
        onOverwrite={() => execute(pending.op, pending, true)}
        onCancel={() => setPending(null)}
      />
    </div>
    </>
  );
}
