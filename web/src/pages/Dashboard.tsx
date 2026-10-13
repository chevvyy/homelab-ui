import { Link } from 'react-router';
import { appPath } from '../api';
import { useLive } from '../live';
import { Card, Dot, Empty, fmtAgo, fmtBytes, fmtPct, Meter, StatusBadge } from '../ui';

export function Dashboard() {
  const apps = useLive((s) => s.apps);
  const loaded = useLive((s) => s.appsLoaded);
  const cluster = useLive((s) => s.cluster);
  const pve = useLive((s) => s.proxmox);
  const tn = useLive((s) => s.truenas);
  const builds = useLive((s) => Object.values(s.builds).sort((a, b) => b.at - a.at).slice(0, 4));

  const failing = apps.filter((a) => a.status === 'failed' || a.status === 'degraded');
  const updating = apps.filter((a) => a.status === 'progressing');
  const warnings = apps.filter((a) => a.status === 'healthy' && a.problems.length);
  const managed = apps.filter((a) => a.managed).length;
  const running = pve?.guests.filter((g) => g.status === 'running' && !g.template).length ?? 0;
  const tnAlerts = tn?.alerts.filter((a) => !a.dismissed && a.level !== 'INFO') ?? [];

  return (
    <div className="page">
      <h1>Dashboard</h1>
      <div className="tiles">
        <Link to="/apps" className="tile">
          <span className="tile-value">{loaded ? apps.length : '…'}</span>
          <span className="tile-label">apps · {managed} managed here</span>
        </Link>
        <Link to="/apps?status=problems" className={`tile ${failing.length ? 'tile-bad' : 'tile-ok'}`}>
          <span className="tile-value">{failing.length}</span>
          <span className="tile-label">failing or degraded</span>
        </Link>
        <Link to="/proxmox" className={`tile ${pve?.configured && !pve.connected ? 'tile-warn' : ''}`}>
          <span className="tile-value">{pve?.connected ? running : '–'}</span>
          <span className="tile-label">{pve?.connected ? 'VMs / containers running' : pve?.configured ? 'Proxmox unreachable' : 'Proxmox not set up'}</span>
        </Link>
        <Link to="/truenas" className={`tile ${tnAlerts.length || (tn?.configured && !tn.connected) ? 'tile-warn' : ''}`}>
          <span className="tile-value">{tn?.connected ? tnAlerts.length : '–'}</span>
          <span className="tile-label">{tn?.connected ? 'TrueNAS alerts' : tn?.configured ? 'TrueNAS unreachable' : 'TrueNAS not set up'}</span>
        </Link>
      </div>

      <div className="grid-2">
        <Card title="Needs attention">
          {!failing.length && !updating.length && !warnings.length && <Empty>Everything is healthy.</Empty>}
          <ul className="list">
            {[...failing, ...updating, ...warnings].slice(0, 10).map((a) => (
              <li key={a.id}>
                <Link to={appPath(a.id)} className="row-link">
                  <div>
                    <div className="row-title">
                      {a.name} <span className="muted">{a.namespace}</span>
                    </div>
                    <div className="muted small">{a.problems[0]?.title ?? (a.status === 'progressing' ? `${a.ready}/${a.desired} ready` : '')}</div>
                  </div>
                  <StatusBadge status={a.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Cluster" actions={<Link to="/cluster">Nodes →</Link>}>
          {!cluster?.nodes.length && <Empty>{cluster?.watch.nodes?.error ?? 'Loading nodes…'}</Empty>}
          <ul className="list">
            {cluster?.nodes.map((n) => (
              <li key={n.name} className="node-row">
                <span className="row-title">
                  <Dot tone={n.ready ? (n.pressure.length ? 'warn' : 'ok') : 'bad'} /> {n.name}
                </span>
                <Meter value={n.cpuUsage != null ? n.cpuUsage / n.cpuCores : undefined} label={`CPU ${fmtPct(n.cpuUsage != null ? n.cpuUsage / n.cpuCores : undefined)}`} />
                <Meter value={n.memoryUsage != null ? n.memoryUsage / n.memoryBytes : undefined} label={`RAM ${fmtPct(n.memoryUsage != null ? n.memoryUsage / n.memoryBytes : undefined)}`} />
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Proxmox" actions={<Link to="/proxmox">Open →</Link>}>
          {!pve?.connected ? (
            <Empty>{pve?.error ?? 'Loading…'}</Empty>
          ) : (
            <ul className="list">
              {pve.nodes.map((n) => (
                <li key={n.node} className="node-row">
                  <span className="row-title">
                    <Dot tone={n.status === 'online' ? 'ok' : 'bad'} /> {n.node}
                  </span>
                  <Meter value={n.cpu} label={`CPU ${fmtPct(n.cpu)}`} />
                  <Meter value={n.maxmem ? n.mem / n.maxmem : 0} label={`RAM ${fmtBytes(n.mem)} / ${fmtBytes(n.maxmem)}`} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="TrueNAS" actions={<Link to="/truenas">Open →</Link>}>
          {!tn?.connected ? (
            <Empty>{tn?.error ?? 'Loading…'}</Empty>
          ) : (
            <>
              <ul className="list">
                {tn.pools.map((p) => (
                  <li key={p.id} className="node-row">
                    <span className="row-title">
                      <Dot tone={p.healthy ? 'ok' : 'bad'} /> {p.name}
                    </span>
                    <Meter value={p.size ? p.allocated / p.size : 0} label={`${fmtBytes(p.allocated)} / ${fmtBytes(p.size)}`} />
                  </li>
                ))}
              </ul>
              {tnAlerts.slice(0, 3).map((a) => (
                <div key={a.uuid} className={`alert alert-${a.level.toLowerCase()}`}>
                  {a.formatted}
                </div>
              ))}
            </>
          )}
        </Card>
      </div>

      {builds.length > 0 && (
        <Card title="Recent GitHub deploys" actions={<Link to="/activity">All →</Link>}>
          <ul className="list">
            {builds.map((b) => (
              <li key={b.id} className="row-link static">
                <div>
                  <div className="row-title">{b.app}</div>
                  <div className="muted small">
                    {b.data.repo}@{b.data.sha.slice(0, 7)} · {fmtAgo(b.at)} ago
                  </div>
                </div>
                <span className={`badge build-${b.state}`}>{b.state}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
