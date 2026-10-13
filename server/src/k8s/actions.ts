// Day-2 actions on existing apps: restart, scale, env edits, rollback, delete, logs.
import { isProtectedNamespace } from '../config.js';
import { appObjects } from './apps.js';
import { K8sError, KObject, R, ResourceKey, ResourceType, request, resourcePath, streamLines } from './client.js';
import { ANN_RESTARTED, LABEL_APP } from './labels.js';

export class ActionError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function guardWrite(namespace: string) {
  if (isProtectedNamespace(namespace)) {
    throw new ActionError(`"${namespace}" is a system namespace. The controller only views it; use Rancher or kubectl for changes there.`, 403);
  }
}

const KIND_TO_KEY: Record<string, ResourceKey> = {
  Deployment: 'deployments',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
  CronJob: 'cronjobs',
  Job: 'jobs',
};

export function workloadType(kind: string): ResourceType {
  const key = KIND_TO_KEY[kind];
  if (!key) throw new ActionError(`Unsupported workload kind "${kind}"`);
  return R[key];
}

// Read-modify-write with optimistic concurrency; retries when someone else wrote in between.
// Sent as a JSON patch guarded by a resourceVersion test, so it needs only the "patch" verb
// (all the controller has outside its own namespaces). A failed test returns 409/422.
export async function mutate(rt: ResourceType, namespace: string, name: string, fn: (obj: KObject) => void | Promise<void>): Promise<KObject> {
  for (let attempt = 0; ; attempt++) {
    const obj = await request<KObject>('GET', resourcePath(rt, namespace, name));
    const rv = obj.metadata.resourceVersion;
    await fn(obj);
    try {
      return await request<KObject>('PATCH', resourcePath(rt, namespace, name), {
        contentType: 'application/json-patch+json',
        body: [
          { op: 'test', path: '/metadata/resourceVersion', value: rv },
          { op: 'replace', path: '/spec', value: obj.spec },
          { op: 'add', path: '/metadata/annotations', value: obj.metadata.annotations ?? {} },
        ],
      });
    } catch (e) {
      const raced = e instanceof K8sError && (e.status === 409 || (e.status === 422 && /test operation/i.test(e.message)));
      if (raced && attempt < 3) continue;
      throw e;
    }
  }
}

export function podTemplate(obj: KObject): any {
  return obj.kind === 'CronJob' ? obj.spec.jobTemplate.spec.template : obj.spec.template;
}

export async function restartWorkload(namespace: string, kind: string, name: string) {
  guardWrite(namespace);
  if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(kind)) throw new ActionError(`${kind} cannot be restarted; delete its pods instead.`);
  await request('PATCH', resourcePath(workloadType(kind), namespace, name), {
    contentType: 'application/strategic-merge-patch+json',
    body: { spec: { template: { metadata: { annotations: { [ANN_RESTARTED]: new Date().toISOString() } } } } },
  });
}

export async function scaleWorkload(namespace: string, kind: string, name: string, replicas: number) {
  guardWrite(namespace);
  if (!['Deployment', 'StatefulSet'].includes(kind)) throw new ActionError(`${kind} cannot be scaled.`);
  if (!Number.isInteger(replicas) || replicas < 0 || replicas > 50) throw new ActionError('Replicas must be a whole number from 0 to 50.');
  await request('PATCH', resourcePath(workloadType(kind), namespace, name, 'scale'), {
    contentType: 'application/merge-patch+json',
    body: { spec: { replicas } },
  });
}

export async function suspendCronJob(namespace: string, name: string, suspend: boolean) {
  guardWrite(namespace);
  await request('PATCH', resourcePath(R.cronjobs, namespace, name), { contentType: 'application/merge-patch+json', body: { spec: { suspend } } });
}

export interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: unknown;
}

const ENV_NAME = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/;

export async function setEnv(namespace: string, kind: string, name: string, container: string, env: EnvVar[]) {
  guardWrite(namespace);
  for (const e of env) if (!ENV_NAME.test(e.name)) throw new ActionError(`"${e.name}" is not a valid environment variable name.`);
  await mutate(workloadType(kind), namespace, name, (obj) => {
    const c = podTemplate(obj).spec.containers.find((x: any) => x.name === container);
    if (!c) throw new ActionError(`Container "${container}" not found.`, 404);
    c.env = env.map((e) => (e.valueFrom ? { name: e.name, valueFrom: e.valueFrom } : { name: e.name, value: e.value ?? '' }));
  });
}

// Rolls a Deployment back to the ReplicaSet before the current one (or a given revision).
export async function rollbackDeployment(namespace: string, name: string, toRevision?: number, fixup?: (obj: KObject) => void) {
  guardWrite(namespace);
  const dep = await request<KObject>('GET', resourcePath(R.deployments, namespace, name));
  const rsList = await request<any>('GET', resourcePath(R.replicasets, namespace), { query: { labelSelector: selectorString(dep.spec.selector.matchLabels) } });
  const owned: KObject[] = (rsList.items ?? []).filter((rs: KObject) => rs.metadata.ownerReferences?.some((r) => r.uid === dep.metadata.uid));
  const rev = (rs: KObject) => Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
  owned.sort((a, b) => rev(b) - rev(a));
  const current = Number(dep.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
  const target = toRevision ? owned.find((rs) => rev(rs) === toRevision) : owned.find((rs) => rev(rs) < current);
  if (!target) throw new ActionError('There is no previous version to roll back to.', 404);
  await mutate(R.deployments, namespace, name, (obj) => {
    const tpl = structuredClone(target.spec.template);
    delete tpl.metadata?.labels?.['pod-template-hash'];
    obj.spec.template = tpl;
    fixup?.(obj);
  });
  return { revision: rev(target) };
}

export function revisions(namespace: string, name: string) {
  const objs = appObjects(namespace, name);
  return (objs?.replicaSets ?? [])
    .map((rs) => ({
      revision: Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0),
      name: rs.metadata.name,
      images: (rs.spec?.template?.spec?.containers ?? []).map((c: any) => c.image),
      created: rs.metadata.creationTimestamp,
      replicas: rs.status?.replicas ?? 0,
    }))
    .sort((a, b) => b.revision - a.revision);
}

function selectorString(labels: Record<string, string> = {}): string {
  return Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
}

const DELETE_ORDER: ResourceKey[] = ['ingressroutes', 'ingresses', 'middlewares', 'cronjobs', 'jobs', 'deployments', 'statefulsets', 'daemonsets', 'services', 'configmaps', 'secrets', 'serviceaccounts', 'pvcs'];

// Deletes everything belonging to an app. Managed apps: every object carrying the app label.
// Unmanaged apps: the workloads, services and routes the UI attributes to them.
export async function deleteApp(namespace: string, name: string, keepVolumes: boolean) {
  guardWrite(namespace);
  const objs = appObjects(namespace, name);
  if (!objs) throw new ActionError('App not found.', 404);
  const targets: { rt: ResourceType; name: string }[] = [];
  if (objs.app.managed) {
    for (const key of DELETE_ORDER) {
      if (key === 'pvcs' && keepVolumes) continue;
      const list = await request<any>('GET', resourcePath(R[key], namespace), { query: { labelSelector: `${LABEL_APP}=${name}` } }).catch((e) => {
        if (e instanceof K8sError && (e.status === 404 || e.status === 403)) return { items: [] };
        throw e;
      });
      for (const item of list.items ?? []) targets.push({ rt: R[key], name: item.metadata.name });
    }
  } else {
    for (const r of objs.routes) targets.push({ rt: r.kind === 'Ingress' ? R.ingresses : R.ingressroutes, name: r.metadata.name });
    for (const w of objs.workloads) targets.push({ rt: workloadType(w.kind!), name: w.metadata.name });
    for (const s of objs.services) targets.push({ rt: R.services, name: s.metadata.name });
    if (!keepVolumes) for (const p of objs.pvcs) targets.push({ rt: R.pvcs, name: p.metadata.name });
  }
  const deleted: string[] = [];
  for (const t of targets) {
    try {
      await request('DELETE', resourcePath(t.rt, namespace, t.name), { body: { propagationPolicy: 'Background' } });
      deleted.push(`${t.rt.kind}/${t.name}`);
    } catch (e) {
      if (!(e instanceof K8sError && e.status === 404)) throw e;
    }
  }
  // linkedBy: apps whose injected env vars now point at a Service that is gone.
  return { deleted, linkedBy: objs.app.linkedBy };
}

export async function deletePod(namespace: string, name: string) {
  guardWrite(namespace);
  await request('DELETE', resourcePath(R.pods, namespace, name));
}

export async function podLogs(namespace: string, pod: string, container: string | undefined, tailLines: number, previous = false): Promise<string> {
  try {
    return await request<string>('GET', resourcePath(R.pods, namespace, pod, 'log'), { query: { container, tailLines, previous, timestamps: false } });
  } catch (e) {
    if (e instanceof K8sError && e.status === 400 && previous) return '';
    throw e;
  }
}

export function followLogs(namespace: string, pod: string, container: string | undefined, onLine: (l: string) => void, signal: AbortSignal) {
  return streamLines(resourcePath(R.pods, namespace, pod, 'log'), { container, follow: true, tailLines: 200, timestamps: true }, onLine, signal);
}

