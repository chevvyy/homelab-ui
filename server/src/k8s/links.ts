// Linking app A to app B injects B's in-cluster address into A as <B>_URL and <B>_HOST, then
// rolls A (changing the pod template does that). The link list lives in an annotation on A.
import { ActionError, guardWrite, mutate, podTemplate, workloadType } from './actions.js';
import { appObjects } from './apps.js';
import type { KObject } from './client.js';
import { ANN_LINKS } from './labels.js';

export function envPrefix(target: string): string {
  return target.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function targetAddress(namespace: string, name: string) {
  const t = appObjects(namespace, name);
  if (!t) throw new ActionError(`App ${namespace}/${name} not found.`, 404);
  const svc = t.services[0];
  if (!svc) throw new ActionError(`${name} has no Service, so other apps cannot reach it. Give it a port first.`, 422);
  const port = svc.spec?.ports?.[0]?.port ?? 80;
  const host = `${svc.metadata.name}.${namespace}.svc.cluster.local`;
  return { host, url: `http://${host}${port === 80 ? '' : `:${port}`}`, port };
}

async function editLinks(namespace: string, app: string, edit: (links: string[], containersEnv: (fn: (env: any[]) => any[]) => void) => string[]) {
  guardWrite(namespace);
  const objs = appObjects(namespace, app);
  if (!objs) throw new ActionError('App not found.', 404);
  const workloads = objs.workloads.filter((w) => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(w.kind!));
  if (!workloads.length) throw new ActionError('Only Deployments, StatefulSets and DaemonSets can be linked.', 422);
  let result: string[] = [];
  for (const w of workloads) {
    await mutate(workloadType(w.kind!), namespace, w.metadata.name, (obj) => {
      let links: string[] = [];
      try {
        links = JSON.parse(obj.metadata.annotations?.[ANN_LINKS] ?? '[]');
      } catch {
        /* reset malformed */
      }
      const containers = podTemplate(obj).spec.containers as any[];
      result = edit(links, (fn) => {
        for (const c of containers) c.env = fn(c.env ?? []);
      });
      obj.metadata.annotations = { ...(obj.metadata.annotations ?? {}), [ANN_LINKS]: JSON.stringify(result) };
    });
  }
  return result;
}

export async function linkApps(namespace: string, app: string, target: { namespace: string; name: string }) {
  if (target.namespace === namespace && target.name === app) throw new ActionError('An app cannot link to itself.', 422);
  const addr = targetAddress(target.namespace, target.name);
  const prefix = envPrefix(target.name);
  const id = `${target.namespace}/${target.name}`;
  const links = await editLinks(namespace, app, (links, env) => {
    env((vars) => [
      ...vars.filter((v) => v.name !== `${prefix}_URL` && v.name !== `${prefix}_HOST` && v.name !== `${prefix}_PORT`),
      { name: `${prefix}_URL`, value: addr.url },
      { name: `${prefix}_HOST`, value: addr.host },
      { name: `${prefix}_PORT`, value: String(addr.port) },
    ]);
    return links.includes(id) ? links : [...links, id];
  });
  return { links, injected: [`${prefix}_URL=${addr.url}`, `${prefix}_HOST=${addr.host}`, `${prefix}_PORT=${addr.port}`] };
}

export async function unlinkApps(namespace: string, app: string, target: { namespace: string; name: string }) {
  const prefix = envPrefix(target.name);
  const id = `${target.namespace}/${target.name}`;
  const links = await editLinks(namespace, app, (links, env) => {
    env((vars) => vars.filter((v) => ![`${prefix}_URL`, `${prefix}_HOST`, `${prefix}_PORT`].includes(v.name)));
    return links.filter((l) => l !== id);
  });
  return { links };
}

// Re-applies the env vars of every current link to a workload object (used after a rollback
// restores an older pod template that predates some links).
export function reapplyLinkEnv(obj: KObject) {
  let links: string[] = [];
  try {
    links = JSON.parse(obj.metadata.annotations?.[ANN_LINKS] ?? '[]');
  } catch {
    return;
  }
  for (const id of links) {
    const [ns, name] = id.split('/');
    let addr: ReturnType<typeof targetAddress>;
    try {
      addr = targetAddress(ns, name);
    } catch {
      continue; // target gone; leave as is
    }
    const prefix = envPrefix(name);
    for (const c of podTemplate(obj).spec.containers as any[]) {
      c.env = [
        ...(c.env ?? []).filter((v: any) => ![`${prefix}_URL`, `${prefix}_HOST`, `${prefix}_PORT`].includes(v.name)),
        { name: `${prefix}_URL`, value: addr.url },
        { name: `${prefix}_HOST`, value: addr.host },
        { name: `${prefix}_PORT`, value: String(addr.port) },
      ];
    }
  }
}
