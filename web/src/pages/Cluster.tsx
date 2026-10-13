import { Link } from 'react-router';
import { useLive } from '../live';
import { Card, Dot, Empty, fmtAgo, fmtBytes, fmtPct, Meter } from '../ui';

export function Cluster() {
  const cluster = useLive((s) => s.cluster);
  const apps = useLive((s) => s.apps);
  if (!cluster) return <div className="page"><h1>Cluster</h1><Empty>Loading…</Empty></div>;
  const watchErrors = Object.entries(cluster.watch).filter(([, w]) => w.error);
  const byNs = new Map<string, number>();
  for (const a of apps) byNs.set(a.namespace, (byNs.get(a.namespace) ?? 0) + 1);

  return (
    <div className="page">
      <h1>Cluster</h1>
      {watchErrors.length > 0 && (
        <div className="banner banner-warn">
          Some resources can't be watched: {watchErrors.map(([k, w]) => `${k} (${w.error})`).join('; ')}
        </div>
      )}
      {!cluster.metrics && <div className="banner banner-info">CPU and memory usage are unavailable (metrics-server not reachable).</div>}
      <div className="node-cards">
        {cluster.nodes.map((n) => {
          const cpu = n.cpuUsage != null ? n.cpuUsage / n.cpuCores : undefined;
          const mem = n.memoryUsage != null ? n.memoryUsage / n.memoryBytes : undefined;
          return (
            <Card key={n.name} title={<><Dot tone={n.ready ? (n.pressure.length ? 'warn' : 'ok') : 'bad'} /> {n.name}</>}>
              <div className="muted small">
                {n.internalIP} · {n.roles.join(', ') || 'worker'} · {n.kubelet}
                {!n.schedulable && <span className="tag">cordoned</span>}
              </div>
              <Meter value={cpu} label={`CPU ${fmtPct(cpu)} of ${n.cpuCores} cores`} />
              <Meter value={mem} label={`RAM ${fmtBytes(n.memoryUsage)} / ${fmtBytes(n.memoryBytes)}`} />
              <Meter value={n.pods / n.podCapacity} label={`${n.pods} / ${n.podCapacity} pods`} />
              {n.pressure.length > 0 && <div className="problem-warning-text small">Pressure: {n.pressure.join(', ')}</div>}
              <div className="muted small">{n.os} · up {fmtAgo(n.age)}</div>
            </Card>
          );
        })}
      </div>
      <Card title="Namespaces">
        <div className="chips">
          {cluster.namespaces.map((ns) => (
            <Link key={ns} to={`/apps?ns=${encodeURIComponent(ns)}`} className="chip">
              {ns} <span className="muted">{byNs.get(ns) ?? 0}</span>
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}
