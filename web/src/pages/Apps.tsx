import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { appPath } from '../api';
import { useLive } from '../live';
import type { AppSummary } from '../types';
import { Empty, StatusBadge } from '../ui';

const SYSTEM = /^(kube-|cattle-|fleet-|cluster-fleet-|local$|p-)/;

function ExposureTag({ a }: { a: AppSummary }) {
  if (a.exposure === 'public') return <span className="tag tag-public">Public</span>;
  if (a.exposure === 'internal') return <span className="tag tag-internal">Internal</span>;
  if (a.hosts.some((h) => h.exposure === 'public')) return <span className="tag tag-public" title="Routed by its own Ingress">Public</span>;
  if (a.hosts.some((h) => h.exposure === 'internal')) return <span className="tag tag-internal" title="Routed by its own Ingress">Home only</span>;
  if (a.hosts.length) return <span className="tag">Routed</span>;
  return null;
}

export function Apps() {
  const apps = useLive((s) => s.apps);
  const loaded = useLive((s) => s.appsLoaded);
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const ns = params.get('ns') ?? '';
  const status = params.get('status') ?? '';
  const showSystem = params.get('system') === '1';

  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  const namespaces = useMemo(() => [...new Set(apps.map((a) => a.namespace))].sort(), [apps]);
  const filtered = apps.filter((a) => {
    if (!showSystem && !ns && SYSTEM.test(a.namespace)) return false;
    if (ns && a.namespace !== ns) return false;
    if (status === 'problems' && !(a.status === 'failed' || a.status === 'degraded' || a.problems.length)) return false;
    if (status === 'managed' && !a.managed) return false;
    if (q && !`${a.name} ${a.namespace} ${a.images.join(' ')} ${a.hosts.map((h) => h.host).join(' ')}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const hidden = apps.filter((a) => SYSTEM.test(a.namespace)).length;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Apps</h1>
        <Link to="/deploy" className="btn btn-primary">
          Deploy app
        </Link>
      </div>
      <div className="filters">
        <input type="search" placeholder="Filter by name, image or host" value={q} onChange={(e) => set('q', e.target.value)} />
        <select value={ns} onChange={(e) => set('ns', e.target.value)} aria-label="Namespace">
          <option value="">All namespaces</option>
          {namespaces.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="problems">With problems</option>
          <option value="managed">Deployed from here</option>
        </select>
        {!ns && (
          <label className="check">
            <input type="checkbox" checked={showSystem} onChange={(e) => set('system', e.target.checked ? '1' : '')} /> System ({hidden})
          </label>
        )}
      </div>
      {!loaded && <Empty>Loading apps…</Empty>}
      {loaded && !filtered.length && <Empty>No apps match.</Empty>}
      <div className="app-table">
        {filtered.map((a) => (
          <Link key={a.id} to={appPath(a.id)} className="app-row">
            <div className="app-main">
              <div className="row-title">
                {a.name}
                {a.managed && <span className="tag tag-managed" title="Deployed by this controller">★</span>}
              </div>
              <div className="muted small ellipsis">
                {a.namespace} · {a.workloads.map((w) => w.kind).join(', ') || 'Pod'} · {a.images[0] ?? ''}
              </div>
            </div>
            <div className="app-hosts small ellipsis">{a.hosts[0]?.host ?? ''}</div>
            <div className="app-meta">
              <ExposureTag a={a} />
              <span className="muted small">{a.desired ? `${a.ready}/${a.desired}` : ''}</span>
              {a.restarts > 0 && <span className="muted small" title="Container restarts">↻{a.restarts}</span>}
              <StatusBadge status={a.status} />
            </div>
            {a.problems[0] && <div className={`app-problem small problem-${a.problems[0].severity}-text`}>{a.problems[0].title}</div>}
          </Link>
        ))}
      </div>
    </div>
  );
}
