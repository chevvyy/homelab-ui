// Makes GHCR pulls work in any namespace the controller deploys into: copies the pull secret
// from the controller's own namespace and adds it to that namespace's default ServiceAccount.
import { config } from '../config.js';
import { K8sError, KObject, R, request, resourcePath } from './client.js';
import { LABEL_MANAGED } from './labels.js';

const synced = new Map<string, number>(); // namespace -> last sync time

export async function ensurePullSecret(namespace: string): Promise<{ ok: boolean; message?: string }> {
  if (namespace === config.selfNamespace) return { ok: true };
  if ((synced.get(namespace) ?? 0) > Date.now() - 10 * 60_000) return { ok: true };
  let source: KObject;
  try {
    source = await request<KObject>('GET', resourcePath(R.secrets, config.selfNamespace, config.pullSecretName));
  } catch (e) {
    return { ok: false, message: `No "${config.pullSecretName}" pull secret in ${config.selfNamespace}; private ghcr.io images will not pull.` };
  }
  const body = {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'kubernetes.io/dockerconfigjson',
    metadata: { name: config.pullSecretName, namespace, labels: { [LABEL_MANAGED]: 'true' } },
    data: source.data,
  };
  try {
    await request('PATCH', resourcePath(R.secrets, namespace, config.pullSecretName), {
      contentType: 'application/apply-patch+yaml',
      query: { fieldManager: 'homelab-ui', force: true },
      body,
    });
    const sa = await request<KObject>('GET', resourcePath(R.serviceaccounts, namespace, 'default'));
    const pulls: { name: string }[] = sa.imagePullSecrets ?? [];
    if (!pulls.some((p) => p.name === config.pullSecretName)) {
      await request('PATCH', resourcePath(R.serviceaccounts, namespace, 'default'), {
        contentType: 'application/merge-patch+json',
        body: { imagePullSecrets: [...pulls, { name: config.pullSecretName }] },
      });
    }
    synced.set(namespace, Date.now());
    return { ok: true };
  } catch (e) {
    const msg = e instanceof K8sError ? e.message : String(e);
    return { ok: false, message: `Could not set up the ghcr pull secret in ${namespace}: ${msg}` };
  }
}
