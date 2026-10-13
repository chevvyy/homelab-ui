import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { appPath, get } from '../api';
import { useLive } from '../live';
import type { Build } from '../types';
import { Card, Empty, fmtAgo } from '../ui';

export function Activity() {
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => get<{ id: number; at: number; user: string; action: string; target: string; ok: boolean; detail?: string }[]>('/audit'), refetchInterval: 15_000 });
  const stored = useQuery({ queryKey: ['builds'], queryFn: () => get<Build[]>('/builds') });
  const live = useLive((s) => s.builds);
  const builds = Object.values({ ...Object.fromEntries((stored.data ?? []).map((b) => [b.id, b])), ...live }).sort((a, b) => b.at - a.at);

  return (
    <div className="page">
      <h1>Activity</h1>
      <Card title="GitHub deploys">
        {!builds.length && <Empty>No GitHub deploys yet.</Empty>}
        <ul className="list">
          {builds.slice(0, 20).map((b) => (
            <li key={b.id}>
              <details>
                <summary className="history-row">
                  <span>
                    <span className={`badge build-${b.state}`}>{b.state}</span> <Link to={appPath(`${b.namespace}/${b.app}`)}>{b.app}</Link>{' '}
                    <span className="muted small">{b.data.repo}@{b.data.sha.slice(0, 7)} ({b.data.mode})</span>
                  </span>
                  <span className="muted small">{b.user} · {fmtAgo(b.at)} ago</span>
                </summary>
                {b.data.runUrl && <a href={b.data.runUrl} target="_blank" rel="noreferrer" className="small">GitHub Actions run</a>}
                <pre className="logbox small">{b.data.log.join('\n')}</pre>
              </details>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="All actions">
        {!audit.data?.length && <Empty>Nothing yet.</Empty>}
        <table className="table">
          <tbody>
            {audit.data?.map((a) => (
              <tr key={a.id}>
                <td className="small muted">{fmtAgo(a.at)} ago</td>
                <td className={a.ok ? '' : 'problem-error-text'}>{a.action}{a.ok ? '' : ' ✕'}</td>
                <td className="small mono ellipsis">{a.target}</td>
                <td className="small muted hide-sm">{a.user}</td>
                <td className="small muted ellipsis hide-sm" title={a.detail ?? ''}>{!a.ok ? a.detail : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
