// Tailscale sign-in. The Tailscale sidecar forwards each tailnet connection to the loopback UI
// listener, prefixed with a PROXY v1 header carrying the client's tailnet address. We ask the
// sidecar's LocalAPI who owns that address (whois) and admit only user-owned devices.
// Nothing but the sidecar can reach the loopback listener, so the header cannot be forged.
import http from 'node:http';
import net from 'node:net';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { config } from './config.js';

export interface Identity {
  login: string;
  name: string;
  avatar?: string;
  device: string;
}

declare module 'node:net' {
  interface Socket {
    tsPeer?: { ip: string; port: number };
  }
}

const MAX_HEADER = 108; // PROXY v1 maximum line length

// Accepts raw TCP, strips the PROXY header, then hands the socket to the HTTP server. With
// getContext, the stream after the header is TLS and is decrypted here first.
export function proxyProtocolListener(server: http.Server, getContext?: () => tls.SecureContext): net.Server {
  // `rest` = bytes that arrived in the same read as the PROXY header.
  const hand = (socket: net.Socket, rest: Buffer = Buffer.alloc(0)) => {
    if (!getContext) {
      if (rest.length) socket.unshift(rest);
      server.emit('connection', socket);
      socket.resume();
      return;
    }
    // Node's TLS reads straight from the socket's native handle and would never see bytes we
    // already consumed (often the ClientHello arrives with the PROXY header), so feed it through
    // a JS stream that starts with those bytes.
    const stream = new Duplex({
      read() {
        socket.resume();
      },
      write(chunk, encoding, cb) {
        socket.write(chunk, encoding, cb);
      },
      final(cb) {
        socket.end();
        cb();
      },
      destroy(err, cb) {
        socket.destroy();
        cb(err);
      },
    });
    if (rest.length) stream.push(rest);
    socket.on('data', (d) => {
      if (!stream.push(d)) socket.pause();
    });
    socket.on('end', () => stream.push(null));
    socket.on('close', () => stream.destroy());
    const secure = new tls.TLSSocket(stream as unknown as net.Socket, { isServer: true, secureContext: getContext(), ALPNProtocols: ['http/1.1'] });
    secure.tsPeer = socket.tsPeer;
    secure.on('error', () => socket.destroy());
    server.emit('connection', secure);
    socket.resume();
  };
  return net.createServer({ pauseOnConnect: true }, (socket) => {
    if (config.authMode === 'dev') {
      hand(socket);
      return;
    }
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n');
      if (end < 0) {
        if (buf.length > MAX_HEADER) socket.destroy();
        return;
      }
      socket.off('data', onData);
      socket.pause();
      const line = buf.subarray(0, end).toString('ascii');
      const m = /^PROXY (TCP4|TCP6) (\S+) (\S+) (\d+) (\d+)$/.exec(line);
      if (!m) {
        socket.destroy();
        return;
      }
      socket.tsPeer = { ip: m[2], port: Number(m[4]) };
      hand(socket, buf.subarray(end + 2));
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
    socket.setTimeout(10_000, () => {
      if (!socket.tsPeer) socket.destroy();
    });
    socket.resume();
  });
}

function whois(ip: string, port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: config.tsSocket,
        path: `/localapi/v0/whois?addr=${encodeURIComponent(`${ip}:${port}`)}`,
        headers: { Host: 'local-tailscaled.sock' },
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(`whois ${res.statusCode}: ${body.trim()}`));
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('whois timeout')));
    req.on('error', reject);
    req.end();
  });
}

const cache = new Map<string, { at: number; identity?: Identity; reason?: string }>();
const TTL = 5 * 60_000;

export async function identify(socket: net.Socket | undefined): Promise<{ identity?: Identity; reason?: string }> {
  if (config.authMode === 'dev') return { identity: { login: 'dev@local', name: 'Developer', device: 'localhost' } };
  const peer = socket?.tsPeer;
  if (!peer) return { reason: 'Connection did not come through Tailscale.' };
  const hit = cache.get(peer.ip);
  if (hit && Date.now() - hit.at < TTL) return hit;
  let result: { identity?: Identity; reason?: string };
  try {
    const w = await whois(peer.ip, peer.port);
    const tags: string[] = w.Node?.Tags ?? [];
    const login: string | undefined = w.UserProfile?.LoginName;
    if (tags.length || !login || login === 'tagged-devices') {
      result = { reason: `Tagged devices (${tags.join(', ') || 'no user'}) cannot sign in. Use a device logged in as you.` };
    } else if (config.allowedLogins.length && !config.allowedLogins.includes(login)) {
      result = { reason: `${login} is not on the allowed list for this controller.` };
    } else {
      result = { identity: { login, name: w.UserProfile?.DisplayName ?? login, avatar: w.UserProfile?.ProfilePicURL || undefined, device: (w.Node?.ComputedName ?? w.Node?.Name ?? '').replace(/\.$/, '') } };
    }
  } catch (e) {
    // Don't cache failures: the sidecar may simply still be starting.
    return { reason: `Could not verify your Tailscale identity (${e instanceof Error ? e.message : e}).` };
  }
  cache.set(peer.ip, { at: Date.now(), ...result });
  return result;
}
