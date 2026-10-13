// Deploys from a GitHub repo. The commit is pinned by SHA, then the repo is inspected in order:
//   1. kustomization.yaml at the root      -> kubectl kustomize
//   2. k8s/ or deploy/ folder               -> kustomize if it has a kustomization, else all YAML
//   3. Dockerfile                           -> build in GitHub Actions, push to GHCR, deploy image
// Builds run in Actions (not in-cluster) so no node-level registry config is needed:
//   - repos owned by GITHUB_OWNER get a dispatchable workflow committed to them;
//   - other public repos are built by a private "<owner>/homelab-builds" repo that checks them out.
// The controller's token (Secret homelab-ui/github) never leaves the controller.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { config } from './config.js';
import { audit, getBuild, listBuilds, saveBuild } from './db.js';
import { applyObjects, deployImage, parseYaml, validateName } from './k8s/deploy.js';
import { setExposure } from './k8s/exposure.js';
import { readSecret } from './secrets.js';

const run = promisify(execFile);
const API = 'https://api.github.com';
const WORKFLOW_FILE = 'homelab-ui-build.yml';
const BUILDER_REPO = 'homelab-builds';
const MAX_TARBALL = 100 * 1024 * 1024;

export class GitHubError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

async function token(): Promise<string> {
  const s = await readSecret('github').catch(() => undefined);
  if (!s?.token) throw new GitHubError('No GitHub token configured. Create the "github" Secret in homelab-ui (see Settings).', 412);
  return s.token;
}

async function gh<T = any>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'homelab-ui',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      msg = JSON.parse(text).message ?? text;
    } catch {
      /* keep text */
    }
    if (res.status === 401) throw new GitHubError('GitHub rejected the controller token (expired or revoked). Replace it in Settings.', 401);
    if (res.status === 403 || (res.status === 404 && /resource not accessible/i.test(msg)))
      throw new GitHubError(`The controller's GitHub token lacks a permission for this (${msg}). It needs Contents, Actions, Workflows and Administration read/write.`, 403);
    throw new GitHubError(`GitHub ${res.status}: ${msg}`, res.status === 404 ? 404 : 502);
  }
  if (raw) return res as unknown as T;
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export function parseRepo(url: string): { owner: string; repo: string } {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/.exec(url.trim()) ?? /^([\w.-]+)\/([\w.-]+)$/.exec(url.trim());
  if (!m) throw new GitHubError('Enter a GitHub repository URL like https://github.com/owner/repo.', 422);
  return { owner: m[1], repo: m[2] };
}

export function defaultAppName(repo: string): string {
  return repo.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 53) || 'app';
}

// ---- Inspection -----------------------------------------------------------------------------

export interface Inspection {
  owner: string;
  repo: string;
  private: boolean;
  branch: string;
  sha: string;
  message: string;
  mode: 'manifests' | 'dockerfile' | 'none';
  path?: string; // manifests folder or Dockerfile context
  kustomize: boolean;
  objects?: { kind: string; name: string }[];
  exposePort?: number;
  hasWorkflow: boolean;
  notes: string[];
}

async function download(owner: string, repo: string, sha: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repo-'));
  const res = await gh<Response>('GET', `/repos/${owner}/${repo}/tarball/${sha}`, undefined, true);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_TARBALL) throw new GitHubError('Repository archive is larger than 100 MB.', 413);
  const tar = spawn('tar', ['-xzf', '-', '-C', dir, '--strip-components=1'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  tar.stderr.on('data', (c) => (stderr += c));
  const exited = new Promise<number>((r) => tar.on('close', (code) => r(code ?? 1)));
  await pipeline(Readable.fromWeb(res.body as any), tar.stdin);
  if ((await exited) !== 0) throw new GitHubError(`Could not unpack the repository: ${stderr.trim()}`, 502);
  return dir;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

async function findKustomization(dir: string): Promise<boolean> {
  for (const f of ['kustomization.yaml', 'kustomization.yml', 'Kustomization']) if (await exists(join(dir, f))) return true;
  return false;
}

async function yamlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await yamlFiles(p)));
    else if (/\.ya?ml$/.test(e.name)) out.push(p);
  }
  return out.sort();
}

async function renderManifests(root: string, path: string, kustomize: boolean): Promise<string> {
  const dir = join(root, path);
  if (kustomize) {
    try {
      const { stdout } = await run('kubectl', ['kustomize', dir], { maxBuffer: 20 * 1024 * 1024, timeout: 60_000 });
      return stdout;
    } catch (e: any) {
      throw new GitHubError(`kustomize failed for ${path || '/'}: ${(e.stderr || e.message || '').toString().trim()}`, 422);
    }
  }
  const files = await yamlFiles(dir);
  const docs = await Promise.all(files.map(async (f) => `# ${relative(root, f)}\n${await readFile(f, 'utf8')}`));
  return docs.join('\n---\n');
}

async function scan(root: string): Promise<Pick<Inspection, 'mode' | 'path' | 'kustomize' | 'exposePort'> & { notes: string[] }> {
  const notes: string[] = [];
  if (await findKustomization(root)) return { mode: 'manifests', path: '', kustomize: true, notes };
  for (const folder of ['k8s', 'deploy', 'kubernetes', 'manifests']) {
    if (await exists(join(root, folder))) {
      const kz = await findKustomization(join(root, folder));
      if (kz || (await yamlFiles(join(root, folder))).length) return { mode: 'manifests', path: folder, kustomize: kz, notes };
    }
  }
  if (await exists(join(root, 'Dockerfile'))) {
    const df = await readFile(join(root, 'Dockerfile'), 'utf8');
    const m = /^\s*EXPOSE\s+(\d+)/im.exec(df);
    if (!m) notes.push('The Dockerfile has no EXPOSE line; enter the port the app listens on.');
    return { mode: 'dockerfile', path: '.', kustomize: false, exposePort: m ? Number(m[1]) : undefined, notes };
  }
  return { mode: 'none', kustomize: false, notes: ['No kustomization.yaml, k8s/ or deploy/ folder, or Dockerfile found at the repository root.'] };
}

export async function inspect(repoUrl: string, branch?: string): Promise<Inspection> {
  const { owner, repo } = parseRepo(repoUrl);
  const meta = await gh<any>('GET', `/repos/${owner}/${repo}`);
  const ref = branch?.trim() || meta.default_branch;
  const commit = await gh<any>('GET', `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
  const dir = await download(owner, repo, commit.sha);
  try {
    const s = await scan(dir);
    const result: Inspection = {
      owner: meta.owner.login,
      repo: meta.name,
      private: meta.private,
      branch: ref,
      sha: commit.sha,
      message: commit.commit?.message?.split('\n')[0] ?? '',
      hasWorkflow: await exists(join(dir, '.github/workflows', WORKFLOW_FILE)),
      ...s,
    };
    if (s.mode === 'manifests') {
      const yaml = await renderManifests(dir, s.path ?? '', s.kustomize);
      result.objects = parseYaml(yaml).map((o) => ({ kind: o.kind!, name: o.metadata.name }));
    }
    if (s.mode === 'dockerfile' && meta.private && meta.owner.login.toLowerCase() !== config.githubOwner.toLowerCase()) {
      result.notes.push(`Private repos outside ${config.githubOwner} can't be built; fork it into ${config.githubOwner} first.`);
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- Builds ---------------------------------------------------------------------------------

export interface BuildRecord {
  id: string;
  at: number;
  user: string;
  app: string;
  namespace: string;
  state: 'queued' | 'building' | 'deploying' | 'succeeded' | 'failed';
  data: {
    repo: string;
    sha: string;
    branch: string;
    mode: 'manifests' | 'dockerfile';
    image?: string;
    runUrl?: string;
    runId?: number;
    buildRepo?: string;
    steps?: { name: string; status: string; conclusion?: string | null }[];
    error?: string;
    log: string[];
    port?: number;
    exposure?: 'off' | 'internal' | 'public';
    host?: string;
  };
}

export const builds = new EventEmitter();

function update(b: BuildRecord, patch: Partial<BuildRecord> & { log?: string }) {
  const { log, ...rest } = patch;
  Object.assign(b, rest);
  if (log) b.data.log.push(`${new Date().toISOString().slice(11, 19)} ${log}`);
  saveBuild(b);
  builds.emit('update', b);
}

function workflowYaml(): string {
  return `# Added by homelab-ui: builds this repo's Dockerfile on demand and pushes it to GHCR.
name: homelab-ui build
run-name: homelab-ui build \${{ inputs.build_id }}
on:
  workflow_dispatch:
    inputs:
      build_id: { required: true, type: string }
      repository: { required: false, type: string, default: "" }
      ref: { required: true, type: string }
      image: { required: true, type: string }
      context: { required: false, type: string, default: "." }
permissions:
  contents: read
  packages: write
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          repository: \${{ inputs.repository || github.repository }}
          ref: \${{ inputs.ref }}
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: \${{ inputs.context }}
          platforms: linux/amd64
          push: true
          tags: \${{ inputs.image }}
`;
}

// Makes sure the repo that will run the build has our workflow on its default branch.
async function ensureWorkflow(owner: string, repo: string): Promise<string> {
  const meta = await gh<any>('GET', `/repos/${owner}/${repo}`);
  const path = `.github/workflows/${WORKFLOW_FILE}`;
  const content = Buffer.from(workflowYaml()).toString('base64');
  const current = await gh<any>('GET', `/repos/${owner}/${repo}/contents/${path}?ref=${meta.default_branch}`).catch((e) => {
    if (e instanceof GitHubError && e.status === 404) return undefined;
    throw e;
  });
  if (current?.content?.replace(/\n/g, '') !== content) {
    await gh('PUT', `/repos/${owner}/${repo}/contents/${path}`, {
      message: 'Add homelab-ui build workflow',
      content,
      branch: meta.default_branch,
      ...(current?.sha ? { sha: current.sha } : {}),
    });
  }
  return meta.default_branch;
}

async function ensureBuilderRepo(): Promise<void> {
  const owner = config.githubOwner;
  const existing = await gh('GET', `/repos/${owner}/${BUILDER_REPO}`).catch((e) => {
    if (e instanceof GitHubError && e.status === 404) return undefined;
    throw e;
  });
  if (!existing) {
    await gh('POST', '/user/repos', { name: BUILDER_REPO, private: true, auto_init: true, description: 'Builds images for homelab-ui from public repositories' });
  }
}

async function findRun(owner: string, repo: string, buildId: string, since: number): Promise<any | undefined> {
  const runs = await gh<any>('GET', `/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=20`);
  return (runs.workflow_runs ?? []).find((r: any) => r.display_title?.includes(buildId) && Date.parse(r.created_at) >= since - 60_000);
}

export interface GitHubDeployRequest {
  repo: string;
  branch?: string;
  sha?: string;
  app?: string;
  namespace?: string;
  port?: number;
  exposure?: 'off' | 'internal' | 'public';
  host?: string;
  env?: Record<string, string>;
  volume?: { size: string; mountPath: string; storageClass?: string };
}

export async function deployFromGitHub(req: GitHubDeployRequest, user: string): Promise<BuildRecord> {
  const insp = await inspect(req.repo, req.sha || req.branch);
  if (insp.mode === 'none') throw new GitHubError(insp.notes.join(' '), 422);
  const app = req.app?.trim() || defaultAppName(insp.repo);
  validateName(app);
  const namespace = req.namespace || config.appsNamespace;
  const b: BuildRecord = {
    id: randomUUID().slice(0, 8),
    at: Date.now(),
    user,
    app,
    namespace,
    state: 'queued',
    data: { repo: `${insp.owner}/${insp.repo}`, sha: insp.sha, branch: insp.branch, mode: insp.mode, log: [], port: req.port ?? insp.exposePort, exposure: req.exposure, host: req.host },
  };
  update(b, { log: `Pinned ${b.data.repo}@${insp.sha.slice(0, 7)} (${insp.branch}): ${insp.message}` });
  void runBuild(b, insp, req).catch((e) => update(b, { state: 'failed', data: { ...b.data, error: e.message }, log: `Failed: ${e.message}` }));
  return b;
}

async function runBuild(b: BuildRecord, insp: Inspection, req: GitHubDeployRequest) {
  const repoId = `${insp.owner}/${insp.repo}`;
  if (insp.mode === 'manifests') {
    update(b, { state: 'deploying', log: `Rendering manifests from ${insp.path || 'repository root'}${insp.kustomize ? ' with kustomize' : ''}` });
    const dir = await download(insp.owner, insp.repo, insp.sha);
    let yaml: string;
    try {
      yaml = await renderManifests(dir, insp.path ?? '', insp.kustomize);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const res = await applyObjects(b.app, b.namespace, parseYaml(yaml), { type: 'github', repo: repoId, branch: insp.branch, sha: insp.sha, mode: 'manifests', path: insp.path }, false);
    for (const w of res.warnings) update(b, { log: `Note: ${w}` });
    for (const i of res.items) update(b, { log: `${i.problem ? 'FAILED' : i.action} ${i.kind}/${i.name}${i.problem ? `: ${i.problem.cause}` : ''}` });
    if (!res.ok) throw new Error('Some objects failed to apply (see above).');
    await finishExposure(b);
    update(b, { state: 'succeeded', log: 'Deployed.' });
    audit(b.user, 'deploy.github', `${b.namespace}/${b.app}`, true, { repo: repoId, sha: insp.sha });
    return;
  }

  // Dockerfile: build in Actions.
  const own = insp.owner.toLowerCase() === config.githubOwner.toLowerCase();
  if (!own && insp.private) throw new Error(`Private repos outside ${config.githubOwner} can't be built.`);
  const buildRepo = own ? insp.repo : BUILDER_REPO;
  const buildOwner = config.githubOwner;
  const imageName = own ? insp.repo.toLowerCase() : `${insp.owner}-${insp.repo}`.toLowerCase();
  const image = `ghcr.io/${buildOwner.toLowerCase()}/${imageName}:${insp.sha.slice(0, 12)}`;
  b.data.image = image;
  b.data.buildRepo = `${buildOwner}/${buildRepo}`;
  update(b, { state: 'building', log: own ? `Preparing the build workflow in ${repoId}` : `Building through ${buildOwner}/${BUILDER_REPO} (upstream is not yours)` });
  if (!own) await ensureBuilderRepo();
  const ref = await ensureWorkflow(buildOwner, buildRepo);
  const since = Date.now();
  // GitHub needs a moment to register a just-committed workflow before it can be dispatched.
  let dispatched = false;
  for (let i = 0; i < 6 && !dispatched; i++) {
    try {
      await gh('POST', `/repos/${buildOwner}/${buildRepo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
        ref,
        inputs: { build_id: b.id, repository: own ? '' : repoId, ref: insp.sha, image, context: '.' },
      });
      dispatched = true;
    } catch (e) {
      if (!(e instanceof GitHubError && (e.status === 404 || e.status === 502)) || i === 5) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  update(b, { log: `Dispatched build of ${image}` });

  let runInfo: any;
  for (let i = 0; i < 24 && !runInfo; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    runInfo = await findRun(buildOwner, buildRepo, b.id, since);
  }
  if (!runInfo) throw new Error('The build was dispatched but no Actions run appeared within 2 minutes.');
  update(b, { data: { ...b.data, runId: runInfo.id, runUrl: runInfo.html_url }, log: `Actions run started: ${runInfo.html_url}` });

  const deadline = Date.now() + 50 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6000));
    const r = await gh<any>('GET', `/repos/${buildOwner}/${buildRepo}/actions/runs/${runInfo.id}`);
    const jobs = await gh<any>('GET', `/repos/${buildOwner}/${buildRepo}/actions/runs/${runInfo.id}/jobs`).catch(() => ({ jobs: [] }));
    const steps = (jobs.jobs?.[0]?.steps ?? []).map((s: any) => ({ name: s.name, status: s.status, conclusion: s.conclusion }));
    if (JSON.stringify(steps) !== JSON.stringify(b.data.steps)) update(b, { data: { ...b.data, steps } });
    if (r.status === 'completed') {
      if (r.conclusion !== 'success') {
        const failed = steps.find((s: any) => s.conclusion === 'failure');
        throw new Error(`Build ${r.conclusion}${failed ? ` at step "${failed.name}"` : ''}. Open the Actions run for the full log.`);
      }
      break;
    }
  }
  if (Date.now() >= deadline) throw new Error('Build did not finish within 50 minutes.');

  update(b, { state: 'deploying', log: `Image pushed. Deploying ${image}` });
  const source = { type: 'github' as const, repo: repoId, branch: insp.branch, sha: insp.sha, mode: 'dockerfile' as const, image };
  const res = await deployImage({ app: b.app, namespace: b.namespace, image, port: b.data.port, env: req.env, volume: req.volume }, false, source);
  for (const w of res.warnings) update(b, { log: `Note: ${w}` });
  if (!res.ok) throw new Error(res.items.filter((i) => i.problem).map((i) => `${i.kind}/${i.name}: ${i.problem!.cause}`).join('; '));
  await finishExposure(b);
  update(b, { state: 'succeeded', log: 'Deployed.' });
  audit(b.user, 'deploy.github', `${b.namespace}/${b.app}`, true, { repo: repoId, sha: insp.sha, image });
}

async function finishExposure(b: BuildRecord) {
  if (!b.data.exposure || b.data.exposure === 'off') return;
  try {
    const r = await setExposure(b.namespace, b.app, b.data.exposure, { host: b.data.host });
    update(b, { log: `Exposed at ${r.url}` });
  } catch (e) {
    update(b, { log: `Deployed, but exposure failed: ${e instanceof Error ? e.message : e}` });
  }
}

export { getBuild, listBuilds };
