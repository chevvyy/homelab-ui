// Live state from the server's WebSocket, exposed to React through useSyncExternalStore.
// Reconnects with back-off; on reconnect the server re-sends a full snapshot.
import { useRef, useSyncExternalStore } from 'react';
import type { AppSummary, Build, ClusterState, ProxmoxState, TrueNasState, User } from './types';

export interface LiveState {
  connected: boolean;
  lastMessage?: number;
  user?: User;
  apps: AppSummary[];
  appsLoaded: boolean;
  cluster?: ClusterState;
  proxmox?: ProxmoxState;
  truenas?: TrueNasState;
  builds: Record<string, Build>;
}

let state: LiveState = { connected: false, apps: [], appsLoaded: false, builds: {} };
const listeners = new Set<() => void>();
const appListeners = new Set<(apps: AppSummary[]) => void>();

function set(patch: Partial<LiveState>) {
  state = { ...state, ...patch, lastMessage: Date.now() };
  for (const l of listeners) l();
}

let ws: WebSocket | undefined;
let retry = 0;
let pingTimer: number | undefined;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/ws`);
  ws.onopen = () => {
    retry = 0;
    set({ connected: true });
    clearInterval(pingTimer);
    pingTimer = window.setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
  };
  ws.onmessage = (ev) => {
    if (ev.data === 'pong') return;
    const msg = JSON.parse(ev.data);
    switch (msg.t) {
      case 'hello':
        set({ user: msg.user });
        break;
      case 'apps':
        set({ apps: msg.apps, appsLoaded: true });
        for (const l of appListeners) l(msg.apps);
        break;
      case 'cluster':
        set({ cluster: { nodes: msg.nodes, namespaces: msg.namespaces, watch: msg.watch, metrics: msg.metrics, synced: msg.synced } });
        break;
      case 'proxmox':
        set({ proxmox: msg.state });
        break;
      case 'truenas':
        set({ truenas: msg.state });
        break;
      case 'build':
        set({ builds: { ...state.builds, [msg.build.id]: msg.build } });
        break;
    }
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    set({ connected: false });
    const delay = Math.min(1000 * 2 ** retry++, 15_000);
    setTimeout(connect, delay);
  };
}

// Phones drop sockets in the background; reconnect immediately when the tab is visible again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ws && ws.readyState > WebSocket.OPEN) {
    retry = 0;
    connect();
  }
});

connect();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Selectors may derive new arrays (filter/sort); cache the result per state object so
// useSyncExternalStore sees a stable snapshot until the state actually changes. Pass `key`
// when the selector depends on props (e.g. an app id) so it re-runs when they change.
export function useLive<T>(select: (s: LiveState) => T, key?: string): T {
  const memo = useRef<{ state?: LiveState; key?: string; value?: T }>({});
  return useSyncExternalStore(subscribe, () => {
    if (memo.current.state !== state || memo.current.key !== key) memo.current = { state, key, value: select(state) };
    return memo.current.value as T;
  });
}

export function onApps(fn: (apps: AppSummary[]) => void): () => void {
  appListeners.add(fn);
  return () => appListeners.delete(fn);
}

export function currentState(): LiveState {
  return state;
}
