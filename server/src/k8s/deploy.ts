// Deploys apps from YAML or an image reference. Everything goes through server-side apply with
// a fixed field manager, after a server-side dry run the UI shows as a preview.
import { loadAll } from 'js-yaml';
import { config } from '../config.js';
import { guardWrite } from './actions.js';
import { cache } from './cache.js';
import { FIELD_MANAGER, K8sError, KObject, request, resolveKind, resourcePath } from './client.js';
import { ANN_SOURCE, AppSource, LABEL_APP, managedLabels, NAME_RE } from './labels.js';
import { ensurePullSecret } from './pullsecret.js';
import { apiErrorProblem, Problem } from './status.js';

export interface PlanItem {
  kind: string;
  name: string;
  namespace?: string;
  action?: 'create' | 'update' | 'unchanged';
  problem?: Problem;
}

export interface DeployResult {
  ok: boolean;
  dryRun: boolean;
  app: string;
  namespace: string;
  items: PlanItem[];
  warnings: string[];
}

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob']);
const ORDER = ['Namespace', 'ServiceAccount', 'Secret', 'ConfigMap', 'PersistentVolumeClaim', 'Service', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Middleware', 'Ingress', 'IngressRoute'];
const MAX_SOURCE_BYTES = 120_000;

export function validateName(name: string, what = 'App name') {
  if (!NAME_RE.test(name)) throw new K8sError(422, 'Invalid', `${what} "${name}" must be lowercase letters, digits and dashes, start and end with a letter or digit, and be at most 53 characters.`);
}

export function parseYaml(text: string): KObject[] {
  let docs: unknown[];
  try {
    docs = loadAll(text) as unknown[];
  } catch (e) {
    throw new K8sError(422, 'Invalid', `The YAML could not be parsed: ${e instanceof Error ? e.message : e}`);
  }
  const out: KObject[] = [];
  for (const d of docs) {
    if (!d || typeof d !== 'object') continue;
    const o = d as KObject;
    if (o.kind === 'List' && Array.isArray(o.items)) out.push(...o.items);
    else out.push(o);
  }
  if (!out.length) throw new K8sError(422, 'Invalid', 'The YAML contains no Kubernetes objects.');
  for (const [i, o] of out.entries()) {
    if (!o.apiVersion || !o.kind || !o.metadata?.name) {
      throw new K8sError(422, 'Invalid', `Document ${i + 1} is missing apiVersion, kind or metadata.name.`);
    }
  }
  return out;
}

function sourceAnnotation(source: AppSource): string {
  const s = JSON.stringify(source);
  if (s.length <= MAX_SOURCE_BYTES) return s;
  return JSON.stringify({ ...source, yaml: undefined, truncated: true });
}

// Adds the app labels everywhere (object and pod template) and fills in the namespace.
async function prepare(objects: KObject[], app: string, namespace: string, source: AppSource): Promise<{ prepared: { obj: KObject; namespaced: boolean; plural: string; path: string }[]; warnings: string[] }> {
  const warnings: string[] = [];
  const prepared = [];
  for (const raw of objects) {
    const obj: KObject = structuredClone(raw);
    const rt = await resolveKind(obj.apiVersion!, obj.kind!);
    obj.metadata.labels = { ...(obj.metadata.labels ?? {}), ...managedLabels(app) };
    if (rt.namespaced) {
      if (obj.metadata.namespace && obj.metadata.namespace !== namespace) {
        warnings.push(`${obj.kind}/${obj.metadata.name} asked for namespace "${obj.metadata.namespace}"; deploying it to "${namespace}" instead.`);
      }
      obj.metadata.namespace = namespace;
    } else {
      warnings.push(`${obj.kind}/${obj.metadata.name} is cluster-scoped; the controller will likely not be allowed to create it.`);
    }
    if (WORKLOAD_KINDS.has(obj.kind!)) {
      const tpl = obj.kind === 'CronJob' ? obj.spec?.jobTemplate?.spec?.template : obj.spec?.template;
      if (tpl) {
        tpl.metadata = tpl.metadata ?? {};
        tpl.metadata.labels = { ...(tpl.metadata.labels ?? {}), [LABEL_APP]: app };
      }
      obj.metadata.annotations = { ...(obj.metadata.annotations ?? {}), [ANN_SOURCE]: sourceAnnotation(source) };
      if (obj.kind === 'Deployment' && obj.spec && obj.spec.progressDeadlineSeconds === undefined) obj.spec.progressDeadlineSeconds = 300;
    }
    delete obj.metadata.resourceVersion;
    delete obj.metadata.uid;
    delete obj.metadata.creationTimestamp;
    delete obj.metadata.managedFields;
    delete obj.status;
    prepared.push({ obj, namespaced: rt.namespaced, plural: rt.plural, path: resourcePath(rt, rt.namespaced ? namespace : undefined, obj.metadata.name) });
  }
  prepared.sort((a, b) => rank(a.obj.kind!) - rank(b.obj.kind!));
  return { prepared, warnings };
}

function rank(kind: string): number {
  const i = ORDER.indexOf(kind);
  return i < 0 ? ORDER.length : i;
}

export async function applyObjects(app: string, namespace: string, objects: KObject[], source: AppSource, dryRun: boolean): Promise<DeployResult> {
  validateName(app);
  validateName(namespace, 'Namespace');
  guardWrite(namespace);
  const { prepared, warnings } = await prepare(objects, app, namespace, source);
  // Another app already owning one of these names would get silently merged into this one.
  for (const p of prepared) {
    const existing = await request<KObject>('GET', p.path).catch(() => undefined);
    const owner = existing?.metadata.labels?.[LABEL_APP];
    if (owner && owner !== app) throw new K8sError(409, 'Conflict', `${p.obj.kind}/${p.obj.metadata.name} already belongs to app "${owner}". Rename it or delete that app first.`);
  }
  if (!dryRun) {
    const ps = await ensurePullSecret(namespace);
    if (!ps.ok && ps.message) warnings.push(ps.message);
  }
  const items: PlanItem[] = [];
  let ok = true;
  for (const p of prepared) {
    const item: PlanItem = { kind: p.obj.kind!, name: p.obj.metadata.name, namespace: p.namespaced ? namespace : undefined };
    try {
      const before = await request<KObject>('GET', p.path).catch((e) => {
        if (e instanceof K8sError && e.status === 404) return undefined;
        throw e;
      });
      const after = await request<KObject>('PATCH', p.path, {
        contentType: 'application/apply-patch+yaml',
        query: { fieldManager: FIELD_MANAGER, force: true, dryRun: dryRun ? 'All' : undefined },
        body: p.obj,
      });
      item.action = !before ? 'create' : before.metadata.resourceVersion === after.metadata.resourceVersion ? 'unchanged' : 'update';
    } catch (e) {
      ok = false;
      item.problem = e instanceof K8sError ? apiErrorProblem(e.status, e.reason, e.message) : apiErrorProblem(500, 'Error', String(e));
    }
    items.push(item);
  }
  return { ok, dryRun, app, namespace, items, warnings };
}

export async function deployYaml(opts: { app: string; namespace?: string; yaml: string; dryRun: boolean; source?: AppSource }): Promise<DeployResult> {
  const objects = parseYaml(opts.yaml);
  return applyObjects(opts.app, opts.namespace || config.appsNamespace, objects, opts.source ?? { type: 'yaml', yaml: opts.yaml }, opts.dryRun);
}

export interface ImageSpec {
  app: string;
  namespace?: string;
  image: string;
  port?: number;
  replicas?: number;
  env?: Record<string, string>;
  volume?: { size: string; mountPath: string; storageClass?: string };
  cpuRequest?: string;
  runAsUser?: number;
  memoryRequest?: string;
  memoryLimit?: string;
  command?: string[];
}

// Namespaces enforcing the "restricted" Pod Security profile reject pods without these fields.
function restrictedNamespace(namespace: string): boolean {
  return cache.get('namespaces', undefined, namespace)?.metadata.labels?.['pod-security.kubernetes.io/enforce'] === 'restricted';
}

export function imageManifests(spec: ImageSpec, harden = false): KObject[] {
  const app = spec.app;
  const labels = { [LABEL_APP]: app };
  const container: any = {
    name: app,
    image: spec.image.trim(),
    env: Object.entries(spec.env ?? {}).map(([name, value]) => ({ name, value })),
    resources: {
      requests: { cpu: spec.cpuRequest || '50m', memory: spec.memoryRequest || '128Mi' },
      limits: { memory: spec.memoryLimit || '1Gi' },
    },
  };
  if (spec.command?.length) container.command = spec.command;
  if (harden) {
    container.securityContext = { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, runAsNonRoot: true, runAsUser: spec.runAsUser ?? 65532, seccompProfile: { type: 'RuntimeDefault' } };
  } else if (spec.runAsUser !== undefined) {
    container.securityContext = { runAsUser: spec.runAsUser };
  }
  if (spec.port) {
    container.ports = [{ name: 'http', containerPort: spec.port }];
    container.readinessProbe = { tcpSocket: { port: spec.port }, initialDelaySeconds: 3, periodSeconds: 10 };
  }
  const objs: KObject[] = [];
  if (spec.volume) {
    const storageClass = spec.volume.storageClass || config.storageClass;
    objs.push({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: `${app}-data` },
      spec: {
        accessModes: [storageClass === config.dbStorageClass ? 'ReadWriteOnce' : 'ReadWriteMany'],
        storageClassName: storageClass,
        resources: { requests: { storage: spec.volume.size || '1Gi' } },
      },
    });
    container.volumeMounts = [{ name: 'data', mountPath: spec.volume.mountPath || '/data' }];
  }
  objs.push({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: app },
    spec: {
      replicas: spec.replicas ?? 1,
      revisionHistoryLimit: 5,
      progressDeadlineSeconds: 300,
      // A volume can only be attached cleanly by one version at a time.
      strategy: spec.volume ? { type: 'Recreate' } : { type: 'RollingUpdate' },
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          containers: [container],
          ...(spec.volume ? { volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `${app}-data` } }] } : {}),
        },
      },
    },
  });
  if (spec.port) {
    objs.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: app },
      spec: { selector: labels, ports: [{ name: 'http', port: 80, targetPort: spec.port }] },
    });
  }
  return objs;
}

export async function deployImage(spec: ImageSpec, dryRun: boolean, sourceOverride?: AppSource): Promise<DeployResult> {
  validateName(spec.app);
  if (spec.port !== undefined && (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535)) throw new K8sError(422, 'Invalid', 'Port must be between 1 and 65535.');
  const source: AppSource = sourceOverride ?? {
    type: 'image',
    image: spec.image,
    port: spec.port,
    replicas: spec.replicas ?? 1,
    env: spec.env ?? {},
    volume: spec.volume ? { size: spec.volume.size, mountPath: spec.volume.mountPath, storageClass: spec.volume.storageClass || config.storageClass } : undefined,
  };
  const namespace = spec.namespace || config.appsNamespace;
  return applyObjects(spec.app, namespace, imageManifests(spec, restrictedNamespace(namespace)), source, dryRun);
}
