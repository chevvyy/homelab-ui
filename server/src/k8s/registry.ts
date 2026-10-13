// Checks that an image reference exists before deploying, to catch typos early. Speaks the
// registry v2 API with anonymous tokens, falling back to the GHCR pull secret's credentials.
import { config } from '../config.js';
import { R, request, resourcePath } from './client.js';

export interface ImageRef {
  registry: string;
  repository: string;
  reference: string; // tag or digest
}

export function parseImage(image: string): ImageRef {
  let rest = image.trim();
  let registry = 'registry-1.docker.io';
  const first = rest.split('/')[0];
  if (rest.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first === 'docker.io' ? 'registry-1.docker.io' : first;
    rest = rest.slice(first.length + 1);
  }
  let reference = 'latest';
  const at = rest.indexOf('@');
  if (at >= 0) {
    reference = rest.slice(at + 1);
    rest = rest.slice(0, at);
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon > rest.lastIndexOf('/')) {
      reference = rest.slice(colon + 1);
      rest = rest.slice(0, colon);
    }
  }
  if (registry === 'registry-1.docker.io' && !rest.includes('/')) rest = `library/${rest}`;
  return { registry, repository: rest, reference };
}

const IMAGE_RE = /^[a-z0-9]+([._\-/:@][a-zA-Z0-9_.\-]+)*$/;

export type ImageCheck = { status: 'found' | 'missing' | 'unverified' | 'invalid'; message: string };

async function registryCreds(registry: string): Promise<string | undefined> {
  try {
    const s = await request<any>('GET', resourcePath(R.secrets, config.selfNamespace, config.pullSecretName));
    const cfg = JSON.parse(Buffer.from(s.data?.['.dockerconfigjson'] ?? '', 'base64').toString('utf8'));
    const entry = cfg.auths?.[registry] ?? cfg.auths?.[`https://${registry}`];
    if (!entry) return undefined;
    return entry.auth ?? Buffer.from(`${entry.username}:${entry.password}`).toString('base64');
  } catch {
    return undefined;
  }
}

async function bearer(wwwAuth: string, basic?: string): Promise<string | undefined> {
  const params = Object.fromEntries([...wwwAuth.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  if (!params.realm) return undefined;
  const url = new URL(params.realm);
  if (params.service) url.searchParams.set('service', params.service);
  if (params.scope) url.searchParams.set('scope', params.scope);
  const res = await fetch(url, { headers: basic ? { Authorization: `Basic ${basic}` } : {}, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return undefined;
  const body: any = await res.json();
  return body.token ?? body.access_token;
}

export async function checkImage(image: string): Promise<ImageCheck> {
  if (!IMAGE_RE.test(image.trim())) return { status: 'invalid', message: `"${image}" is not a valid image reference (use lowercase, e.g. ghcr.io/owner/name:tag).` };
  const ref = parseImage(image);
  const url = `https://${ref.registry}/v2/${ref.repository}/manifests/${ref.reference}`;
  const accept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ].join(', ');
  try {
    let res = await fetch(url, { method: 'HEAD', headers: { Accept: accept }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401) {
      const challenge = res.headers.get('www-authenticate') ?? '';
      let token = await bearer(challenge);
      if (token) res = await fetch(url, { method: 'HEAD', headers: { Accept: accept, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 401 || res.status === 403) {
        const basic = await registryCreds(ref.registry);
        token = basic ? await bearer(challenge, basic) : undefined;
        if (token) res = await fetch(url, { method: 'HEAD', headers: { Accept: accept, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      }
    }
    if (res.ok) return { status: 'found', message: `Found ${ref.registry}/${ref.repository}:${ref.reference}` };
    if (res.status === 404) return { status: 'missing', message: `The registry has no image "${ref.repository}" with tag "${ref.reference}". Check for typos.` };
    if (res.status === 401 || res.status === 403) return { status: 'unverified', message: 'The image is private and the controller has no credentials for this registry; it may still pull if the namespace has a pull secret.' };
    return { status: 'unverified', message: `The registry answered HTTP ${res.status}; deploying anyway is possible.` };
  } catch (e) {
    return { status: 'unverified', message: `Could not reach ${ref.registry}: ${e instanceof Error ? e.message : e}` };
  }
}
