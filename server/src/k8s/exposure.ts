// Internal / Public / Off per app. Both modes are a Traefik IngressRoute on the "web" entrypoint:
//   public:   <app>.howellsas.com      (wildcard DNS -> Cloudflare Tunnel -> Traefik)
//   internal: <app>.lan.howellsas.com  (*.lan DNS -> Tailscale LAN gateway -> Traefik)
// Hosts under lan.howellsas.com never resolve to the tunnel, so they stay tailnet-only.
import { config } from '../config.js';
import { ActionError, guardWrite } from './actions.js';
import { appObjects, buildApps, Exposure } from './apps.js';
import { cache } from './cache.js';
import { FIELD_MANAGER, K8sError, R, request, resourcePath } from './client.js';
import { LABEL_APP, LABEL_EXPOSURE, LABEL_MANAGED } from './labels.js';

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function defaultHost(app: string, mode: Exclude<Exposure, 'off'>): string {
  return mode === 'public' ? `${app}.${config.publicDomain}` : `${app}.${config.internalDomain}`;
}

// Every host already routed by any Ingress or IngressRoute in the cluster, with its owner.
export function takenHosts(): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of buildApps()) for (const h of a.hosts) out.set(h.host, a.id);
  // Routes not attributed to an app still claim their hosts.
  for (const r of [...cache.list('ingresses'), ...cache.list('ingressroutes')]) {
    const hosts = r.kind === 'Ingress' ? (r.spec?.rules ?? []).map((x: any) => x.host) : (r.spec?.routes ?? []).flatMap((x: any) => [...String(x.match ?? '').matchAll(/Host\(`([^`]+)`\)/g)].map((m) => m[1]));
    for (const h of hosts) if (h && !out.has(h)) out.set(h, `${r.metadata.namespace}/${r.kind}/${r.metadata.name}`);
  }
  return out;
}

export function checkHost(host: string, appId: string): { ok: boolean; message?: string } {
  if (!HOST_RE.test(host)) return { ok: false, message: `"${host}" is not a valid hostname.` };
  if (!host.endsWith(`.${config.publicDomain}`)) return { ok: false, message: `Hostnames must be under ${config.publicDomain}.` };
  const owner = takenHosts().get(host);
  if (owner && owner !== appId) return { ok: false, message: `${host} is already used by ${owner}.` };
  return { ok: true };
}

export async function setExposure(namespace: string, app: string, mode: Exposure, opts: { host?: string; service?: string; port?: number } = {}) {
  guardWrite(namespace);
  // Right after a deploy the watch cache may lag the API by a moment; wait briefly for the app
  // and its Service to show up.
  let objs = appObjects(namespace, app);
  for (let i = 0; i < 20 && (!objs || (mode !== 'off' && !objs.services.length)); i++) {
    await new Promise((r) => setTimeout(r, 300));
    objs = appObjects(namespace, app);
  }
  if (!objs) throw new ActionError('App not found.', 404);
  const routeName = `${app}-route`;
  const routePath = resourcePath(R.ingressroutes, namespace, routeName);

  if (mode === 'off') {
    // Remove every route the controller made for this app.
    const list = await request<any>('GET', resourcePath(R.ingressroutes, namespace), { query: { labelSelector: `${LABEL_APP}=${app},${LABEL_EXPOSURE}` } });
    for (const r of list.items ?? []) await request('DELETE', resourcePath(R.ingressroutes, namespace, r.metadata.name)).catch(() => undefined);
    return { mode, host: undefined };
  }

  const svc = opts.service ? objs.services.find((s) => s.metadata.name === opts.service) : objs.services[0];
  if (!svc) throw new ActionError('This app has no Service to route traffic to. Redeploy it with a port, or add a Service to its YAML.', 422);
  const port = opts.port ?? svc.spec?.ports?.[0]?.port;
  if (!port) throw new ActionError(`Service ${svc.metadata.name} exposes no ports.`, 422);

  const host = (opts.host?.trim().toLowerCase() || defaultHost(app, mode)) as string;
  const check = checkHost(host, objs.app.id);
  if (!check.ok) throw new ActionError(check.message!, 409);
  const isInternal = host.endsWith(`.${config.internalDomain}`);
  if (mode === 'internal' && !isInternal) throw new ActionError(`Internal hostnames must end in .${config.internalDomain}.`, 422);
  if (mode === 'public' && isInternal) throw new ActionError(`.${config.internalDomain} names are internal-only; pick a different public name.`, 422);

  const body = {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: { name: routeName, namespace, labels: { [LABEL_APP]: app, [LABEL_MANAGED]: 'true', [LABEL_EXPOSURE]: mode } },
    spec: {
      entryPoints: [mode === 'public' ? config.publicEntrypoint : config.internalEntrypoint],
      routes: [{ match: `Host(\`${host}\`)`, kind: 'Rule', services: [{ name: svc.metadata.name, port }] }],
    },
  };
  try {
    await request('PATCH', routePath, { contentType: 'application/apply-patch+yaml', query: { fieldManager: FIELD_MANAGER, force: true }, body });
  } catch (e) {
    if (e instanceof K8sError && e.status === 404) throw new ActionError('Traefik IngressRoute CRDs are not available in this cluster.', 500);
    throw e;
  }
  return { mode, host, url: `${mode === 'public' ? 'https' : 'http'}://${host}` };
}
