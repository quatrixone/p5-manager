import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FileBrowser from './FileBrowser';
import TransferMenu from './TransferMenu';
import { api, apiSafe } from '../lib/api.js';
import { planTransfer } from '../lib/transferPlan.js';

const RIGHT_KEY = 'fileops.dualPane.right';

const joinPath = (loc, name) => (loc.kind === 'local'
  ? (loc.path === '/' ? `/${name}` : `${loc.path.replace(/\/$/, '')}/${name}`)
  : (loc.path ? `${loc.path.replace(/\/+$/, '')}/${name}` : name));

// Two FileBrowser panes side by side. Dragging rows from one pane onto the
// other (or onto a folder in it) asks Copy / Move / Cancel and then runs the
// route planTransfer() picks: an instant rename, a direct copy/move on the
// server disk, or the server-side transfer queue.
export default function DualPane({ profiles, onNotification, onOpenQueue, onPickConvert }) {
  const [locs, setLocs] = useState({ left: null, right: null });
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState(null); // { src, dst, items, point, op?, conflicts?, busy? }
  const watched = useRef(new Set()); // batch ids still in the queue

  const rightInitial = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(RIGHT_KEY) || 'null'); } catch (_) { return null; }
  }, []);
  const onLeftLoc = useCallback((loc) => setLocs(l => ({ ...l, left: loc })), []);
  const onRightLoc = useCallback((loc) => {
    setLocs(l => ({ ...l, right: loc }));
    try { localStorage.setItem(RIGHT_KEY, JSON.stringify(loc)); } catch (_) {}
  }, []);

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
        for (const it of t.items) {
          await api.post('/convert/ftp/move', { ip: t.src.ftpIp, src: joinPath(t.src, it.name), dst: joinPath(t.dst, it.name) });
        }
        onNotification?.(`Moved ${t.items.length} item(s)`, 'success');
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
    onOpenQueue,
    onPickConvert,
    reloadSignal: reload,
  };

  return (
    <div className="dual-pane">
      <FileBrowser
        {...paneProps}
        paneId="left"
        title="Left pane"
        onLocationChange={onLeftLoc}
        onDropItems={handleDrop('left')}
        onSendToOther={sendToOther('left')}
      />
      <FileBrowser
        {...paneProps}
        paneId="right"
        title="Right pane"
        defaultKind="ftp"
        initialLocation={rightInitial}
        enableSaveDefault={false}
        jobKeyPrefix="mm.fb.right"
        onLocationChange={onRightLoc}
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
  );
}
