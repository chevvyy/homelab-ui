import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { get, post } from '../api';
import { useLive } from '../live';
import type { PveGuest } from '../types';
import { Card, Dot, Empty, fmtAgo, fmtBytes, fmtPct, fmtUptime, Meter, Modal, Spinner, useAction, useConfirm } from '../ui';

export function Proxmox() {
  const pve = useLive((s) => s.proxmox);
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const selected = params.get('vm');
  if (!pve) return <div className="page"><h1>Proxmox</h1><Empty>Loading…</Empty></div>;
  if (!pve.configured) return <div className="page"><h1>Proxmox</h1><Empty>Proxmox is not connected yet. <Link to="/settings">Add it in Settings</Link>.</Empty></div>;

  const guests = pve.guests.filter((g) => !filter || `${g.name} ${g.vmid} ${g.tags ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const guest = selected ? pve.guests.find((g) => String(g.vmid) === selected) : undefined;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Proxmox {pve.version && <span className="muted small">VE {pve.version}</span>}</h1>
        {pve.lastUpdate && <span className="muted small">updated {fmtAgo(pve.lastUpdate)} ago</span>}
      </div>
      {!pve.connected && <div className="banner banner-bad">Disconnected: {pve.error}. Showing the last known state; retrying.</div>}
      <div className="grid-2">
        {pve.nodes.map((n) => (
          <Card key={n.node} title={<><Dot tone={n.status === 'online' ? 'ok' : 'bad'} /> {n.node}</>}>
            <Meter value={n.cpu} label={`CPU ${fmtPct(n.cpu)} of ${n.maxcpu} threads`} />
            <Meter value={n.maxmem ? n.mem / n.maxmem : 0} label={`RAM ${fmtBytes(n.mem)} / ${fmtBytes(n.maxmem)}`} />
            <Meter value={n.maxdisk ? n.disk / n.maxdisk : 0} label={`Root disk ${fmtBytes(n.disk)} / ${fmtBytes(n.maxdisk)}`} />
            <div className="muted small">up {fmtUptime(n.uptime)}</div>
          </Card>
        ))}
        <Card title="Storage">
          <ul className="list small">
            {pve.storage.map((s) => (
              <li key={s.id} className="node-row">
                <span className="row-title">{s.storage}</span>
                <Meter value={s.maxdisk ? s.disk / s.maxdisk : 0} label={`${fmtBytes(s.disk)} / ${fmtBytes(s.maxdisk)}`} />
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card title={`VMs and containers (${pve.guests.length})`} actions={<input type="search" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />}>
        <div className="guest-list">
          {guests.map((g) => (
            <GuestRow key={g.id} g={g} onOpen={() => setParams({ vm: String(g.vmid) })} />
          ))}
        </div>
      </Card>
      {guest && <GuestModal g={guest} onClose={() => setParams({})} />}
    </div>
  );
}

function GuestRow({ g, onOpen }: { g: PveGuest; onOpen: () => void }) {
  const running = g.status === 'running';
  return (
    <button className="guest-row" onClick={onOpen}>
      <span className="row-title">
        <Dot tone={g.template ? 'off' : running ? 'ok' : 'off'} /> {g.name}
      </span>
      <span className="muted small">{g.type === 'qemu' ? 'VM' : 'LXC'} {g.vmid}{g.template ? ' · template' : ''}{g.tags ? ` · ${g.tags.split(';').join(', ')}` : ''}</span>
      {running ? (
        <>
          <Meter value={g.cpu} label={`CPU ${fmtPct(g.cpu)}`} />
          <Meter value={g.maxmem ? g.mem / g.maxmem : 0} label={`${fmtBytes(g.mem)} / ${fmtBytes(g.maxmem)}`} />
        </>
      ) : (
        <span className="muted small span-meters">{g.status}</span>
      )}
    </button>
  );
}

function GuestModal({ g, onClose }: { g: PveGuest; onClose: () => void }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [snapName, setSnapName] = useState('');
  const snaps = useQuery({ queryKey: ['snaps', g.vmid], queryFn: () => get<{ name: string; description: string; time?: number }[]>(`/proxmox/guests/${g.vmid}/snapshots`) });
  const running = g.status === 'running';

  const power = async (action: 'start' | 'shutdown' | 'stop' | 'reboot') => {
    if (action !== 'start') {
      const ok = await confirm({
        title: `${action === 'stop' ? 'Force stop' : action[0].toUpperCase() + action.slice(1)} ${g.name}?`,
        danger: action === 'stop',
        confirm: action === 'stop' ? 'Force stop' : action === 'shutdown' ? 'Shut down' : 'Reboot',
        body: <p>{action === 'stop' ? 'This cuts power immediately, like pulling the plug. Unsaved data may be lost. Prefer Shut down.' : action === 'shutdown' ? 'Asks the guest OS to shut down cleanly.' : 'Asks the guest to restart.'}</p>,
      });
      if (!ok) return;
    }
    await run(action, () => post(`/proxmox/guests/${g.vmid}/${action}`), `${g.name}: ${action} requested`);
  };

  return (
    <Modal title={`${g.name} (${g.type === 'qemu' ? 'VM' : 'LXC'} ${g.vmid})`} onClose={onClose}>
      <p className="muted small">
        {g.status} on {g.node} · {g.maxcpu} cores · {fmtBytes(g.maxmem)} RAM · disk {fmtBytes(g.maxdisk)}
        {running && ` · up ${fmtUptime(g.uptime)}`}
      </p>
      {!g.template && (
        <div className="btn-row">
          {!running && <button className="btn btn-primary" disabled={!!busy} onClick={() => power('start')}>{busy === 'start' ? <Spinner /> : '▶'} Start</button>}
          {running && <button className="btn" disabled={!!busy} onClick={() => power('shutdown')}>Shut down</button>}
          {running && <button className="btn" disabled={!!busy} onClick={() => power('reboot')}>Reboot</button>}
          {running && <button className="btn btn-danger-outline" disabled={!!busy} onClick={() => power('stop')}>Force stop</button>}
        </div>
      )}
      <h3>Snapshots</h3>
      {snaps.isLoading && <Spinner />}
      {snaps.error && <p className="problem-error-text small">{(snaps.error as Error).message}</p>}
      <ul className="list small">
        {snaps.data?.map((s) => (
          <li key={s.name} className="history-row">
            <span>{s.name}{s.description && <span className="muted"> · {s.description}</span>}</span>
            <span className="muted">{s.time ? `${fmtAgo(s.time)} ago` : ''}</span>
          </li>
        ))}
        {snaps.data && !snaps.data.length && <li className="muted">No snapshots.</li>}
      </ul>
      <div className="inline-form">
        <input placeholder="snapshot-name" value={snapName} onChange={(e) => setSnapName(e.target.value.replace(/\s/g, '-'))} />
        <button
          className="btn"
          disabled={!snapName || !!busy}
          onClick={async () => {
            const r = await run('snap', () => post(`/proxmox/guests/${g.vmid}/snapshots`, { name: snapName, description: 'Created from homelab-ui' }), `Snapshot ${snapName} requested`);
            if (r) {
              setSnapName('');
              setTimeout(() => void snaps.refetch(), 3000);
            }
          }}
        >
          Take snapshot
        </button>
      </div>
    </Modal>
  );
}
