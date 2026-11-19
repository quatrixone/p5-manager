import net from 'net';

// P5 Converter (the console-side engine) serves its whole REST API on this
// port. Every action is driven by query arguments, so P5 Manager needs one
// guarded pass-through rather than a route per action.
export const ENGINE_PORT = 5920;

// Only the engine's own API surface, spelled exactly: `status`, or `lzc/`
// plus one or two plain segments. Nothing is decoded or normalised here -
// anything that is not already this shape is refused rather than cleaned up.
const ENGINE_TAIL = /^(status|lzc\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?)$/;

export function engineUrl(ip, tail, search = '') {
  if (net.isIP(ip) === 0) throw new Error(`"${ip}" is not a console address`);
  if (typeof tail !== 'string' || tail.length > 64 || !ENGINE_TAIL.test(tail)) {
    throw new Error(`"${String(tail).slice(0, 80)}" is not an engine path`);
  }
  return `http://${ip}:${ENGINE_PORT}/api/${tail}${search || ''}`;
}
