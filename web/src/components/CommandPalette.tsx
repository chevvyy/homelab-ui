// Ctrl+K: jump to any page, app, VM or container, or restart an app, by typing.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { appPath, post } from '../api';
import { useLive } from '../live';
import { useToast } from '../ui';

interface Item {
  id: string;
  label: string;
  hint: string;
  run: () => void | Promise<void>;
}

const PAGES = [
  ['Dashboard', '/'],
  ['Apps', '/apps'],
  ['Deploy an app', '/deploy'],
  ['Cluster nodes', '/cluster'],
  ['Proxmox', '/proxmox'],
  ['TrueNAS', '/truenas'],
  ['Activity', '/activity'],
  ['Settings', '/settings'],
];

function score(text: string, q: string): number {
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 3;
  if (t.includes(q)) return 2;
  // Loose subsequence match ("srr" -> "sonarr").
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 1 : 0;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const apps = useLive((s) => s.apps);
  const guests = useLive((s) => s.proxmox?.guests ?? []);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);

  const items = useMemo(() => {
    const query = q.trim().toLowerCase();
    const restart = query.startsWith('restart ');
    const term = restart ? query.slice(8) : query;
    const all: (Item & { s: number })[] = [];
    if (!restart) {
      for (const [label, to] of PAGES) all.push({ id: `page:${to}`, label, hint: 'Page', run: () => navigate(to), s: score(label, term) });
      for (const g of guests) all.push({ id: `vm:${g.vmid}`, label: g.name, hint: `${g.type === 'qemu' ? 'VM' : 'LXC'} ${g.vmid} · ${g.status}`, run: () => navigate(`/proxmox?vm=${g.vmid}`), s: score(g.name, term) });
    }
    for (const a of apps) {
      const s = Math.max(score(a.name, term), score(a.id, term));
      if (restart) {
        const w = a.workloads.find((x) => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(x.kind));
        if (!w || a.protected) continue;
        all.push({
          id: `restart:${a.id}`,
          label: `Restart ${a.name}`,
          hint: a.namespace,
          s,
          run: async () => {
            try {
              await post(`${appPath(a.id)}/restart`, { kind: w.kind, workload: w.name });
              toast('ok', `Restarting ${a.name}`);
            } catch (e) {
              toast('bad', e instanceof Error ? e.message : String(e));
            }
          },
        });
      } else all.push({ id: `app:${a.id}`, label: a.name, hint: `${a.namespace} · ${a.status}`, run: () => navigate(appPath(a.id)), s });
    }
    return all.filter((i) => i.s > 0).sort((a, b) => b.s - a.s).slice(0, 12);
  }, [q, apps, guests, navigate, toast]);

  const choose = async (i: Item | undefined) => {
    if (!i) return;
    onClose();
    await i.run();
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          autoFocus
          placeholder='Jump to an app, VM or page… (type "restart " to restart an app)'
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(s + 1, items.length - 1)));
            if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
            if (e.key === 'Enter') void choose(items[sel]);
          }}
        />
        <ul>
          {items.map((i, idx) => (
            <li key={i.id} className={idx === sel ? 'sel' : ''} onMouseEnter={() => setSel(idx)} onClick={() => void choose(i)}>
              <span>{i.label}</span>
              <span className="muted">{i.hint}</span>
            </li>
          ))}
          {!items.length && <li className="muted">No matches</li>}
        </ul>
      </div>
    </div>
  );
}
