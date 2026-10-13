import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { appPath, del, get, post } from '../api';
import { useLive } from '../live';
import type { AppSummary, Exposure } from '../types';
import { Card, CopyText, Empty, ErrorBox, fmtAgo, fmtBytes, ProblemCard, Spinner, StatusBadge, useAction, useConfirm } from '../ui';

type Detail = {
  app: AppSummary;
  workloads: any[];
  replicaSets: any[];
  pods: any[];
  events: any[];
  services: any[];
  routes: any[];
  pvcs: any[];
  podMetrics: Record<string, { cpu: number; memory: number } | undefined>;
  revisions: { revision: number; name: string; images: string[]; created: string; replicas: number }[];
  crashLogs: Record<string, string>;
  history: { id: number; at: number; user: string; action: string; ok: boolean; detail?: string }[];
};

const ACTIONABLE = ['Deployment', 'StatefulSet', 'DaemonSet'];

function podState(p: any): { text: string; tone: string } {
  if (p.metadata.deletionTimestamp) return { text: 'Terminating', tone: 'muted' };
  const cs: any[] = p.status?.containerStatuses ?? [];
  const waiting = cs.find((c) => c.state?.waiting)?.state.waiting.reason;
  if (waiting) return { text: waiting, tone: 'bad' };
  const ready = cs.length > 0 && cs.every((c) => c.ready);
  if (p.status?.phase === 'Running') return { text: ready ? 'Running' : 'Not ready', tone: ready ? 'ok' : 'warn' };
  return { text: p.status?.phase ?? 'Unknown', tone: p.status?.phase === 'Succeeded' ? 'muted' : 'warn' };
}

export function AppDetail() {
  const { namespace = '', name = '' } = useParams();
  const id = `${namespace}/${name}`;
  const live = useLive((s) => s.apps.find((a) => a.id === id), id);
  const loaded = useLive((s) => s.appsLoaded);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['app', id], queryFn: () => get<Detail>(appPath(id)) });

  // Refetch the detail whenever the live summary says something about this app changed.
  const rev = live?.rev;
  useEffect(() => {
    if (rev) void qc.invalidateQueries({ queryKey: ['app', id] });
  }, [rev, id, qc]);

  if (loaded && !live && !q.data) return <div className="page"><h1>{name}</h1><Empty>This app no longer exists. <Link to="/apps">Back to apps</Link></Empty></div>;
  const app = live ?? q.data?.app;
  if (!app) return <div className="page"><Spinner /></div>;
  const d = q.data;
  const ro = app.protected;

  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/apps">Apps</Link> / <Link to={`/apps?ns=${namespace}`}>{namespace}</Link>
      </div>
      <Header app={app} detail={d} />
      {ro && <div className="banner banner-info">System namespace: view only. Use Rancher or kubectl to change it.</div>}
      {q.error && <ErrorBox error={q.error} />}

      {app.problems.length > 0 && (
        <Card title={`Problems (${app.problems.length})`}>
          {app.problems.map((p, i) => (
            <ProblemCard key={i} p={p} logs={p.pod && p.container ? d?.crashLogs[`${p.pod}/${p.container}`] : undefined} />
          ))}
          {d && app.workloads.some((w) => w.kind === 'Deployment') && d.revisions.length > 1 && app.problems.some((p) => p.title === 'Rollout stalled' || p.severity === 'error') && !ro && (
            <RollbackButton app={app} detail={d} />
          )}
        </Card>
      )}

      <div className="grid-2">
        <Exposure app={app} />
        <Links app={app} />
      </div>

      {d ? (
        <>
          <Workloads app={app} detail={d} />
          <Pods app={app} detail={d} />
          <LogViewer detail={d} />
          {!ro && <EnvEditor app={app} detail={d} />}
          {d.revisions.length > 0 && <Revisions app={app} detail={d} />}
          {d.pvcs.length > 0 && (
            <Card title="Volumes">
              <table className="table">
                <thead>
                  <tr><th>Claim</th><th>Class</th><th>Size</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {d.pvcs.map((p) => (
                    <tr key={p.metadata.name}>
                      <td>{p.metadata.name}</td>
                      <td>{p.spec?.storageClassName}</td>
                      <td>{p.status?.capacity?.storage ?? p.spec?.resources?.requests?.storage}</td>
                      <td>{p.status?.phase}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          <Events detail={d} />
          {d.history.length > 0 && (
            <Card title="Changes made here">
              <ul className="list small">
                {d.history.map((h) => (
                  <li key={h.id} className="history-row">
                    <span className={h.ok ? '' : 'problem-error-text'}>{h.action}{h.ok ? '' : ' (failed)'}</span>
                    <span className="muted">{h.user} · {fmtAgo(h.at)} ago</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      ) : (
        <Spinner />
      )}
    </div>
  );
}

function Header({ app, detail }: { app: AppSummary; detail?: Detail }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const primary = app.workloads.find((w) => ACTIONABLE.includes(w.kind));
  const source = useMemo(() => {
    const raw = detail?.workloads[0]?.metadata.annotations?.['homelab.io/source'];
    try {
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  }, [detail]);

  const restart = () => primary && run('restart', () => post(`${appPath(app.id)}/restart`, { kind: primary.kind, workload: primary.name }), `Restarting ${app.name}`);
  const redeploy = () => run('redeploy', () => post(`${appPath(app.id)}/redeploy`), 'Fetching the latest commit and redeploying…');
  const remove = async () => {
    const warn = app.linkedBy.length ? <p className="problem-warning-text">These apps link to {app.name} and will lose their connection: {app.linkedBy.join(', ')}</p> : null;
    let keep = true;
    const ok = await confirm({
      title: `Delete ${app.name}?`,
      danger: true,
      confirm: 'Delete',
      typeToConfirm: app.name,
      body: (
        <>
          <p>This removes its workloads, services and routes{app.managed ? ' (everything labelled with this app)' : ''} from <strong>{app.namespace}</strong>.</p>
          {warn}
          {app.pvcs.length > 0 && (
            <label className="check">
              <input type="checkbox" defaultChecked onChange={(e) => (keep = e.target.checked)} /> Keep volumes ({app.pvcs.join(', ')})
            </label>
          )}
        </>
      ),
    });
    if (!ok) return;
    const r = await run('delete', () => del(`${appPath(app.id)}?keepVolumes=${keep}`), `${app.name} deleted`);
    if (r) navigate('/apps');
  };

  return (
    <div className="detail-head">
      <div>
        <h1>
          {app.name} <StatusBadge status={app.status} />
        </h1>
        <div className="muted small">
          {app.namespace} · {app.workloads.map((w) => `${w.kind} ${w.name}`).join(', ') || 'Pod'}
          {app.createdAt && ` · created ${fmtAgo(app.createdAt)} ago`}
          {source?.type === 'github' && (
            <>
              {' · '}
              <a href={`https://github.com/${source.repo}/commit/${source.sha}`} target="_blank" rel="noreferrer">
                {source.repo}@{String(source.sha).slice(0, 7)}
              </a>
            </>
          )}
          {source?.type === 'image' && ` · from image ${source.image}`}
          {source?.type === 'yaml' && ' · from YAML'}
        </div>
      </div>
      {!app.protected && (
        <div className="btn-row">
          {primary && (
            <button className="btn" disabled={!!busy} onClick={restart}>
              {busy === 'restart' ? <Spinner /> : '↻'} Restart
            </button>
          )}
          {source?.type === 'github' && (
            <button className="btn" disabled={!!busy} onClick={redeploy} title="Deploy the newest commit of the branch">
              ⇡ Redeploy latest
            </button>
          )}
          <button className="btn btn-danger-outline" disabled={!!busy} onClick={remove}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function RollbackButton({ app, detail }: { app: AppSummary; detail: Detail }) {
  const { busy, run } = useAction();
  const dep = app.workloads.find((w) => w.kind === 'Deployment')!;
  const current = Number(dep.revision ?? 0);
  const prev = detail.revisions.find((r) => r.revision < current);
  if (!prev) return null;
  return (
    <button className="btn btn-primary" disabled={!!busy} onClick={() => run('rb', () => post(`${appPath(app.id)}/rollback`, { workload: dep.name }), `Rolling back to revision ${prev.revision}`)}>
      Roll back to the previous version (revision {prev.revision}, {prev.images[0]})
    </button>
  );
}

function Exposure({ app }: { app: AppSummary }) {
  const config = useQuery({ queryKey: ['me'], queryFn: () => get('/me'), staleTime: Infinity });
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const managedHost = app.hosts.find((h) => h.managed)?.host;
  const [custom, setCustom] = useState('');
  const pub = config.data?.config.publicDomain ?? 'howellsas.com';
  const lan = config.data?.config.internalDomain ?? 'lan.howellsas.com';
  const canRoute = app.services.length > 0 && !app.protected;

  const choose = async (mode: Exposure) => {
    if (mode === app.exposure && !custom) return;
    const host = custom.trim() || undefined;
    if (mode === 'public') {
      const ok = await confirm({ title: `Make ${app.name} public?`, confirm: 'Make public', body: <p>Anyone on the internet will be able to reach <strong>{host ?? `${app.name}.${pub}`}</strong> through the Cloudflare tunnel. Make sure the app has its own login if it needs one.</p> });
      if (!ok) return;
    }
    const r = await run(mode, () => post(`${appPath(app.id)}/exposure`, { mode, host }), mode === 'off' ? 'Route removed' : undefined);
    if (r && mode !== 'off') setCustom('');
  };

  return (
    <Card title="Access">
      {!canRoute && !app.protected && <p className="muted small">This app has no Service, so it can't be routed. Redeploy it with a port.</p>}
      <div className="segmented" role="radiogroup" aria-label="Exposure">
        {(['off', 'internal', 'public'] as Exposure[]).map((m) => (
          <button key={m} role="radio" aria-checked={app.exposure === m} className={app.exposure === m ? `seg active seg-${m}` : 'seg'} disabled={!canRoute || !!busy} onClick={() => choose(m)}>
            {busy === m ? <Spinner /> : m === 'off' ? 'Off' : m === 'internal' ? 'Internal (Tailscale)' : 'Public'}
          </button>
        ))}
      </div>
      {canRoute && (
        <label className="field small">
          <span>Custom hostname (optional)</span>
          <input placeholder={app.exposure === 'public' ? `${app.name}.${pub}` : `${app.name}.${lan}`} value={custom} onChange={(e) => setCustom(e.target.value.toLowerCase())} />
        </label>
      )}
      {managedHost && <p className="small">Managed route: <strong>{managedHost}</strong></p>}
      {app.hosts.length > 0 && (
        <ul className="list small">
          {app.hosts.map((h) => {
            const url = `${h.exposure === 'internal' ? 'http' : 'https'}://${h.host}`;
            return (
              <li key={h.host + h.object} className="host-row">
                <a href={url} target="_blank" rel="noreferrer">{h.host}</a>
                <span className="muted">{h.exposure} · {h.via} {h.object}</span>
                <CopyText text={url} />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function Links({ app }: { app: AppSummary }) {
  const apps = useLive((s) => s.apps);
  const { busy, run } = useAction();
  const [target, setTarget] = useState('');
  const candidates = apps.filter((a) => a.id !== app.id && a.services.length > 0 && !app.links.includes(a.id));
  const linkable = !app.protected && app.workloads.some((w) => ACTIONABLE.includes(w.kind));
  return (
    <Card title="Links">
      <p className="muted small">Linking injects the target's in-cluster address as <code>NAME_URL</code>, <code>NAME_HOST</code> and <code>NAME_PORT</code>, then restarts this app.</p>
      {app.links.length === 0 && app.linkedBy.length === 0 && <p className="muted small">No links.</p>}
      <ul className="list small">
        {app.links.map((l) => (
          <li key={l} className="host-row">
            <span>→ <Link to={appPath(l)}>{l}</Link></span>
            {linkable && (
              <button className="btn btn-small" disabled={!!busy} onClick={() => run(`un${l}`, () => post(`${appPath(app.id)}/links`, { target: l, action: 'unlink' }), `Unlinked ${l}`)}>
                Unlink
              </button>
            )}
          </li>
        ))}
        {app.linkedBy.map((l) => (
          <li key={`by${l}`}>
            ← <Link to={appPath(l)}>{l}</Link> <span className="muted">links here</span>
          </li>
        ))}
      </ul>
      {linkable && (
        <div className="inline-form">
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Link target">
            <option value="">Link to…</option>
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>{a.id}</option>
            ))}
          </select>
          <button className="btn" disabled={!target || !!busy} onClick={async () => (await run('link', () => post(`${appPath(app.id)}/links`, { target, action: 'link' }), `Linked to ${target}`)) && setTarget('')}>
            Link
          </button>
        </div>
      )}
    </Card>
  );
}

function Workloads({ app, detail }: { app: AppSummary; detail: Detail }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [scale, setScale] = useState<Record<string, number>>({});
  return (
    <Card title="Workloads">
      <table className="table">
        <thead>
          <tr><th>Workload</th><th>Ready</th><th className="hide-sm">Image</th><th /></tr>
        </thead>
        <tbody>
          {app.workloads.map((w) => {
            const key = `${w.kind}/${w.name}`;
            const obj = detail.workloads.find((o) => o.kind === w.kind && o.metadata.name === w.name);
            const target = scale[key] ?? w.desired;
            const scalable = !app.protected && (w.kind === 'Deployment' || w.kind === 'StatefulSet');
            const doScale = async () => {
              if (target === 0 && !(await confirm({ title: `Stop ${w.name}?`, body: <p>Scaling to 0 stops all of its pods. Scale back up any time.</p>, confirm: 'Scale to 0', danger: true }))) return;
              await run(`scale${key}`, () => post(`${appPath(app.id)}/scale`, { kind: w.kind, workload: w.name, replicas: target }), `Scaled ${w.name} to ${target}`);
            };
            return (
              <tr key={key}>
                <td>
                  <div>{w.name}</div>
                  <div className="muted small">{w.kind}</div>
                </td>
                <td>{w.kind === 'CronJob' ? (obj?.spec?.suspend ? 'Suspended' : obj?.spec?.schedule) : `${w.ready}/${w.desired}`}</td>
                <td className="small ellipsis mono hide-sm" title={w.images.join('\n')}>{w.images.join(', ')}</td>
                <td className="right">
                  {scalable && (
                    <span className="stepper">
                      <button className="btn btn-small" onClick={() => setScale({ ...scale, [key]: Math.max(0, target - 1) })} aria-label="Fewer">−</button>
                      <span className="stepper-val">{target}</span>
                      <button className="btn btn-small" onClick={() => setScale({ ...scale, [key]: Math.min(50, target + 1) })} aria-label="More">+</button>
                      <button className="btn btn-small btn-primary" disabled={target === w.desired || !!busy} onClick={doScale}>Scale</button>
                    </span>
                  )}
                  {w.kind === 'CronJob' && !app.protected && (
                    <button className="btn btn-small" disabled={!!busy} onClick={() => run('suspend', () => post(`${appPath(app.id)}/suspend`, { workload: w.name, suspend: !obj?.spec?.suspend }), obj?.spec?.suspend ? 'Resumed' : 'Suspended')}>
                      {obj?.spec?.suspend ? 'Resume' : 'Suspend'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function Pods({ app, detail }: { app: AppSummary; detail: Detail }) {
  const { busy, run } = useAction();
  if (!detail.pods.length) return null;
  return (
    <Card title={`Pods (${detail.pods.length})`}>
      <table className="table">
        <thead>
          <tr><th>Pod</th><th>State</th><th className="hide-sm">Restarts</th><th className="hide-sm">Node</th><th className="hide-sm">CPU / RAM</th><th className="hide-sm">Age</th><th /></tr>
        </thead>
        <tbody>
          {detail.pods.map((p) => {
            const st = podState(p);
            const m = detail.podMetrics[p.metadata.name];
            const restarts = (p.status?.containerStatuses ?? []).reduce((n: number, c: any) => n + (c.restartCount ?? 0), 0);
            return (
              <tr key={p.metadata.name}>
                <td className="small mono ellipsis" title={p.metadata.name}>{p.metadata.name}</td>
                <td><span className={`problem-${st.tone === 'bad' ? 'error' : st.tone === 'warn' ? 'warning' : 'none'}-text`}>{st.text}</span></td>
                <td className="hide-sm">{restarts}</td>
                <td className="small hide-sm">{p.spec?.nodeName ?? '–'}</td>
                <td className="small hide-sm">{m ? `${Math.round(m.cpu * 1000)}m / ${fmtBytes(m.memory)}` : '–'}</td>
                <td className="small hide-sm">{fmtAgo(p.metadata.creationTimestamp)}</td>
                <td className="right">
                  {!app.protected && (
                    <button className="btn btn-small" title="Delete this pod; its controller replaces it" disabled={!!busy} onClick={() => run(`del${p.metadata.name}`, () => del(`/pods/${app.namespace}/${p.metadata.name}`), 'Pod deleted; a replacement is starting')}>
                      Recreate
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function LogViewer({ detail }: { detail: Detail }) {
  const pods = detail.pods.filter((p) => !p.metadata.deletionTimestamp);
  const [pod, setPod] = useState(pods[0]?.metadata.name ?? '');
  const containers: string[] = (pods.find((p) => p.metadata.name === pod)?.spec?.containers ?? []).map((c: any) => c.name);
  const [container, setContainer] = useState('');
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLPreElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!pods.some((p) => p.metadata.name === pod) && pods[0]) setPod(pods[0].metadata.name);
  }, [pods, pod]);

  useEffect(() => {
    if (!open || !pod) return;
    setLines([]);
    setStatus('Connecting…');
    const ns = detail.app.namespace;
    const c = container || containers[0] || '';
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/logs?namespace=${encodeURIComponent(ns)}&pod=${encodeURIComponent(pod)}&container=${encodeURIComponent(c)}`);
    let buffer: string[] = [];
    const flush = window.setInterval(() => {
      if (!buffer.length || pausedRef.current) return;
      const add = buffer;
      buffer = [];
      setLines((l) => [...l, ...add].slice(-2000));
    }, 250);
    ws.onopen = () => setStatus('Live');
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.line !== undefined) buffer.push(m.line);
      if (m.error) setStatus(`Error: ${m.error}`);
      if (m.end) setStatus('Stream ended');
    };
    ws.onclose = () => setStatus((s) => (s === 'Live' ? 'Disconnected' : s));
    return () => {
      clearInterval(flush);
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pod, container, detail.app.namespace]);

  useEffect(() => {
    if (!paused && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, paused]);

  if (!pods.length) return null;
  return (
    <Card
      title="Logs"
      actions={
        open ? (
          <div className="btn-row">
            <span className="muted small">{status}</span>
            <button className="btn btn-small" onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>
            <button className="btn btn-small" onClick={() => setLines([])}>Clear</button>
            <button className="btn btn-small" onClick={() => setOpen(false)}>Close</button>
          </div>
        ) : (
          <button className="btn btn-small" onClick={() => setOpen(true)}>Stream logs</button>
        )
      }
    >
      {open && (
        <>
          <div className="inline-form">
            <select value={pod} onChange={(e) => setPod(e.target.value)} aria-label="Pod">
              {pods.map((p) => <option key={p.metadata.name}>{p.metadata.name}</option>)}
            </select>
            {containers.length > 1 && (
              <select value={container || containers[0]} onChange={(e) => setContainer(e.target.value)} aria-label="Container">
                {containers.map((c) => <option key={c}>{c}</option>)}
              </select>
            )}
          </div>
          <pre className="logbox" ref={box}>{lines.join('\n') || ' '}</pre>
        </>
      )}
    </Card>
  );
}

function EnvEditor({ app, detail }: { app: AppSummary; detail: Detail }) {
  const w = detail.workloads.find((o) => ACTIONABLE.includes(o.kind));
  const containers: any[] = w?.spec?.template?.spec?.containers ?? [];
  const [container, setContainer] = useState(containers[0]?.name ?? '');
  const original: any[] = containers.find((c) => c.name === container)?.env ?? [];
  const [rows, setRows] = useState<{ name: string; value?: string; valueFrom?: unknown }[] | null>(null);
  const { busy, run } = useAction();
  if (!w) return null;
  const env = rows ?? original;
  const dirty = rows !== null;
  const update = (i: number, patch: Partial<{ name: string; value: string }>) => setRows(env.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Card
      title="Environment"
      actions={
        <div className="btn-row">
          {dirty && <button className="btn btn-small" onClick={() => setRows(null)}>Discard</button>}
          <button className="btn btn-small btn-primary" disabled={!dirty || !!busy} onClick={async () => (await run('env', () => post(`${appPath(app.id)}/env`, { kind: w.kind, workload: w.metadata.name, container, env: env.filter((r) => r.name.trim()) }), 'Saved; the app is restarting with the new values')) && setRows(null)}>
            Save &amp; restart
          </button>
        </div>
      }
    >
      {containers.length > 1 && (
        <select value={container} onChange={(e) => (setContainer(e.target.value), setRows(null))} aria-label="Container">
          {containers.map((c) => <option key={c.name}>{c.name}</option>)}
        </select>
      )}
      <div className="env-grid">
        {env.map((r, i) => (
          <div key={i} className="env-row">
            <input className="mono" value={r.name} placeholder="NAME" onChange={(e) => update(i, { name: e.target.value })} aria-label="Name" />
            {r.valueFrom ? (
              <input disabled value={`from ${Object.keys(r.valueFrom as object)[0]}`} aria-label="Value" />
            ) : (
              <input className="mono" value={r.value ?? ''} placeholder="value" onChange={(e) => update(i, { value: e.target.value })} aria-label="Value" />
            )}
            <button className="icon-btn" onClick={() => setRows(env.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
          </div>
        ))}
      </div>
      <button className="btn btn-small" onClick={() => setRows([...env, { name: '', value: '' }])}>+ Add variable</button>
    </Card>
  );
}

function Revisions({ app, detail }: { app: AppSummary; detail: Detail }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const dep = app.workloads.find((w) => w.kind === 'Deployment');
  const current = Number(dep?.revision ?? 0);
  return (
    <Card title="Versions">
      <table className="table">
        <thead>
          <tr><th>Revision</th><th>Image</th><th>Created</th><th /></tr>
        </thead>
        <tbody>
          {detail.revisions.slice(0, 8).map((r) => (
            <tr key={r.name}>
              <td>{r.revision}{r.revision === current && <span className="tag">current</span>}</td>
              <td className="small mono ellipsis">{r.images.join(', ')}</td>
              <td className="small">{fmtAgo(r.created)} ago</td>
              <td className="right">
                {r.revision !== current && dep && !app.protected && (
                  <button
                    className="btn btn-small"
                    disabled={!!busy}
                    onClick={async () => (await confirm({ title: `Roll back to revision ${r.revision}?`, body: <p>The pods will be replaced with this version's template ({r.images[0]}). Current links are kept.</p>, confirm: 'Roll back' })) && run(`rb${r.revision}`, () => post(`${appPath(app.id)}/rollback`, { workload: dep.name, revision: r.revision }), `Rolling back to revision ${r.revision}`)}
                  >
                    Roll back
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Events({ detail }: { detail: Detail }) {
  if (!detail.events.length) return null;
  return (
    <Card title="Recent events">
      <ul className="list small events">
        {detail.events.slice(0, 25).map((e) => (
          <li key={e.metadata.name} className={e.type === 'Warning' ? 'problem-warning-text' : ''}>
            <span className="muted">{fmtAgo(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp)}</span> <strong>{e.reason}</strong> {e.involvedObject?.kind}/{e.involvedObject?.name}: {e.message}
            {e.count > 1 && <span className="muted"> ×{e.count}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
