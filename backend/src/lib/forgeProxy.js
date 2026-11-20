import net from 'net';

// PS5 Dump Forge serves its whole REST API on this port, as JSON bodies
// rather than query arguments, so P5 Manager needs one guarded pass-through
// that forwards the body rather than a route per action.
export const FORGE_PORT = 8095;

// Only the endpoints the app uses, spelled exactly. Left out on purpose:
// `quit` (our own /stop does that), and the debug build's `set`, `bench`
// and `crash` - `crash` deliberately kills the running game.
const FORGE_PATHS = new Set([
  'session', 'inspect', 'default_output', 'generated_output',
  'start_job', 'cancel_job', 'jobs',
  'library_scan', 'list_dir', 'host_tree',
  'delete_path', 'move_path', 'stale_parts',
  'edit_check', 'existing_targets', 'notifications', 'elfldr', 'qr',
]);

export function forgeUrl(ip, tail) {
  if (net.isIP(ip) === 0) throw new Error(`"${ip}" is not a console address`);
  if (typeof tail !== 'string' || !FORGE_PATHS.has(tail)) {
    throw new Error(`"${String(tail).slice(0, 80)}" is not a Forge endpoint`);
  }
  return `http://${ip}:${FORGE_PORT}/api/${tail}`;
}
