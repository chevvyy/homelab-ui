// Groups raw cluster objects into "apps": the unit the UI shows and acts on. Apps the controller
// deployed carry homelab.io/app; everything else is grouped by app.kubernetes.io/instance or by
// workload name, so existing apps in every namespace display too.
import { createHash } from 'node:crypto';
import { config, isProtectedNamespace } from '../config.js';
import { cache } from './cache.js';
import type { KObject } from './client.js';
import { ANN_LINKS, ANN_SOURCE, LABEL_APP, LABEL_EXPOSURE } from './labels.js';
import { Problem, podProblems, workloadProblems } from './status.js';

export type AppStatus = 'healthy' | 'progressing' | 'degraded' | 'failed' | 'stopped' | 'completed' | 'scheduled';
export type Exposure = 'public' | 'internal' | 'off';

export interface WorkloadSummary {
  kind: string;
  name: string;
  desired: number;
  ready: number;
  updated: number;
  images: string[];
  revision?: string;
}

export interface HostSummary {
  host: string;
  exposure: 'public' | 'internal' | 'other';
  via: 'Ingress' | 'IngressRoute';
  object: string;
  managed: boolean;
}

export interface AppSummary {
  id: string; // namespace/name
  namespace: string;
  name: string;
  managed: boolean;
  protected: boolean;
  workloads: WorkloadSummary[];
  images: string[];
  desired: number;
  ready: number;
  restarts: number;
  podCount: number;
  status: AppStatus;
  problems: Problem[];
  hosts: HostSummary[];
  exposure: Exposure;
  services: { name: string; ports: { port: number; name?: string; targetPort?: any }[] }[];
  pvcs: string[];
  links: string[]; // app ids this app links to
  linkedBy: string[];
  sourceType?: string;
  createdAt?: string;
  rev: string;
}

interface Group {
  namespace: string;
  name: string;
  managed: boolean;
  workloads: KObject[];
  pods: KObject[];
}

const WORKLOAD_KINDS = ['deployments', 'statefulsets', 'daemonsets', 'cronjobs', 'jobs'] as const;

function groupName(o: KObject): { name: string; managed: boolean } {
  const l = o.metadata.labels ?? {};
  if (l[LABEL_APP]) return { name: l[LABEL_APP], managed: true };
  return { name: l['app.kubernetes.io/instance'] ?? o.metadata.name, managed: false };
}

function selectorMatches(selector: Record<string, string> | undefined, labels: Record<string, string> | undefined): boolean {
  if (!selector || Object.keys(selector).length === 0) return false;
  return Object.entries(selector).every(([k, v]) => labels?.[k] === v);
}

export function hostExposure(host: string): HostSummary['exposure'] {
  if (host.endsWith(`.${config.internalDomain}`) || config.privateDomains.some((d) => host === d || host.endsWith(`.${d}`))) return 'internal';
  if (host === config.publicDomain || host.endsWith(`.${config.publicDomain}`)) return 'public';
  return 'other';
}

// Host -> backend services, per rule, so one shared Ingress with many hosts is split correctly.
function routeRules(route: KObject): { hosts: string[]; services: string[] }[] {
  if (route.kind === 'Ingress') {
    const rules = (route.spec?.rules ?? []).map((r: any) => ({
      hosts: r.host ? [r.host] : [],
      services: (r.http?.paths ?? []).map((p: any) => p.backend?.service?.name).filter(Boolean),
    }));
    const def = route.spec?.defaultBackend?.service?.name;
    if (def) for (const r of rules) if (!r.services.length) r.services.push(def);
    return rules;
  }
  return (route.spec?.routes ?? []).map((r: any) => ({
    hosts: [...String(r.match ?? '').matchAll(/Host\(`([^`]+)`\)/g)].map((m) => m[1]),
    services: (r.services ?? []).map((x: any) => x.name),
  }));
}

// Resolves a pod to its top-level workload (Pod -> ReplicaSet -> Deployment, Pod -> Job -> CronJob).
function topOwner(o: KObject, rsByName: Map<string, KObject>, jobsByName: Map<string, KObject>): { kind: string; name: string } | undefined {
  const ref = o.metadata.ownerReferences?.find((r) => r.controller) ?? o.metadata.ownerReferences?.[0];
  if (!ref) return undefined;
  const ns = o.metadata.namespace;
  if (ref.kind === 'ReplicaSet') {
    const rs = rsByName.get(`${ns}/${ref.name}`);
    const up = rs?.metadata.ownerReferences?.find((r) => r.kind === 'Deployment');
    return up ? { kind: 'Deployment', name: up.name } : { kind: 'ReplicaSet', name: ref.name };
  }
  if (ref.kind === 'Job') {
    const job = jobsByName.get(`${ns}/${ref.name}`);
    const up = job?.metadata.ownerReferences?.find((r) => r.kind === 'CronJob');
    return up ? { kind: 'CronJob', name: up.name } : { kind: 'Job', name: ref.name };
  }
  return { kind: ref.kind, name: ref.name };
}

function summarizeWorkload(w: KObject): WorkloadSummary {
  const s = w.status ?? {};
  const images = ((w.kind === 'CronJob' ? w.spec?.jobTemplate?.spec?.template : w.spec?.template)?.spec?.containers ?? []).map((c: any) => c.image);
  switch (w.kind) {
    case 'Deployment':
      return { kind: w.kind, name: w.metadata.name, desired: w.spec?.replicas ?? 1, ready: s.readyReplicas ?? 0, updated: s.updatedReplicas ?? 0, images, revision: w.metadata.annotations?.['deployment.kubernetes.io/revision'] };
    case 'StatefulSet':
      return { kind: w.kind, name: w.metadata.name, desired: w.spec?.replicas ?? 1, ready: s.readyReplicas ?? 0, updated: s.updatedReplicas ?? 0, images };
    case 'DaemonSet':
      return { kind: w.kind, name: w.metadata.name, desired: s.desiredNumberScheduled ?? 0, ready: s.numberReady ?? 0, updated: s.updatedNumberScheduled ?? 0, images };
    case 'Job':
      return { kind: w.kind, name: w.metadata.name, desired: w.spec?.completions ?? 1, ready: s.succeeded ?? 0, updated: 0, images };
    default:
      return { kind: w.kind ?? 'Unknown', name: w.metadata.name, desired: 0, ready: s.active?.length ?? 0, updated: 0, images };
  }
}

function hash(parts: string[]): string {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

let memo: { key: string; apps: AppSummary[] } | undefined;

export function buildApps(): AppSummary[] {
  const rsByName = new Map(cache.list('replicasets').map((o) => [`${o.metadata.namespace}/${o.metadata.name}`, o]));
  const jobsByName = new Map(cache.list('jobs').map((o) => [`${o.metadata.namespace}/${o.metadata.name}`, o]));
  const groups = new Map<string, Group>();
  const workloadToGroup = new Map<string, string>(); // "ns/Kind/name" -> group id

  const ensure = (ns: string, name: string, managed: boolean): Group => {
    const id = `${ns}/${name}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { namespace: ns, name, managed, workloads: [], pods: [] }));
    g.managed ||= managed;
    return g;
  };

  for (const key of WORKLOAD_KINDS) {
    for (const w of cache.list(key)) {
      // Jobs spawned by a CronJob belong to that CronJob's app.
      if (w.kind === 'Job' && w.metadata.ownerReferences?.some((r) => r.kind === 'CronJob')) continue;
      const ns = w.metadata.namespace!;
      const { name, managed } = groupName(w);
      const g = ensure(ns, name, managed);
      g.workloads.push(w);
      workloadToGroup.set(`${ns}/${w.kind}/${w.metadata.name}`, `${ns}/${name}`);
    }
  }
  for (const p of cache.list('pods')) {
    const ns = p.metadata.namespace!;
    const owner = topOwner(p, rsByName, jobsByName);
    const gid = owner ? workloadToGroup.get(`${ns}/${owner.kind}/${owner.name}`) : undefined;
    if (gid) groups.get(gid)!.pods.push(p);
    else if (!owner || owner.kind === 'Node') {
      // Bare and static pods show as their own app.
      const { name, managed } = groupName(p);
      ensure(ns, name, managed).pods.push(p);
    }
  }

  const services = cache.list('services');
  const routes = [...cache.list('ingresses'), ...cache.list('ingressroutes')];
  const events = cache.list('events');
  const eventsByObj = new Map<string, KObject[]>();
  for (const ev of events) {
    const io = ev.involvedObject ?? {};
    const k = `${io.namespace}/${io.kind}/${io.name}`;
    (eventsByObj.get(k) ?? eventsByObj.set(k, []).get(k)!).push(ev);
  }

  // Memoize on the resourceVersions involved; the WebSocket asks for apps on every change.
  const memoKey = hash([
    ...[...groups.values()].flatMap((g) => [...g.workloads, ...g.pods].map((o) => o.metadata.resourceVersion ?? '')),
    ...services.map((s) => s.metadata.resourceVersion ?? ''),
    ...routes.map((r) => r.metadata.resourceVersion ?? ''),
    ...[...rsByName.values()].map((r) => r.metadata.resourceVersion ?? ''),
    ...events.map((e) => e.metadata.resourceVersion ?? ''),
  ]);
  if (memo?.key === memoKey) return memo.apps;

  const apps: AppSummary[] = [];
  for (const g of groups.values()) {
    const id = `${g.namespace}/${g.name}`;
    const nsServices = services.filter((s) => s.metadata.namespace === g.namespace);
    const appServices = nsServices.filter(
      (s) => s.metadata.labels?.[LABEL_APP] === g.name || g.pods.some((p) => selectorMatches(s.spec?.selector, p.metadata.labels)) ||
        g.workloads.some((w) => selectorMatches(s.spec?.selector, (w.kind === 'CronJob' ? w.spec?.jobTemplate?.spec?.template : w.spec?.template)?.metadata?.labels)),
    );
    const svcNames = new Set(appServices.map((s) => s.metadata.name));
    const hosts: HostSummary[] = [];
    const appRoutes: KObject[] = [];
    for (const r of routes) {
      if (r.metadata.namespace !== g.namespace) continue;
      const own = r.metadata.labels?.[LABEL_APP] === g.name;
      const rules = routeRules(r).filter((rule) => own || rule.services.some((n) => svcNames.has(n)));
      if (!rules.length) continue;
      appRoutes.push(r);
      for (const host of new Set(rules.flatMap((rule) => rule.hosts))) {
        if (hosts.some((h) => h.host === host)) continue; // e.g. an https route plus its http redirect
        hosts.push({ host, exposure: hostExposure(host), via: r.kind as 'Ingress' | 'IngressRoute', object: r.metadata.name, managed: !!r.metadata.labels?.[LABEL_EXPOSURE] });
      }
    }
    const workloads = g.workloads.map(summarizeWorkload);
    const rsOfApp = g.workloads
      .filter((w) => w.kind === 'Deployment')
      .flatMap((d) => [...rsByName.values()].filter((rs) => rs.metadata.namespace === g.namespace && rs.metadata.ownerReferences?.some((r) => r.uid === d.metadata.uid)));
    const appEvents = [...g.workloads, ...rsOfApp, ...g.pods].flatMap((o) => eventsByObj.get(`${g.namespace}/${o.kind}/${o.metadata.name}`) ?? []);

    const problems: Problem[] = [];
    // Old ReplicaSets (scaled to 0) keep stale failure conditions forever; only live ones count.
    const liveRs = rsOfApp.filter((rs) => (rs.spec?.replicas ?? 0) > 0);
    for (const w of g.workloads) problems.push(...workloadProblems(w, liveRs, appEvents));
    for (const p of g.pods) if (!p.metadata.deletionTimestamp) problems.push(...podProblems(p));

    const desired = workloads.reduce((n, w) => n + (w.kind === 'CronJob' ? 0 : w.desired), 0) || (workloads.length ? 0 : g.pods.length);
    const ready = workloads.length
      ? workloads.reduce((n, w) => n + (w.kind === 'CronJob' ? 0 : w.ready), 0)
      : g.pods.filter((p) => p.status?.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True')).length;
    const restarts = g.pods.reduce((n, p) => n + (p.status?.containerStatuses ?? []).reduce((m: number, c: any) => m + (c.restartCount ?? 0), 0), 0);
    const onlyCron = workloads.length > 0 && workloads.every((w) => w.kind === 'CronJob');
    const onlyJobs = workloads.length > 0 && workloads.every((w) => w.kind === 'Job');
    const barePodsDone = !workloads.length && g.pods.length > 0 && g.pods.every((p) => ['Succeeded', 'Failed'].includes(p.status?.phase));
    const updating = g.workloads.some(
      (w) => (w.status?.observedGeneration ?? 0) < (w.metadata.generation ?? 0) || (w.kind !== 'Job' && w.kind !== 'CronJob' && (w.status?.updatedReplicas ?? w.status?.updatedNumberScheduled ?? 0) < (w.spec?.replicas ?? w.status?.desiredNumberScheduled ?? 0)),
    );

    let status: AppStatus;
    if (problems.some((p) => p.severity === 'error') || (problems.length && ready < desired)) status = ready > 0 ? 'degraded' : 'failed';
    else if (onlyCron) status = 'scheduled';
    else if (barePodsDone) status = 'completed';
    else if (onlyJobs) status = workloads.every((w) => w.ready >= w.desired) ? 'completed' : 'progressing';
    else if (desired === 0) status = 'stopped';
    else if (updating || ready < desired) status = 'progressing';
    else status = 'healthy';

    const primary = g.workloads[0];
    let links: string[] = [];
    try {
      links = JSON.parse(primary?.metadata.annotations?.[ANN_LINKS] ?? '[]');
    } catch {
      /* ignore malformed */
    }
    let sourceType: string | undefined;
    try {
      sourceType = JSON.parse(primary?.metadata.annotations?.[ANN_SOURCE] ?? 'null')?.type;
    } catch {
      /* ignore */
    }
    const managedHosts = hosts.filter((h) => h.managed);
    const exposure: Exposure = managedHosts.some((h) => h.exposure === 'public') ? 'public' : managedHosts.some((h) => h.exposure === 'internal') ? 'internal' : 'off';
    const pvcs = [...new Set(g.pods.flatMap((p) => (p.spec?.volumes ?? []).map((v: any) => v.persistentVolumeClaim?.claimName).filter(Boolean)))] as string[];

    const created = [...g.workloads, ...g.pods].map((o) => o.metadata.creationTimestamp).filter(Boolean).sort()[0];
    apps.push({
      id,
      namespace: g.namespace,
      name: g.name,
      managed: g.managed,
      protected: isProtectedNamespace(g.namespace),
      workloads,
      images: [...new Set(workloads.flatMap((w) => w.images))],
      desired,
      ready,
      restarts,
      podCount: g.pods.length,
      status,
      problems,
      hosts,
      exposure,
      services: appServices.map((s) => ({ name: s.metadata.name, ports: (s.spec?.ports ?? []).map((p: any) => ({ port: p.port, name: p.name, targetPort: p.targetPort })) })),
      pvcs,
      links,
      linkedBy: [],
      sourceType,
      createdAt: created,
      rev: hash([...g.workloads, ...rsOfApp, ...g.pods, ...appServices, ...appRoutes, ...appEvents].map((o) => o.metadata.resourceVersion ?? '')),
    });
  }
  const byId = new Map(apps.map((a) => [a.id, a]));
  for (const a of apps) for (const target of a.links) byId.get(target)?.linkedBy.push(a.id);
  apps.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
  memo = { key: memoKey, apps };
  return apps;
}

export function findApp(namespace: string, name: string): AppSummary | undefined {
  return buildApps().find((a) => a.namespace === namespace && a.name === name);
}

// All raw objects that belong to an app, for the detail page and for label-based actions.
export function appObjects(namespace: string, name: string) {
  const app = findApp(namespace, name);
  if (!app) return undefined;
  const wl = new Set(app.workloads.map((w) => `${w.kind}/${w.name}`));
  const workloads = WORKLOAD_KINDS.flatMap((k) => cache.list(k, namespace)).filter((o) => wl.has(`${o.kind}/${o.metadata.name}`));
  const deployUids = new Set(workloads.filter((w) => w.kind === 'Deployment').map((w) => w.metadata.uid));
  const replicaSets = cache.list('replicasets', namespace).filter((rs) => rs.metadata.ownerReferences?.some((r) => deployUids.has(r.uid)));
  const rsNames = new Set(replicaSets.map((r) => r.metadata.name));
  const ownerNames = new Set([...app.workloads.map((w) => w.name), ...rsNames]);
  const jobs = cache.list('jobs', namespace).filter((j) => j.metadata.ownerReferences?.some((r) => ownerNames.has(r.name)));
  for (const j of jobs) ownerNames.add(j.metadata.name);
  const pods = cache.list('pods', namespace).filter(
    (p) => p.metadata.ownerReferences?.some((r) => ownerNames.has(r.name)) || (!p.metadata.ownerReferences?.length && groupName(p).name === name),
  );
  const objNames = new Set([...workloads, ...replicaSets, ...pods].map((o) => `${o.kind}/${o.metadata.name}`));
  const events = cache
    .list('events', namespace)
    .filter((e) => objNames.has(`${e.involvedObject?.kind}/${e.involvedObject?.name}`))
    .sort((a, b) => Date.parse(b.lastTimestamp ?? b.eventTime ?? '') - Date.parse(a.lastTimestamp ?? a.eventTime ?? ''));
  const svcNames = new Set(app.services.map((s) => s.name));
  const services = cache.list('services', namespace).filter((s) => svcNames.has(s.metadata.name));
  const routeNames = new Set(app.hosts.map((h) => `${h.via}/${h.object}`));
  const routes = [...cache.list('ingresses', namespace), ...cache.list('ingressroutes', namespace)].filter((r) => routeNames.has(`${r.kind}/${r.metadata.name}`) || r.metadata.labels?.[LABEL_APP] === name);
  const pvcs = cache.list('pvcs', namespace).filter((p) => app.pvcs.includes(p.metadata.name) || p.metadata.labels?.[LABEL_APP] === name);
  return { app, workloads, replicaSets, pods, events, services, routes, pvcs };
}
