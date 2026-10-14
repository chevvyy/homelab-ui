// REST API. Live state arrives over the WebSocket; these routes serve detail views and actions.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { audit, recentAudit } from './db.js';
import { deployFromGitHub, getBuild, GitHubError, inspect, listBuilds } from './github.js';
import {
  ActionError,
  deleteApp,
  deletePod,
  podLogs,
  restartWorkload,
  revisions,
  rollbackDeployment,
  scaleWorkload,
  setEnv,
  suspendCronJob,
} from './k8s/actions.js';
import { appObjects, buildApps } from './k8s/apps.js';
import { cache } from './k8s/cache.js';
import { K8sError } from './k8s/client.js';
import { deployImage, deployYaml } from './k8s/deploy.js';
import { checkHost, defaultHost, setExposure } from './k8s/exposure.js';
import { linkApps, reapplyLinkEnv, unlinkApps } from './k8s/links.js';
import { metrics } from './k8s/nodes.js';
import { checkImage } from './k8s/registry.js';
import { apiErrorProblem, Problem } from './k8s/status.js';
import { readSecret, writeSecret } from './secrets.js';
import { proxmox } from './systems/proxmox.js';
import { truenas } from './systems/truenas.js';

type Req = FastifyRequest & { user: { login: string } };

export function errorProblem(e: unknown): { status: number; problem: Problem } {
  if (e instanceof K8sError) return { status: e.status >= 400 && e.status < 600 ? e.status : 500, problem: apiErrorProblem(e.status, e.reason, e.message) };
  if (e instanceof ActionError || e instanceof GitHubError) return { status: e.status, problem: { severity: 'error', title: e.message, cause: '', fix: '' } };
  const err = e as any;
  const status = typeof err?.status === 'number' ? err.status : 500;
  return { status, problem: { severity: 'error', title: err?.message ?? String(e), cause: '', fix: '' } };
}

// Wraps an action: records it in the audit log and turns errors into plain-language problems.
function act<P>(action: string, target: (req: Req) => string, fn: (req: Req, body: P) => Promise<unknown>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const req = request as Req;
    const t = target(req);
    try {
      const result = await fn(req, (req.body ?? {}) as P);
      audit(req.user.login, action, t, true, req.body);
      return result ?? { ok: true };
    } catch (e) {
      const { status, problem } = errorProblem(e);
      audit(req.user.login, action, t, false, problem.title);
      return reply.code(status).send({ error: problem });
    }
  };
}

type P = { namespace: string; name: string };

export function registerRoutes(app: FastifyInstance) {
  app.get('/api/me', async (req) => ({ user: (req as Req).user, config: { appsNamespace: config.appsNamespace, publicDomain: config.publicDomain, internalDomain: config.internalDomain, storageClass: config.storageClass, dbStorageClass: config.dbStorageClass, githubOwner: config.githubOwner, links: config.links } }));

  app.get('/api/health', async () => ({
    namespaces: cache.list('namespaces').map((n) => n.metadata.name),
    watch: cache.states(),
    metrics: metrics.available,
    proxmox: { configured: proxmox.state.configured, connected: proxmox.state.connected, error: proxmox.state.error },
    truenas: { configured: truenas.state.configured, connected: truenas.state.connected, error: truenas.state.error },
  }));

  app.get('/api/apps', async () => buildApps());

  // ---- App detail and day-2 actions -----------------------------------------------------------
  app.get('/api/apps/:namespace/:name', async (req, reply) => {
    const { namespace, name } = req.params as P;
    const objs = appObjects(namespace, name);
    if (!objs) return reply.code(404).send({ error: { title: 'App not found' } });
    // Crashing containers: attach their last 20 log lines from the previous run.
    const crashLogs: Record<string, string> = {};
    for (const p of objs.app.problems.filter((x) => x.wantsLogs && x.pod && x.container).slice(0, 3)) {
      // The crashed run is either the current (terminated) container or the previous one.
      const usable = (t: unknown) => (typeof t === 'string' && t.trim() && !t.startsWith('unable to retrieve container logs') ? t : '');
      crashLogs[`${p.pod}/${p.container}`] =
        usable(await podLogs(namespace, p.pod!, p.container, 20).catch(() => '')) || usable(await podLogs(namespace, p.pod!, p.container, 20, true).catch(() => ''));
    }
    return {
      ...objs,
      podMetrics: Object.fromEntries(objs.pods.map((p) => [p.metadata.name, metrics.pods.get(`${namespace}/${p.metadata.name}`)])),
      revisions: revisions(namespace, name),
      crashLogs,
      history: recentAudit(`${namespace}/${name}`, 30),
    };
  });

  app.post('/api/apps/:namespace/:name/restart', act<{ kind: string; workload: string }>('restart', (r) => appId(r), async (req, b) => {
    const { namespace } = req.params as P;
    await restartWorkload(namespace, b.kind, b.workload);
  }));

  app.post('/api/apps/:namespace/:name/scale', act<{ kind: string; workload: string; replicas: number }>('scale', (r) => appId(r), async (req, b) => {
    const { namespace } = req.params as P;
    await scaleWorkload(namespace, b.kind, b.workload, Number(b.replicas));
  }));

  app.post('/api/apps/:namespace/:name/suspend', act<{ workload: string; suspend: boolean }>('suspend', (r) => appId(r), async (req, b) => {
    const { namespace } = req.params as P;
    await suspendCronJob(namespace, b.workload, !!b.suspend);
  }));

  app.post('/api/apps/:namespace/:name/env', act<{ kind: string; workload: string; container: string; env: { name: string; value?: string; valueFrom?: unknown }[] }>('env', (r) => appId(r), async (req, b) => {
    const { namespace } = req.params as P;
    await setEnv(namespace, b.kind, b.workload, b.container, b.env ?? []);
  }));

  app.post('/api/apps/:namespace/:name/rollback', act<{ workload: string; revision?: number }>('rollback', (r) => appId(r), async (req, b) => {
    const { namespace } = req.params as P;
    return rollbackDeployment(namespace, b.workload, b.revision, reapplyLinkEnv);
  }));

  app.delete('/api/apps/:namespace/:name', act<unknown>('delete', (r) => appId(r), async (req) => {
    const { namespace, name } = req.params as P;
    const keep = (req.query as any).keepVolumes !== 'false';
    return deleteApp(namespace, name, keep);
  }));

  app.post('/api/apps/:namespace/:name/exposure', act<{ mode: 'off' | 'internal' | 'public'; host?: string; service?: string; port?: number }>('exposure', (r) => appId(r), async (req, b) => {
    const { namespace, name } = req.params as P;
    if (!['off', 'internal', 'public'].includes(b.mode)) throw new ActionError('mode must be off, internal or public');
    return setExposure(namespace, name, b.mode, { host: b.host, service: b.service, port: b.port });
  }));

  app.post('/api/apps/:namespace/:name/links', act<{ target: string; action: 'link' | 'unlink' }>('link', (r) => appId(r), async (req, b) => {
    const { namespace, name } = req.params as P;
    const [tns, tname] = String(b.target ?? '').split('/');
    if (!tns || !tname) throw new ActionError('target must be "namespace/name"');
    return b.action === 'unlink' ? unlinkApps(namespace, name, { namespace: tns, name: tname }) : linkApps(namespace, name, { namespace: tns, name: tname });
  }));

  app.delete('/api/pods/:namespace/:name', act<unknown>('pod.delete', (r) => { const p = r.params as P; return `${p.namespace}/pod/${p.name}`; }, async (req) => {
    const { namespace, name } = req.params as P;
    await deletePod(namespace, name);
  }));

  app.get('/api/pods/:namespace/:name/logs', async (req, reply) => {
    const { namespace, name } = req.params as P;
    const q = req.query as { container?: string; tail?: string; previous?: string };
    try {
      return { logs: await podLogs(namespace, name, q.container, Math.min(Number(q.tail ?? 300), 5000), q.previous === 'true') };
    } catch (e) {
      const { status, problem } = errorProblem(e);
      return reply.code(status).send({ error: problem });
    }
  });

  // ---- Deploy ---------------------------------------------------------------------------------
  app.post('/api/image/check', async (req) => checkImage(String((req.body as any)?.image ?? '')));

  app.get('/api/hosts/check', async (req) => {
    const q = req.query as { host?: string; app?: string; mode?: 'public' | 'internal' };
    const host = q.host || (q.app && q.mode ? defaultHost(q.app, q.mode) : '');
    return { host, ...checkHost(host, q.app ? `${config.appsNamespace}/${q.app}` : '') };
  });

  app.post('/api/deploy/yaml', act<{ app: string; namespace?: string; yaml: string; dryRun?: boolean }>('deploy.yaml', (r) => `${(r.body as any)?.namespace || config.appsNamespace}/${(r.body as any)?.app}`, async (_req, b) => {
    return deployYaml({ app: b.app, namespace: b.namespace, yaml: b.yaml, dryRun: b.dryRun !== false });
  }));

  app.post('/api/deploy/image', act<any>('deploy.image', (r) => `${(r.body as any)?.namespace || config.appsNamespace}/${(r.body as any)?.app}`, async (_req, b) => {
    const dryRun = b.dryRun !== false;
    if (!dryRun) {
      const check = await checkImage(b.image);
      if (check.status === 'missing' || check.status === 'invalid') throw new ActionError(check.message, 422);
    }
    const res = await deployImage(b, dryRun);
    if (!dryRun && res.ok && b.exposure && b.exposure !== 'off') {
      try {
        const ex = await setExposure(res.namespace, res.app, b.exposure, { host: b.host });
        return { ...res, exposure: ex };
      } catch (e) {
        res.warnings.push(`Deployed, but exposing it failed: ${errorProblem(e).problem.title}`);
      }
    }
    return res;
  }));

  app.post('/api/github/inspect', async (req, reply) => {
    const b = req.body as { repo: string; branch?: string };
    try {
      return await inspect(b.repo, b.branch);
    } catch (e) {
      const { status, problem } = errorProblem(e);
      return reply.code(status).send({ error: problem });
    }
  });

  app.post('/api/deploy/github', act<any>('deploy.github.start', (r) => String((r.body as any)?.repo ?? ''), async (req, b) => deployFromGitHub(b, req.user.login)));

  // Redeploy an app from GitHub at the newest commit of its branch.
  app.post('/api/apps/:namespace/:name/redeploy', act<unknown>('redeploy', (r) => appId(r), async (req) => {
    const { namespace, name } = req.params as P;
    const objs = appObjects(namespace, name);
    const src = objs?.workloads[0]?.metadata.annotations?.['homelab.io/source'];
    const source = src ? JSON.parse(src) : undefined;
    if (source?.type !== 'github') throw new ActionError('Only apps deployed from GitHub can be redeployed from their repo.', 422);
    const exposure = objs!.app.exposure;
    const host = objs!.app.hosts.find((h) => h.managed)?.host;
    return deployFromGitHub({ repo: source.repo, branch: source.branch, app: name, namespace, exposure, host, port: objs!.services[0]?.spec?.ports?.[0]?.targetPort }, req.user.login);
  }));

  app.get('/api/builds', async () => listBuilds());
  app.get('/api/builds/:id', async (req, reply) => getBuild((req.params as any).id) ?? reply.code(404).send({ error: { title: 'Build not found' } }));

  // ---- Proxmox (read + power + snapshots) ------------------------------------------------------
  app.get('/api/proxmox', async () => proxmox.state);
  app.post('/api/proxmox/guests/:vmid/:action', act<unknown>('proxmox.power', (r) => `proxmox/${(r.params as any).vmid}`, async (req) => {
    const { vmid, action } = req.params as { vmid: string; action: string };
    if (!['start', 'shutdown', 'stop', 'reboot'].includes(action)) throw new ActionError('Unknown action');
    return proxmox.power(Number(vmid), action as any);
  }));
  app.get('/api/proxmox/guests/:vmid/snapshots', async (req, reply) => {
    try {
      return await proxmox.snapshots(Number((req.params as any).vmid));
    } catch (e) {
      const { status, problem } = errorProblem(e);
      return reply.code(status).send({ error: problem });
    }
  });
  app.post('/api/proxmox/guests/:vmid/snapshots', act<{ name: string; description?: string }>('proxmox.snapshot', (r) => `proxmox/${(r.params as any).vmid}`, async (req, b) => proxmox.snapshot(Number((req.params as any).vmid), b.name, b.description)));

  // ---- TrueNAS (view only) ----------------------------------------------------------------------
  app.get('/api/truenas', async () => truenas.state);

  // ---- Connections (credentials stay server-side; only status and non-secret fields go out) ----
  app.get('/api/connections', async () => {
    const [pve, tn, gh] = await Promise.all([readSecret('proxmox'), readSecret('truenas'), readSecret('github')]);
    return {
      proxmox: { url: pve?.url, tokenId: pve?.tokenId, hasSecret: !!pve?.secret, connected: proxmox.state.connected, error: proxmox.state.error },
      truenas: { url: tn?.url, username: tn?.username, hasSecret: !!tn?.apiKey, connected: truenas.state.connected, error: truenas.state.error, apiVersion: truenas.state.apiVersion },
      github: { owner: config.githubOwner, hasSecret: !!gh?.token },
    };
  });

  app.post('/api/connections/:system/test', act<Record<string, string>>('connection.test', (r) => `connection/${(r.params as any).system}`, async (req, b) => {
    const system = (req.params as any).system;
    if (system === 'proxmox') {
      const cur = (await readSecret('proxmox')) ?? {};
      return { message: await proxmox.test(b.url || cur.url, b.tokenId || cur.tokenId, b.secret || cur.secret) };
    }
    if (system === 'truenas') {
      const cur = (await readSecret('truenas')) ?? {};
      return { message: await truenas.test(b.url || cur.url, b.apiKey || cur.apiKey, b.username || cur.username) };
    }
    throw new ActionError('Unknown system');
  }));

  app.put('/api/connections/:system', act<Record<string, string>>('connection.update', (r) => `connection/${(r.params as any).system}`, async (req, b) => {
    const system = (req.params as any).system;
    if (system === 'proxmox') {
      await writeSecret('proxmox', { url: b.url, tokenId: b.tokenId, secret: b.secret });
      await proxmox.reload();
    } else if (system === 'truenas') {
      await writeSecret('truenas', { url: b.url, apiKey: b.apiKey, username: b.username });
      await truenas.reload();
    } else if (system === 'github') {
      await writeSecret('github', { token: b.token });
    } else throw new ActionError('Unknown system');
  }));

  app.get('/api/audit', async () => recentAudit(undefined, 200));
}

function appId(req: FastifyRequest): string {
  const p = req.params as P;
  return `${p.namespace}/${p.name}`;
}
