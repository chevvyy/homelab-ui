import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router';
import { CommandPalette } from './components/CommandPalette';
import { useLive } from './live';
import { Activity } from './pages/Activity';
import { AppDetail } from './pages/AppDetail';
import { Apps } from './pages/Apps';
import { Cluster } from './pages/Cluster';
import { Dashboard } from './pages/Dashboard';
import { Deploy } from './pages/Deploy';
import { Proxmox } from './pages/Proxmox';
import { Settings } from './pages/Settings';
import { TrueNas } from './pages/TrueNas';
import { Dot, fmtAgo } from './ui';

function useHealth() {
  const apps = useLive((s) => s.apps);
  const pve = useLive((s) => s.proxmox);
  const tn = useLive((s) => s.truenas);
  const failing = apps.filter((a) => a.status === 'failed' || a.status === 'degraded').length;
  const alerts = tn?.alerts.filter((a) => !a.dismissed && a.level !== 'INFO').length ?? 0;
  return { failing, alerts, pveDown: !!pve?.configured && !pve.connected, tnDown: !!tn?.configured && !tn.connected };
}

const NAV = [
  { to: '/', label: 'Dashboard', icon: '◧' },
  { to: '/apps', label: 'Apps', icon: '▤' },
  { to: '/deploy', label: 'Deploy', icon: '+' },
  { to: '/cluster', label: 'Cluster', icon: '⬡' },
  { to: '/proxmox', label: 'Proxmox', icon: '▣' },
  { to: '/truenas', label: 'TrueNAS', icon: '◫' },
  { to: '/activity', label: 'Activity', icon: '↻' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export function App() {
  const connected = useLive((s) => s.connected);
  const lastMessage = useLive((s) => s.lastMessage);
  const user = useLive((s) => s.user);
  const health = useHealth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const badge = (to: string) => {
    if (to === '/apps' && health.failing) return <span className="nav-count bad">{health.failing}</span>;
    if (to === '/truenas' && (health.alerts || health.tnDown)) return <span className="nav-count warn">{health.tnDown ? '!' : health.alerts}</span>;
    if (to === '/proxmox' && health.pveDown) return <span className="nav-count warn">!</span>;
    return null;
  };

  return (
    <div className={`shell ${menuOpen ? 'menu-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>Homelab</span>
        </div>
        <button className="search-btn" onClick={() => setPaletteOpen(true)}>
          <span>Search…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
              <span className="nav-icon" aria-hidden>
                {n.icon}
              </span>
              <span className="nav-label">{n.label}</span>
              {badge(n.to)}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="conn">
            <Dot tone={connected ? 'ok' : 'bad'} /> {connected ? 'Live' : 'Reconnecting…'}
          </div>
          {user && (
            <div className="who" title={`${user.login} on ${user.device}`}>
              {user.avatar && <img src={user.avatar} alt="" width={22} height={22} />}
              <span>{user.name}</span>
            </div>
          )}
        </div>
      </aside>
      <div className="scrim" onClick={() => setMenuOpen(false)} />
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu">
            ☰
          </button>
          <span className="topbar-title">Homelab</span>
          <button className="icon-btn" onClick={() => setPaletteOpen(true)} aria-label="Search">
            ⌕
          </button>
        </header>
        {!connected && (
          <div className="banner banner-bad">
            Disconnected from the controller. Retrying… {lastMessage ? `Data shown is from ${fmtAgo(lastMessage)} ago.` : ''}
          </div>
        )}
        <main className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/apps" element={<Apps />} />
            <Route path="/apps/:namespace/:name" element={<AppDetail />} />
            <Route path="/deploy" element={<Deploy />} />
            <Route path="/cluster" element={<Cluster />} />
            <Route path="/proxmox" element={<Proxmox />} />
            <Route path="/truenas" element={<TrueNas />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<p>Page not found.</p>} />
          </Routes>
        </main>
      </div>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
