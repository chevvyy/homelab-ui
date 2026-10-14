// Translates Kubernetes states and reasons into plain sentences with a suggested fix.
import type { KObject } from './client.js';

export interface Problem {
  severity: 'error' | 'warning';
  title: string; // one line: what is wrong
  cause: string; // why, in plain language
  fix: string; // what to do next
  pod?: string;
  container?: string;
  exitCode?: number;
  wantsLogs?: boolean; // UI should show the container's last log lines
}

const EXIT_CODES: Record<number, string> = {
  0: 'exited normally, but Kubernetes expects it to keep running',
  1: 'the app reported a general error',
  2: 'the app was started with invalid arguments',
  126: 'the start command is not executable',
  127: 'the start command was not found in the image',
  134: 'the app aborted (SIGABRT)',
  137: 'it was killed (out of memory or force-stopped)',
  139: 'the app crashed with a segmentation fault',
  143: 'it was asked to stop (SIGTERM) and exited',
};

function exitText(code: number | undefined): string {
  if (code === undefined) return '';
  return EXIT_CODES[code] ? `exit code ${code}: ${EXIT_CODES[code]}` : `exit code ${code}`;
}

function imagePullProblem(pod: string, c: any, image: string, message: string): Problem {
  const m = message.toLowerCase();
  let cause = `Kubernetes could not download the image "${image}".`;
  let fix = 'Check the image name and tag for typos, and that the image exists in its registry.';
  if (m.includes('not found') || m.includes('manifest unknown')) {
    cause = `The image "${image}" (or that tag) does not exist in the registry.`;
    fix = 'Fix the image name or tag. If it is built by GitHub Actions, check that the build finished and pushed this tag.';
  } else if (m.includes('unauthorized') || m.includes('denied') || m.includes('403') || m.includes('401')) {
    cause = `The registry refused access to "${image}"; it is private and no valid pull credentials were offered.`;
    fix = image.startsWith('ghcr.io/')
      ? 'Make sure the namespace has the "ghcr" pull secret (the controller syncs it for apps it deploys) and that the token behind it can read this package.'
      : 'Add an image pull secret for this registry to the namespace, or make the image public.';
  } else if (m.includes('no such host') || m.includes('i/o timeout') || m.includes('connection refused')) {
    cause = `The node could not reach the registry for "${image}" (network or DNS error).`;
    fix = 'Check the registry hostname, and that the nodes have internet access.';
  } else if (c.state?.waiting?.reason === 'InvalidImageName') {
    cause = `"${image}" is not a valid image reference.`;
    fix = 'Use the form registry/owner/name:tag, for example ghcr.io/chevvyy/app:v1.0.0.';
  }
  return { severity: 'error', title: `Can't pull image for ${c.name}`, cause, fix, pod, container: c.name };
}

function schedulingProblem(pod: string, message: string): Problem {
  const m = message.toLowerCase();
  if (m.includes('unbound') && m.includes('persistentvolumeclaim')) {
    return {
      severity: 'error',
      title: 'Waiting for storage',
      cause: 'The pod needs a volume (PVC) that has not been provisioned yet.',
      fix: 'Open the app\'s volumes: if the PVC stays Pending, its StorageClass may be wrong or the NAS unreachable. nfs-bulk and local-path are the valid classes.',
      pod,
    };
  }
  if (m.includes('insufficient memory') || m.includes('insufficient cpu')) {
    const what = m.includes('insufficient memory') ? 'memory' : 'CPU';
    return {
      severity: 'error',
      title: `No node has enough free ${what}`,
      cause: `The pod requests more ${what} than any node has unreserved. (${message})`,
      fix: `Lower the ${what} request, scale something else down, or free capacity on a node.`,
      pod,
    };
  }
  if (m.includes('taint') || m.includes('affinity') || m.includes('selector')) {
    return {
      severity: 'error',
      title: 'No node matches this pod\'s placement rules',
      cause: message,
      fix: 'Check nodeSelector, affinity and tolerations in the manifest against the node labels and taints.',
      pod,
    };
  }
  return { severity: 'error', title: 'Pod cannot be scheduled', cause: message || 'The scheduler has not found a node for this pod.', fix: 'Check the events below for the scheduler\'s reason.', pod };
}

export function podProblems(pod: KObject): Problem[] {
  const out: Problem[] = [];
  const name = pod.metadata.name;
  const st = pod.status ?? {};
  const specContainers: any[] = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])];
  const statuses: any[] = [...(st.initContainerStatuses ?? []), ...(st.containerStatuses ?? [])];

  if (st.phase === 'Pending') {
    const sched = (st.conditions ?? []).find((c: any) => c.type === 'PodScheduled');
    if (sched?.status === 'False') out.push(schedulingProblem(name, sched.message ?? ''));
  }
  if (st.phase === 'Failed' && st.reason === 'Evicted') {
    out.push({ severity: 'warning', title: 'Pod was evicted', cause: st.message ?? 'The node ran low on resources.', fix: 'Usually transient; Kubernetes replaces it. If it repeats, the node is short on disk or memory.', pod: name });
  }

  for (const c of statuses) {
    const waiting = c.state?.waiting;
    const last = c.lastState?.terminated;
    const term = c.state?.terminated;
    const spec = specContainers.find((s) => s.name === c.name);
    const image = spec?.image ?? c.image;

    if (waiting && ['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName', 'ErrImageNeverPull'].includes(waiting.reason)) {
      out.push(imagePullProblem(name, c, image, waiting.message ?? ''));
      continue;
    }
    if (waiting?.reason === 'CreateContainerConfigError') {
      const msg: string = waiting.message ?? '';
      const missing = /(secret|configmap) "([^"]+)" not found/i.exec(msg);
      out.push({
        severity: 'error',
        title: `${c.name} can't start: configuration missing`,
        cause: missing ? `It references ${missing[1].toLowerCase()} "${missing[2]}", which does not exist in this namespace.` : msg,
        fix: missing ? `Create ${missing[1].toLowerCase()} "${missing[2]}" in the namespace, or remove the reference.` : 'Check env and volume references to Secrets and ConfigMaps.',
        pod: name,
        container: c.name,
      });
      continue;
    }
    if (waiting && ['RunContainerError', 'CreateContainerError', 'ContainerCannotRun'].includes(waiting.reason)) {
      out.push({ severity: 'error', title: `${c.name} can't start`, cause: waiting.message ?? waiting.reason, fix: 'Usually a bad command, entrypoint or volume mount. Check the container command and mounts.', pod: name, container: c.name });
      continue;
    }

    const oom = last?.reason === 'OOMKilled' || term?.reason === 'OOMKilled';
    if (oom) {
      const limit = spec?.resources?.limits?.memory;
      // Killed earlier but running fine now: worth knowing, not an outage.
      const recovered = !!c.state?.running && c.ready;
      out.push({
        severity: recovered ? 'warning' : 'error',
        title: `${c.name} ran out of memory`,
        cause: `The container used more memory than its limit${limit ? ` (${limit})` : ''} and was killed (OOMKilled). It has restarted ${c.restartCount} times.`,
        fix: limit ? `Raise the memory limit above ${limit}, or reduce the app's memory use.` : 'Set a memory limit that fits the app, or check the node\'s free memory.',
        pod: name,
        container: c.name,
        exitCode: 137,
      });
      continue;
    }
    // Between restarts a crashing container shows either waiting/CrashLoopBackOff or (on newer
    // kubelets) terminated with a non-zero exit code.
    const restartsAlways = (pod.spec?.restartPolicy ?? 'Always') === 'Always';
    const crashed = waiting?.reason === 'CrashLoopBackOff' || (restartsAlways && term && (term.exitCode !== 0 || c.restartCount > 0));
    if (crashed) {
      const code = term?.exitCode ?? last?.exitCode;
      out.push({
        severity: 'error',
        title: `${c.name} keeps crashing`,
        cause: `It started and then stopped${code !== undefined ? ` (${exitText(code)})` : ''}, ${c.restartCount} restarts so far. Kubernetes is waiting before trying again.`,
        fix: code === 127 || code === 126 ? 'Fix the container command or entrypoint.' : 'Read the last log lines below for the app\'s own error. Common causes: a missing env var, a wrong port, or no database to connect to.',
        pod: name,
        container: c.name,
        exitCode: code,
        wantsLogs: true,
      });
      continue;
    }
    if (c.state?.running && !c.ready && st.phase === 'Running' && !(pod.spec?.initContainers ?? []).some((i: any) => i.name === c.name)) {
      const started = Date.parse(c.state.running.startedAt ?? '');
      if (started && Date.now() - started > 60_000) {
        out.push({ severity: 'warning', title: `${c.name} is running but not ready`, cause: 'Its readiness check has been failing for over a minute, so it receives no traffic.', fix: 'Check that the readiness probe path and port match what the app serves.', pod: name, container: c.name });
      }
    }
  }
  return out;
}

export function workloadProblems(w: KObject, replicaSets: KObject[], events: KObject[]): Problem[] {
  const out: Problem[] = [];
  for (const cond of w.status?.conditions ?? []) {
    if (cond.type === 'Progressing' && cond.reason === 'ProgressDeadlineExceeded') {
      out.push({
        severity: 'error',
        title: 'Rollout stalled',
        cause: `The new version did not become ready within ${w.spec?.progressDeadlineSeconds ?? 600} seconds.`,
        fix: 'See the pod problems for the reason, then fix and redeploy, or roll back to the previous version.',
      });
    }
    if (cond.type === 'ReplicaFailure' && cond.status === 'True') out.push(createFailure(cond.message ?? ''));
  }
  // Pod creation refused (e.g. Pod Security) shows up on the ReplicaSet / as FailedCreate events.
  for (const rs of replicaSets) {
    for (const cond of rs.status?.conditions ?? []) {
      if (cond.type === 'ReplicaFailure' && cond.status === 'True') out.push(createFailure(cond.message ?? ''));
    }
  }
  for (const ev of events) {
    if (ev.reason === 'FailedCreate' && ev.involvedObject?.kind === 'StatefulSet') out.push(createFailure(ev.message ?? ''));
  }
  const seen = new Set<string>();
  return out.filter((p) => (seen.has(p.title + p.cause) ? false : (seen.add(p.title + p.cause), true)));
}

function createFailure(message: string): Problem {
  if (/violates PodSecurity/i.test(message)) {
    const details = /violates PodSecurity "[^"]+":\s*(.*)$/s.exec(message)?.[1] ?? message;
    return {
      severity: 'error',
      title: 'Blocked by the namespace\'s security policy',
      cause: `Kubernetes refused to create the pods because they break the namespace's Pod Security rules: ${details || message}`,
      fix: 'Run the container as a non-root user, set allowPrivilegeEscalation: false, drop all capabilities and set seccompProfile RuntimeDefault, or deploy into homelab-apps (baseline policy).',
    };
  }
  if (/exceeded quota/i.test(message)) {
    return { severity: 'error', title: 'Namespace quota exceeded', cause: message, fix: 'Lower the requests or raise the namespace quota.' };
  }
  return { severity: 'error', title: 'Pods could not be created', cause: message, fix: 'Check the events for details.' };
}

// Normalizes API errors (from apply, patch, delete) into the same shape.
export function apiErrorProblem(status: number, reason: string, message: string): Problem {
  if (status === 409) {
    return { severity: 'error', title: 'Someone else changed this object', cause: `Conflict: ${message}`, fix: 'Refresh and try again. If a field is owned by another tool (kubectl, Helm, Rancher), that tool is still managing it.' };
  }
  if (status === 422 || reason === 'Invalid') {
    return { severity: 'error', title: 'The manifest is invalid', cause: message, fix: 'Fix the highlighted field and try again.' };
  }
  if (status === 403) {
    const m = /User "([^"]+)" cannot (\w+) resource "([^"]+)"(?: in API group "([^"]*)")?(?: in the namespace "([^"]+)")?/.exec(message);
    return {
      severity: 'error',
      title: 'The controller is not allowed to do this',
      cause: m ? `It has no permission to ${m[2]} ${m[3]}${m[5] ? ` in namespace ${m[5]}` : ''}.` : message,
      fix: 'Grant it in k8s/bootstrap/bootstrap.yaml (cluster owner applies it), or use a namespace the controller manages (homelab-apps).',
    };
  }
  if (status === 404) return { severity: 'error', title: 'Not found', cause: message, fix: 'It may already have been deleted. Refresh.' };
  return { severity: 'error', title: `Kubernetes API error (${status} ${reason})`, cause: message, fix: 'Check the message; retry if it looks transient.' };
}
