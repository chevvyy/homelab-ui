// System credentials live in Kubernetes Secrets in the controller's namespace; the browser never
// sees them. Rotation from the UI writes the Secret and reconnects.
import { config } from './config.js';
import { K8sError, R, request, resourcePath } from './k8s/client.js';

export async function readSecret(name: string): Promise<Record<string, string> | undefined> {
  try {
    const s = await request<any>('GET', resourcePath(R.secrets, config.selfNamespace, name));
    return Object.fromEntries(Object.entries<string>(s.data ?? {}).map(([k, v]) => [k, Buffer.from(v, 'base64').toString('utf8')]));
  } catch (e) {
    if (e instanceof K8sError && e.status === 404) return undefined;
    throw e;
  }
}

// Merges keys into the Secret (creating it if needed). Empty values are ignored so a partial
// form never wipes an existing credential.
export async function writeSecret(name: string, values: Record<string, string>): Promise<void> {
  const current = (await readSecret(name)) ?? {};
  const merged = { ...current };
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== '') merged[k] = v;
  await request('PATCH', resourcePath(R.secrets, config.selfNamespace, name), {
    contentType: 'application/apply-patch+yaml',
    query: { fieldManager: 'homelab-ui', force: true },
    body: {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: { name, namespace: config.selfNamespace, labels: { 'homelab.io/managed': 'true' } },
      stringData: merged,
    },
  });
}
