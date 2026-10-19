// Shapes sent by the server (mirrors server/src/k8s/apps.ts, nodes.ts and systems/*).

export interface Problem {
  severity: 'error' | 'warning';
  title: string;
  cause: string;
  fix: string;
  pod?: string;
  container?: string;
  exitCode?: number;
  wantsLogs?: boolean;
}

export type AppStatus = 'healthy' | 'progressing' | 'degraded' | 'failed' | 'stopped' | 'completed' | 'scheduled';
export type Exposure = 'public' | 'internal' | 'off';

export interface WorkloadSummary {
  kind: string;
  name: string;
  desired: number;
  ready: number;
  updated: number;
  images: string[];
  revision?: string;
}

export interface HostSummary {
  host: string;
  exposure: 'public' | 'internal' | 'other';
  via: 'Ingress' | 'IngressRoute';
  object: string;
  managed: boolean;
}

export interface AppSummary {
  id: string;
  namespace: string;
  name: string;
  managed: boolean;
  protected: boolean;
  workloads: WorkloadSummary[];
  images: string[];
  desired: number;
  ready: number;
  restarts: number;
  podCount: number;
  status: AppStatus;
  problems: Problem[];
  hosts: HostSummary[];
  exposure: Exposure;
  services: { name: string; ports: { port: number; name?: string; targetPort?: unknown }[] }[];
  pvcs: string[];
  links: string[];
  linkedBy: string[];
  sourceType?: string;
  createdAt?: string;
  rev: string;
}

export interface NodeSummary {
  name: string;
  ready: boolean;
  schedulable: boolean;
  roles: string[];
  internalIP?: string;
  kubelet?: string;
  os?: string;
  cpuCores: number;
  memoryBytes: number;
  cpuUsage?: number;
  memoryUsage?: number;
  pods: number;
  podCapacity: number;
  pressure: string[];
  age?: string;
}

export interface WatchState {
  synced: boolean;
  error?: string;
  lastSync?: number;
  lastEvent?: number;
}

export interface ClusterState {
  nodes: NodeSummary[];
  namespaces: string[];
  watch: Record<string, WatchState>;
  metrics: boolean;
  synced: boolean;
}

export interface PveGuest {
  id: string;
  vmid: number;
  type: 'qemu' | 'lxc';
  name: string;
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  template: boolean;
  tags?: string;
}

export interface ProxmoxState {
  configured: boolean;
  connected: boolean;
  error?: string;
  lastUpdate?: number;
  version?: string;
  nodes: { node: string; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number }[];
  guests: PveGuest[];
  storage: { id: string; storage: string; node: string; status: string; disk: number; maxdisk: number; content?: string; shared: boolean }[];
}

export interface TrueNasState {
  configured: boolean;
  connected: boolean;
  error?: string;
  lastUpdate?: number;
  apiVersion?: string;
  system?: { hostname: string; version: string; uptimeSeconds: number; loadavg: number[]; physmem: number; cores: number; model?: string };
  pools: { id: number; name: string; status: string; healthy: boolean; size: number; allocated: number; free: number; scan?: { function?: string; state?: string; end_time?: number; errors?: number; percentage?: number }; vdevErrors: number }[];
  datasets: { id: string; pool: string; used: number; available: number; type: string; mountpoint?: string; encrypted: boolean; compression?: string }[];
  alerts: { uuid: string; level: string; klass: string; formatted: string; datetime?: number; dismissed: boolean }[];
}

export interface Build {
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
    steps?: { name: string; status: string; conclusion?: string | null }[];
    error?: string;
    log: string[];
    exposure?: Exposure;
    host?: string;
  };
}

export interface User {
  login: string;
  name: string;
  avatar?: string;
  device: string;
}

export interface PlanItem {
  kind: string;
  name: string;
  namespace?: string;
  action?: 'create' | 'update' | 'unchanged';
  problem?: Problem;
}

export interface DeployResult {
  ok: boolean;
  dryRun: boolean;
  app: string;
  namespace: string;
  items: PlanItem[];
  warnings: string[];
  exposure?: { url?: string };
}
