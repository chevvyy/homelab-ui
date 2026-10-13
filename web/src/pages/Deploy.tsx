import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { appPath, get, post } from '../api';
import { useLive } from '../live';
import type { DeployResult, Exposure } from '../types';
import { Card, ErrorBox, ProblemCard, Spinner, Tabs, useAction } from '../ui';

type Mode = 'image' | 'yaml' | 'github';

const NAME_RE = /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/;

export function detectKind(text: string): Mode | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (/github\.com\//i.test(t)) return 'github';
  if (/^\s*(apiVersion|kind):/m.test(t) || t.includes('\n')) return 'yaml';
  return 'image';
}

function suggestName(text: string): string {
  const t = text.trim();
  const gh = /github\.com\/[^/]+\/([^/#?]+)/i.exec(t);
  const base = gh ? gh[1].replace(/\.git$/, '') : t.split('@')[0].split(':')[0].split('/').pop() ?? '';
  return base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 53);
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => get('/me'), staleTime: Infinity });
}

export function Deploy() {
  const [params] = useSearchParams();
  const [quick, setQuick] = useState(params.get('repo') ?? '');
  const [mode, setMode] = useState<Mode>(params.get('repo') ? 'github' : 'image');
  const detected = detectKind(quick);
  useEffect(() => {
    if (detected) setMode(detected);
  }, [detected]);

  return (
    <div className="page">
      <h1>Deploy an app</h1>
      <Card>
        <label className="field">
          <span>Paste an image, a GitHub repo URL, or Kubernetes YAML</span>
          <textarea className="mono quick" rows={quick.includes('\n') ? 6 : 1} placeholder="ghcr.io/owner/app:1.0   ·   https://github.com/owner/repo   ·   apiVersion: apps/v1 …" value={quick} onChange={(e) => setQuick(e.target.value)} />
        </label>
        {detected && <p className="muted small">Looks like {detected === 'github' ? 'a GitHub repository' : detected === 'yaml' ? 'YAML manifests' : 'a container image'}.</p>}
      </Card>
      <Tabs value={mode} onChange={setMode} tabs={[{ id: 'image', label: 'Container image' }, { id: 'github', label: 'GitHub repo' }, { id: 'yaml', label: 'YAML' }]} />
      {mode === 'image' && <ImageForm key="image" initial={detected === 'image' ? quick.trim() : ''} />}
      {mode === 'github' && <GitHubForm key="github" initial={detected === 'github' ? quick.trim() : ''} />}
      {mode === 'yaml' && <YamlForm key="yaml" initial={detected === 'yaml' ? quick : ''} />}
    </div>
  );
}

function NamespaceSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const namespaces = useLive((s) => s.cluster?.namespaces ?? []);
  const me = useMe();
  const def = me.data?.config.appsNamespace ?? 'homelab-apps';
  return (
    <label className="field">
      <span>Namespace</span>
      <select value={value || def} onChange={(e) => onChange(e.target.value)}>
        {[...new Set([def, ...namespaces])].filter((n) => !/^(kube-|cattle-|fleet-)/.test(n)).map((n) => (
          <option key={n}>{n}</option>
        ))}
      </select>
    </label>
  );
}

function ExposurePicker({ app, value, onChange, host, setHost }: { app: string; value: Exposure; onChange: (v: Exposure) => void; host: string; setHost: (h: string) => void }) {
  const me = useMe();
  const pub = me.data?.config.publicDomain ?? 'howellsas.com';
  const lan = me.data?.config.internalDomain ?? 'lan.howellsas.com';
  const effective = host || (value === 'public' ? `${app}.${pub}` : value === 'internal' ? `${app}.${lan}` : '');
  const check = useQuery({
    queryKey: ['host', effective],
    queryFn: () => get<{ ok: boolean; message?: string }>(`/hosts/check?host=${encodeURIComponent(effective)}`),
    enabled: value !== 'off' && !!app && NAME_RE.test(app),
  });
  return (
    <div className="field">
      <span>Access</span>
      <div className="segmented">
        {(['off', 'internal', 'public'] as Exposure[]).map((m) => (
          <button type="button" key={m} className={value === m ? `seg active seg-${m}` : 'seg'} onClick={() => onChange(m)}>
            {m === 'off' ? 'Off' : m === 'internal' ? 'Internal (Tailscale)' : 'Public'}
          </button>
        ))}
      </div>
      {value !== 'off' && (
        <>
          <input placeholder={effective} value={host} onChange={(e) => setHost(e.target.value.toLowerCase())} aria-label="Hostname" />
          <span className={`small ${check.data && !check.data.ok ? 'problem-error-text' : 'muted'}`}>
            {check.data ? (check.data.ok ? `${effective} is available` : check.data.message) : ' '}
          </span>
        </>
      )}
    </div>
  );
}

function Plan({ result }: { result: DeployResult }) {
  return (
    <div className="plan">
      {result.warnings.map((w, i) => (
        <div key={i} className="alert alert-warning">{w}</div>
      ))}
      <table className="table">
        <tbody>
          {result.items.map((i) => (
            <tr key={`${i.kind}/${i.name}`}>
              <td>{i.kind}</td>
              <td className="mono">{i.name}</td>
              <td>{i.problem ? <span className="problem-error-text">error</span> : <span className={`tag tag-${i.action}`}>{i.action}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.items.filter((i) => i.problem).map((i) => (
        <ProblemCard key={`p${i.kind}${i.name}`} p={{ ...i.problem!, title: `${i.kind}/${i.name}: ${i.problem!.title}` }} />
      ))}
    </div>
  );
}

function Done({ result, url }: { result: DeployResult; url?: string }) {
  return (
    <div className="success">
      <strong>Deployed {result.app}.</strong> <Link to={appPath(`${result.namespace}/${result.app}`)}>Open the app →</Link>
      {url && (
        <>
          {' '}· <a href={url} target="_blank" rel="noreferrer">{url}</a>
        </>
      )}
    </div>
  );
}

function ImageForm({ initial }: { initial: string }) {
  const me = useMe();
  const [image, setImage] = useState(initial);
  const [app, setApp] = useState(suggestName(initial));
  const [namespace, setNamespace] = useState('');
  const [port, setPort] = useState('');
  const [replicas, setReplicas] = useState(1);
  const [env, setEnv] = useState('');
  const [volume, setVolume] = useState(false);
  const [size, setSize] = useState('1Gi');
  const [mountPath, setMountPath] = useState('/data');
  const [storageClass, setStorageClass] = useState('');
  const [memoryLimit, setMemoryLimit] = useState('1Gi');
  const [exposure, setExposure] = useState<Exposure>('off');
  const [host, setHost] = useState('');
  const [plan, setPlan] = useState<DeployResult>();
  const [done, setDone] = useState<{ result: DeployResult; url?: string }>();
  const [error, setError] = useState<unknown>();
  const { busy, run } = useAction();

  useEffect(() => {
    setImage(initial);
    if (initial) setApp(suggestName(initial));
  }, [initial]);

  const check = useQuery({
    queryKey: ['image', image.trim()],
    queryFn: () => post<{ status: string; message: string }>('/image/check', { image: image.trim() }),
    enabled: image.trim().length > 2,
    staleTime: 60_000,
  });

  const body = useMemo(
    () => ({
      app,
      namespace: namespace || undefined,
      image: image.trim(),
      port: port ? Number(port) : undefined,
      replicas,
      env: parseEnv(env),
      memoryLimit,
      volume: volume ? { size, mountPath, storageClass: storageClass || undefined } : undefined,
      exposure,
      host: host || undefined,
    }),
    [app, namespace, image, port, replicas, env, memoryLimit, volume, size, mountPath, storageClass, exposure, host],
  );
  useEffect(() => setPlan(undefined), [body]);

  const nameOk = NAME_RE.test(app);
  const preview = async () => {
    setError(undefined);
    try {
      setPlan(await post<DeployResult>('/deploy/image', { ...body, dryRun: true }));
    } catch (e) {
      setError(e);
    }
  };
  const deploy = async () => {
    setError(undefined);
    const r = await run('deploy', () => post<DeployResult>('/deploy/image', { ...body, dryRun: false }));
    if (r) setDone({ result: r, url: r.exposure?.url });
  };

  if (done) return <Card><Done {...done} /></Card>;
  return (
    <Card>
      <form className="form-grid" onSubmit={(e) => (e.preventDefault(), void preview())}>
        <label className="field span-2">
          <span>Image</span>
          <input className="mono" required value={image} onChange={(e) => setImage(e.target.value)} placeholder="ghcr.io/owner/app:1.0" />
          {check.data && <span className={`small ${check.data.status === 'found' ? 'ok-text' : check.data.status === 'missing' || check.data.status === 'invalid' ? 'problem-error-text' : 'problem-warning-text'}`}>{check.data.message}</span>}
        </label>
        <label className="field">
          <span>App name</span>
          <input required value={app} onChange={(e) => setApp(e.target.value.toLowerCase())} />
          {app && !nameOk && <span className="small problem-error-text">Lowercase letters, digits and dashes only</span>}
        </label>
        <NamespaceSelect value={namespace} onChange={setNamespace} />
        <label className="field">
          <span>Port the app listens on</span>
          <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} placeholder="e.g. 8080 (blank = no Service)" />
        </label>
        <label className="field">
          <span>Replicas</span>
          <input type="number" min={0} max={50} value={replicas} onChange={(e) => setReplicas(Number(e.target.value))} />
        </label>
        <label className="field span-2">
          <span>Environment variables (one KEY=value per line)</span>
          <textarea className="mono" rows={3} value={env} onChange={(e) => setEnv(e.target.value)} placeholder={'TZ=America/Chicago\nLOG_LEVEL=info'} />
        </label>
        <label className="field">
          <span>Memory limit</span>
          <input value={memoryLimit} onChange={(e) => setMemoryLimit(e.target.value)} />
        </label>
        <div className="field">
          <span>Storage</span>
          <label className="check">
            <input type="checkbox" checked={volume} onChange={(e) => setVolume(e.target.checked)} /> Persistent volume
          </label>
        </div>
        {volume && (
          <>
            <label className="field">
              <span>Size</span>
              <input value={size} onChange={(e) => setSize(e.target.value)} />
            </label>
            <label className="field">
              <span>Mount path</span>
              <input className="mono" value={mountPath} onChange={(e) => setMountPath(e.target.value)} />
            </label>
            <label className="field span-2">
              <span>Storage class</span>
              <select value={storageClass} onChange={(e) => setStorageClass(e.target.value)}>
                <option value="">{me.data?.config.storageClass ?? 'nfs-bulk'} (NAS, default)</option>
                <option value={me.data?.config.dbStorageClass ?? 'local-path'}>{me.data?.config.dbStorageClass ?? 'local-path'} (node disk, for databases)</option>
              </select>
            </label>
          </>
        )}
        <div className="span-2">
          {port ? <ExposurePicker app={app} value={exposure} onChange={setExposure} host={host} setHost={setHost} /> : <p className="muted small">Set a port to make the app reachable.</p>}
        </div>
        <div className="span-2 btn-row">
          <button className="btn" type="submit" disabled={!nameOk || !image.trim()}>Preview</button>
          <button className="btn btn-primary" type="button" disabled={!plan?.ok || !!busy || check.data?.status === 'missing'} onClick={deploy}>
            {busy ? <Spinner /> : null} Deploy
          </button>
        </div>
      </form>
      <ErrorBox error={error} />
      {plan && <Plan result={plan} />}
    </Card>
  );
}

function YamlForm({ initial }: { initial: string }) {
  const [yaml, setYaml] = useState(initial);
  const [app, setApp] = useState('');
  const [namespace, setNamespace] = useState('');
  const [plan, setPlan] = useState<DeployResult>();
  const [done, setDone] = useState<DeployResult>();
  const [error, setError] = useState<unknown>();
  const { busy, run } = useAction();
  useEffect(() => setYaml(initial), [initial]);
  useEffect(() => {
    if (!app) {
      const m = /^\s*name:\s*([a-z0-9-]+)/m.exec(yaml);
      if (m) setApp(m[1]);
    }
  }, [yaml, app]);
  useEffect(() => setPlan(undefined), [yaml, app, namespace]);
  const nameOk = NAME_RE.test(app);

  const loadFile = async (f?: File | null) => f && setYaml(await f.text());

  if (done) return <Card><Done result={done} /></Card>;
  return (
    <Card>
      <div className="form-grid">
        <label className="field">
          <span>App name (groups everything below)</span>
          <input value={app} onChange={(e) => setApp(e.target.value.toLowerCase())} />
        </label>
        <NamespaceSelect value={namespace} onChange={setNamespace} />
        <label className="field span-2" onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.preventDefault(), void loadFile(e.dataTransfer.files[0]))}>
          <span>
            Manifests (multi-document YAML; drop a file here or <input type="file" accept=".yaml,.yml" onChange={(e) => void loadFile(e.target.files?.[0])} />)
          </span>
          <textarea className="mono" rows={16} value={yaml} onChange={(e) => setYaml(e.target.value)} spellCheck={false} />
        </label>
        <p className="muted small span-2">Every object gets the app's labels and is deployed into the selected namespace. Previewing runs a server-side dry run, so the API server validates everything before anything changes.</p>
        <div className="span-2 btn-row">
          <button className="btn" disabled={!nameOk || !yaml.trim()} onClick={async () => { setError(undefined); try { setPlan(await post('/deploy/yaml', { app, namespace: namespace || undefined, yaml, dryRun: true })); } catch (e) { setError(e); } }}>Preview</button>
          <button className="btn btn-primary" disabled={!plan?.ok || !!busy} onClick={async () => { const r = await run('apply', () => post<DeployResult>('/deploy/yaml', { app, namespace: namespace || undefined, yaml, dryRun: false })); if (r?.ok) setDone(r); else if (r) setPlan(r); }}>
            {busy ? <Spinner /> : null} Apply
          </button>
        </div>
      </div>
      <ErrorBox error={error} />
      {plan && <Plan result={plan} />}
    </Card>
  );
}

type Inspection = { owner: string; repo: string; private: boolean; branch: string; sha: string; message: string; mode: 'manifests' | 'dockerfile' | 'none'; path?: string; kustomize: boolean; objects?: { kind: string; name: string }[]; exposePort?: number; notes: string[] };

function GitHubForm({ initial }: { initial: string }) {
  const [repo, setRepo] = useState(initial);
  const [branch, setBranch] = useState('');
  const [insp, setInsp] = useState<Inspection>();
  const [app, setApp] = useState(suggestName(initial));
  const [namespace, setNamespace] = useState('');
  const [port, setPort] = useState('');
  const [env, setEnv] = useState('');
  const [exposure, setExposure] = useState<Exposure>('off');
  const [host, setHost] = useState('');
  const [buildId, setBuildId] = useState<string>();
  const [error, setError] = useState<unknown>();
  const { busy, run } = useAction();
  const build = useLive((s) => (buildId ? s.builds[buildId] : undefined), buildId);

  useEffect(() => {
    setRepo(initial);
    if (initial) setApp(suggestName(initial));
    setInsp(undefined);
  }, [initial]);

  const inspect = async () => {
    setError(undefined);
    const r = await run('inspect', () => post<Inspection>('/github/inspect', { repo, branch: branch || undefined }));
    if (r) {
      setInsp(r);
      if (r.exposePort) setPort(String(r.exposePort));
    }
  };
  const deploy = async () => {
    const r = await run('deploy', () =>
      post<{ id: string }>('/deploy/github', { repo, branch: branch || undefined, sha: insp?.sha, app, namespace: namespace || undefined, port: port ? Number(port) : undefined, env: parseEnv(env), exposure, host: host || undefined }),
    );
    if (r) setBuildId(r.id);
  };

  if (buildId) {
    return (
      <Card title={`Deploying ${app}`}>
        {!build && <Spinner />}
        {build && (
          <>
            <p>
              <span className={`badge build-${build.state}`}>{build.state}</span> {build.data.repo}@{build.data.sha.slice(0, 7)}
              {build.data.runUrl && (
                <>
                  {' · '}
                  <a href={build.data.runUrl} target="_blank" rel="noreferrer">Actions run</a>
                </>
              )}
            </p>
            {build.data.steps && (
              <ol className="steps">
                {build.data.steps.map((s) => (
                  <li key={s.name} className={`step step-${s.conclusion ?? s.status}`}>{s.name}</li>
                ))}
              </ol>
            )}
            <pre className="logbox small">{build.data.log.join('\n')}</pre>
            {build.state === 'failed' && <ProblemCard p={{ severity: 'error', title: 'Deploy failed', cause: build.data.error ?? '', fix: 'Fix the cause above and deploy again.' }} />}
            {build.state === 'succeeded' && <Link className="btn btn-primary" to={appPath(`${build.namespace}/${build.app}`)}>Open {build.app} →</Link>}
          </>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <div className="form-grid">
        <label className="field span-2">
          <span>Repository</span>
          <input className="mono" value={repo} onChange={(e) => (setRepo(e.target.value), setInsp(undefined))} placeholder="https://github.com/owner/repo" />
        </label>
        <label className="field">
          <span>Branch (blank = default)</span>
          <input value={branch} onChange={(e) => (setBranch(e.target.value), setInsp(undefined))} />
        </label>
        <div className="field">
          <span>&nbsp;</span>
          <button className="btn" disabled={!repo.trim() || !!busy} onClick={inspect}>{busy === 'inspect' ? <Spinner /> : null} Inspect repo</button>
        </div>
      </div>
      <ErrorBox error={error} />
      {insp && (
        <>
          <div className="inspect">
            <p>
              <strong>{insp.owner}/{insp.repo}</strong>{insp.private && <span className="tag">private</span>} @ <code>{insp.sha.slice(0, 7)}</code> ({insp.branch}): {insp.message}
            </p>
            {insp.mode === 'manifests' && (
              <p>Found {insp.kustomize ? 'a kustomization' : 'manifests'} in <code>{insp.path || '/'}</code>: {insp.objects?.map((o) => `${o.kind}/${o.name}`).join(', ')}</p>
            )}
            {insp.mode === 'dockerfile' && <p>Found a Dockerfile. It will be built by GitHub Actions, pushed to GHCR, then deployed.</p>}
            {insp.notes.map((n, i) => (
              <div key={i} className="alert alert-warning">{n}</div>
            ))}
          </div>
          {insp.mode !== 'none' && (
            <div className="form-grid">
              <label className="field">
                <span>App name</span>
                <input value={app} onChange={(e) => setApp(e.target.value.toLowerCase())} />
              </label>
              <NamespaceSelect value={namespace} onChange={setNamespace} />
              {insp.mode === 'dockerfile' && (
                <>
                  <label className="field">
                    <span>Port the app listens on</span>
                    <input type="number" value={port} onChange={(e) => setPort(e.target.value)} />
                  </label>
                  <label className="field span-2">
                    <span>Environment (KEY=value per line)</span>
                    <textarea className="mono" rows={3} value={env} onChange={(e) => setEnv(e.target.value)} />
                  </label>
                </>
              )}
              <div className="span-2">
                <ExposurePicker app={app} value={exposure} onChange={setExposure} host={host} setHost={setHost} />
              </div>
              <div className="span-2 btn-row">
                <button className="btn btn-primary" disabled={!NAME_RE.test(app) || !!busy} onClick={deploy}>
                  {busy === 'deploy' ? <Spinner /> : null} {insp.mode === 'dockerfile' ? 'Build & deploy' : 'Deploy'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
