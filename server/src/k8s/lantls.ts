// Copies the *.lan wildcard certificate (issued by cert-manager in the controller's namespace)
// into namespaces that have Internal routes, and keeps the copies fresh after renewals.
import { config } from '../config.js';
import { cache } from './cache.js';
import { K8sError, KObject, R, request, resourcePath } from './client.js';
import { LABEL_EXPOSURE, LABEL_MANAGED } from './labels.js';

async function source(): Promise<KObject | undefined> {
  try {
    const s = await request<KObject>('GET', resourcePath(R.secrets, config.selfNamespace, config.lanTlsSecret));
    return s.data?.['tls.crt'] ? s : undefined;
  } catch (e) {
    if (e instanceof K8sError && e.status === 404) return undefined;
    throw e;
  }
}

// Returns the Secret name to reference from IngressRoutes in `namespace`, or undefined when no
// certificate has been issued yet (Internal routes then fall back to plain HTTP).
export async function ensureLanCert(namespace: string): Promise<string | undefined> {
  const src = await source();
  if (!src) return undefined;
  if (namespace === config.selfNamespace) return config.lanTlsSecret;
  await request('PATCH', resourcePath(R.secrets, namespace, config.lanTlsSecret), {
    contentType: 'application/apply-patch+yaml',
    query: { fieldManager: 'homelab-ui', force: true },
    body: {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'kubernetes.io/tls',
      metadata: { name: config.lanTlsSecret, namespace, labels: { [LABEL_MANAGED]: 'true' } },
      data: { 'tls.crt': src.data['tls.crt'], 'tls.key': src.data['tls.key'] },
    },
  });
  return config.lanTlsSecret;
}

export function startLanCertSync() {
  const sync = async () => {
    const namespaces = new Set(
      cache.list('ingressroutes').filter((r) => r.metadata.labels?.[LABEL_EXPOSURE] === 'internal').map((r) => r.metadata.namespace!),
    );
    for (const ns of namespaces) await ensureLanCert(ns).catch(() => undefined);
  };
  setInterval(() => void sync(), 6 * 60 * 60_000).unref();
  setTimeout(() => void sync(), 60_000).unref();
}
