import { useState } from 'react';
import { Link } from 'react-router';
import { useLive } from '../live';
import { Card, Dot, Empty, fmtAgo, fmtBytes, fmtUptime, Meter, NativeLink, useNativeLinks } from '../ui';

export function TrueNas() {
  const tn = useLive((s) => s.truenas);
  const [pool, setPool] = useState('');
  const [showDismissed, setShowDismissed] = useState(false);
  const links = useNativeLinks();
  if (!tn) return <div className="page"><h1>TrueNAS</h1><Empty>Loading…</Empty></div>;
  if (!tn.configured) return <div className="page"><h1>TrueNAS</h1><Empty>TrueNAS is not connected yet. <Link to="/settings">Add it in Settings</Link>.</Empty></div>;

  const alerts = tn.alerts.filter((a) => showDismissed || !a.dismissed);
  const datasets = tn.datasets.filter((d) => !pool || d.pool === pool);

  return (
    <div className="page">
      <div className="page-head">
        <h1>TrueNAS {tn.system && <span className="muted small">{tn.system.hostname} · {tn.system.version}</span>}</h1>
        <div className="btn-row">
          {tn.lastUpdate && <span className="muted small">updated {fmtAgo(tn.lastUpdate)} ago</span>}
          <NativeLink href={links.truenas}>Open TrueNAS</NativeLink>
        </div>
      </div>
      {!tn.connected && <div className="banner banner-bad">Disconnected: {tn.error}. Showing the last known state; reconnecting.</div>}
      {tn.system && (
        <p className="muted small">
          Up {fmtUptime(tn.system.uptimeSeconds)} · load {tn.system.loadavg.map((l) => l.toFixed(2)).join(' / ')} · {tn.system.cores} cores · {fmtBytes(tn.system.physmem)} RAM{tn.system.model ? ` · ${tn.system.model}` : ''}
        </p>
      )}

      <Card title={`Alerts (${alerts.length})`} actions={<label className="check small"><input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> show dismissed</label>}>
        {!alerts.length && <Empty>No alerts.</Empty>}
        {alerts.map((a) => (
          <div key={a.uuid} className={`alert alert-${a.level.toLowerCase()}`}>
            <strong>{a.level}</strong> {a.formatted}
            {a.datetime && <span className="muted small"> · {fmtAgo(a.datetime)} ago</span>}
          </div>
        ))}
      </Card>

      <div className="grid-2">
        {tn.pools.map((p) => (
          <Card key={p.id} title={<><Dot tone={p.healthy ? 'ok' : 'bad'} /> {p.name}</>}>
            <Meter value={p.size ? p.allocated / p.size : 0} label={`${fmtBytes(p.allocated)} used of ${fmtBytes(p.size)} · ${fmtBytes(p.free)} free`} />
            <div className="small">
              Status: <strong className={p.healthy ? 'ok-text' : 'problem-error-text'}>{p.status}</strong>
              {p.vdevErrors > 0 && <span className="problem-error-text"> · {p.vdevErrors} disk errors</span>}
            </div>
            {p.scan?.function && (
              <div className="muted small">
                Last {p.scan.function.toLowerCase()}: {p.scan.state?.toLowerCase()}
                {p.scan.state === 'SCANNING' && p.scan.percentage != null ? ` (${p.scan.percentage.toFixed(1)}%)` : ''}
                {p.scan.end_time ? ` · ${fmtAgo(p.scan.end_time)} ago` : ''}
                {p.scan.errors ? ` · ${p.scan.errors} errors` : ''}
              </div>
            )}
          </Card>
        ))}
      </div>

      <Card
        title={`Datasets (${datasets.length})`}
        actions={
          <select value={pool} onChange={(e) => setPool(e.target.value)} aria-label="Pool">
            <option value="">All pools</option>
            {tn.pools.map((p) => <option key={p.id}>{p.name}</option>)}
          </select>
        }
      >
        <table className="table">
          <thead>
            <tr><th>Dataset</th><th>Used</th><th>Available</th><th className="hide-sm">Usage</th></tr>
          </thead>
          <tbody>
            {datasets.map((d) => {
              const depth = d.id.split('/').length - 1;
              return (
                <tr key={d.id}>
                  <td style={{ paddingLeft: `${0.5 + depth * 1}rem` }} className="mono small">
                    {depth ? d.id.split('/').pop() : d.id}
                    {d.encrypted && <span className="tag" title="Encrypted">🔒</span>}
                    {d.type === 'VOLUME' && <span className="tag">zvol</span>}
                  </td>
                  <td className="small">{fmtBytes(d.used)}</td>
                  <td className="small">{fmtBytes(d.available)}</td>
                  <td className="hide-sm"><Meter value={d.used + d.available ? d.used / (d.used + d.available) : 0} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
