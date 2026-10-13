import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post, put } from '../api';
import { useLive } from '../live';
import { Card, Dot, Spinner, useAction } from '../ui';

type Connections = {
  proxmox: { url?: string; tokenId?: string; hasSecret: boolean; connected: boolean; error?: string };
  truenas: { url?: string; username?: string; hasSecret: boolean; connected: boolean; error?: string; apiVersion?: string };
  github: { owner: string; hasSecret: boolean };
};

export function Settings() {
  const q = useQuery({ queryKey: ['connections'], queryFn: () => get<Connections>('/connections') });
  const user = useLive((s) => s.user);
  const me = useQuery({ queryKey: ['me'], queryFn: () => get('/me'), staleTime: Infinity });
  if (!q.data) return <div className="page"><h1>Settings</h1><Spinner /></div>;
  const c = q.data;
  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="muted small">
        Credentials are stored as Kubernetes Secrets in the controller's namespace and never sent to the browser. Leave a secret field blank to keep the current value; fill it in to rotate it.
      </p>
      <ConnectionForm
        system="proxmox"
        title="Proxmox VE"
        status={c.proxmox}
        fields={[
          { key: 'url', label: 'URL', placeholder: 'https://192.168.0.36:8006', value: c.proxmox.url },
          { key: 'tokenId', label: 'API token ID', placeholder: 'root@pam!homelab-ui', value: c.proxmox.tokenId },
          { key: 'secret', label: 'Token secret', secret: true, has: c.proxmox.hasSecret },
        ]}
      />
      <ConnectionForm
        system="truenas"
        title={`TrueNAS${c.truenas.apiVersion ? ` (API ${c.truenas.apiVersion})` : ''}`}
        status={c.truenas}
        fields={[
          { key: 'url', label: 'URL', placeholder: 'wss://192.168.0.215', value: c.truenas.url },
          { key: 'username', label: 'API key user (optional)', placeholder: 'homelab-ui', value: c.truenas.username },
          { key: 'apiKey', label: 'API key', secret: true, has: c.truenas.hasSecret },
        ]}
      />
      <ConnectionForm
        system="github"
        title={`GitHub (deploys as ${c.github.owner})`}
        status={{ connected: c.github.hasSecret }}
        noTest
        fields={[{ key: 'token', label: 'Fine-grained token', secret: true, has: c.github.hasSecret }]}
      />
      <Card title="About">
        <p className="small">
          Signed in as <strong>{user?.login}</strong> from {user?.device} (Tailscale). New apps deploy to <code>{me.data?.config.appsNamespace}</code>; public apps get <code>*.{me.data?.config.publicDomain}</code>, internal apps <code>*.{me.data?.config.internalDomain}</code>.
        </p>
      </Card>
    </div>
  );
}

type Field = { key: string; label: string; placeholder?: string; value?: string; secret?: boolean; has?: boolean };

function ConnectionForm({ system, title, status, fields, noTest }: { system: string; title: string; status: { connected: boolean; error?: string }; fields: Field[]; noTest?: boolean }) {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.secret ? '' : f.value ?? ''])));
  const [result, setResult] = useState<string>();
  const { busy, run } = useAction();
  return (
    <Card
      title={
        <>
          <Dot tone={status.connected ? 'ok' : status.error ? 'bad' : 'off'} /> {title}
        </>
      }
    >
      {status.error && <p className="problem-error-text small">{status.error}</p>}
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await run('save', () => put(`/connections/${system}`, values), 'Saved');
          if (r) {
            setValues((v) => Object.fromEntries(Object.entries(v).map(([k, val]) => [k, fields.find((f) => f.key === k)?.secret ? '' : val])));
            void qc.invalidateQueries({ queryKey: ['connections'] });
          }
        }}
      >
        {fields.map((f) => (
          <label key={f.key} className="field">
            <span>{f.label}</span>
            <input
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              placeholder={f.secret ? (f.has ? '•••••••• (stored; type to replace)' : 'not set') : f.placeholder}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          </label>
        ))}
        <div className="span-2 btn-row">
          {!noTest && (
            <button
              type="button"
              className="btn"
              disabled={!!busy}
              onClick={async () => {
                setResult(undefined);
                const r = await run('test', () => post<{ message: string }>(`/connections/${system}/test`, values));
                if (r) setResult(r.message);
              }}
            >
              {busy === 'test' ? <Spinner /> : null} Test connection
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={!!busy}>
            Save
          </button>
          {result && <span className="ok-text small">{result}</span>}
        </div>
      </form>
    </Card>
  );
}
