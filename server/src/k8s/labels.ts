// Labels and annotations the controller puts on everything it creates. The cluster stays the
// source of truth: an app is whatever carries LABEL_APP, so a controller restart loses nothing.
export const LABEL_APP = 'homelab.io/app';
export const LABEL_MANAGED = 'homelab.io/managed';
export const LABEL_EXPOSURE = 'homelab.io/exposure'; // on the IngressRoute: internal | public
export const ANN_SOURCE = 'homelab.io/source'; // JSON: how the app was deployed
export const ANN_LINKS = 'homelab.io/links'; // JSON: ["ns/app", ...] this app links to
export const ANN_RESTARTED = 'homelab.io/restartedAt';

export const NAME_RE = /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/;

export function managedLabels(app: string): Record<string, string> {
  return { [LABEL_APP]: app, [LABEL_MANAGED]: 'true' };
}

export type AppSource =
  | { type: 'yaml'; yaml: string }
  | { type: 'image'; image: string; port?: number; replicas: number; env: Record<string, string>; volume?: { size: string; mountPath: string; storageClass: string } }
  | { type: 'github'; repo: string; branch: string; sha: string; mode: 'manifests' | 'dockerfile'; path?: string; image?: string };
