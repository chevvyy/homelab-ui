// Runtime configuration, read once from the environment.

const env = process.env;

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  // UI listener. In production it binds to loopback only: the Tailscale sidecar is the sole
  // client and prefixes every connection with a PROXY v1 header.
  uiHost: env.UI_HOST ?? '127.0.0.1',
  uiPort: Number(env.UI_PORT ?? 3000),
  // Probe listener (/healthz only), reachable by the kubelet.
  healthPort: Number(env.HEALTH_PORT ?? 8081),

  // "tailscale" (PROXY protocol + LocalAPI whois) or "dev" (no auth, local development only).
  authMode: (env.AUTH_MODE ?? 'tailscale') as 'tailscale' | 'dev',
  tsSocket: env.TS_SOCKET ?? '/var/run/tailscale/tailscaled.sock',
  // Tailscale logins allowed in. Empty = any user-owned (non-tagged) tailnet device.
  allowedLogins: list(env.ALLOWED_LOGINS),

  dataDir: env.DATA_DIR ?? './data',
  webDir: env.WEB_DIR ?? '../web/dist',

  // Namespace the controller itself runs in (credential Secrets live here).
  selfNamespace: env.SELF_NAMESPACE ?? 'homelab-ui',
  // Namespace new apps deploy into by default.
  appsNamespace: env.APPS_NAMESPACE ?? 'homelab-apps',
  // Namespaces where write actions are refused even if RBAC would allow them.
  protectedNamespaces: list(env.PROTECTED_NAMESPACES ?? 'kube-system,kube-public,kube-node-lease'),
  protectedPrefixes: list(env.PROTECTED_PREFIXES ?? 'cattle-,fleet-'),

  // Pull secret copied into every namespace the controller deploys to.
  pullSecretName: env.PULL_SECRET_NAME ?? 'ghcr',

  publicDomain: env.PUBLIC_DOMAIN ?? 'howellsas.com',
  internalDomain: env.INTERNAL_DOMAIN ?? 'lan.howellsas.com',
  // cloudflared reaches Traefik on :80, so public routes use the "web" entrypoint too (verified).
  publicEntrypoint: env.PUBLIC_ENTRYPOINT ?? 'web',
  internalEntrypoint: env.INTERNAL_ENTRYPOINT ?? 'web',

  storageClass: env.STORAGE_CLASS ?? 'nfs-bulk',
  dbStorageClass: env.DB_STORAGE_CLASS ?? 'local-path',

  githubOwner: env.GITHUB_OWNER ?? 'chevvyy',
  proxmoxPollMs: Number(env.PROXMOX_POLL_MS ?? 5000),
};

export function isProtectedNamespace(ns: string): boolean {
  return config.protectedNamespaces.includes(ns) || config.protectedPrefixes.some((p) => ns.startsWith(p));
}
