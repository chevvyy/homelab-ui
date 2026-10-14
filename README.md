# homelab-ui

One web UI for the homelab: watch the k3s cluster, Proxmox and TrueNAS live, and deploy and manage
apps on k3s from a container image, a GitHub repo or pasted YAML. Reachable only over Tailscale at
`https://controller.howellsas.com`; you sign in with your Tailscale identity (no password).

**New here?** [docs/FILES.md](docs/FILES.md) explains every file and folder in one page.

Rancher still covers cluster administration; this covers day-to-day deploys and monitoring.

## What it does

| Area | Features |
| --- | --- |
| Cluster | Every app in every namespace, grouped and updating live; node CPU/RAM; plain-language problems (image pull, crash loop with exit code and last log lines, OOM, Pending, Pod Security, stalled rollouts) |
| Apps | Restart, scale, edit env, live logs, recreate pods, roll back to any revision, delete (volumes kept by default) |
| Deploy | Image (registry existence check), GitHub repo (kustomize / `k8s/` / Dockerfile built in GitHub Actions), YAML (server-side dry-run preview) |
| Access | Per app: **Off**, **Internal** (`<app>.lan.howellsas.com`, Tailscale only), **Public** (`<app>.howellsas.com` via the Cloudflare tunnel), custom hostnames with collision checks |
| Links | Link app A to B: A gets `B_URL`, `B_HOST`, `B_PORT` and restarts; deleting B warns about A |
| Proxmox | Nodes, VMs and LXCs live; start, shut down, reboot, force stop; snapshots |
| TrueNAS | Pools, datasets, live alerts (view only) |
| Native UIs | Buttons to Rancher, Proxmox and TrueNAS at `https://{rancher,proxmox,truenas}.lan.howellsas.com` (Tailscale only) |
| Other | Dashboard, Ctrl+K palette (`restart <app>`), phone layout, audit log, nightly SQLite backup to the NAS |

## Architecture

```
browser ──tailnet──▶ tailscale sidecar ("controller", :80) ──PROXY v1──▶ controller 127.0.0.1:3000
                                                             (whois → Tailscale login = sign-in)
controller ──▶ Kubernetes API (watch cache), Proxmox REST (5 s poll), TrueNAS JSON-RPC WebSocket,
               GitHub API (builds), all credentials in Secrets in homelab-ui

Internal apps: browser ──tailnet──▶ lan-gateway ("homelab-lan", :80) ──▶ Traefik ──▶ app
Public apps:   browser ──▶ Cloudflare ──tunnel──▶ Traefik ──▶ app
```

* An "app" is a label (`homelab.io/app`); the cluster is the source of truth, so restarting the
  controller loses nothing. Apps the controller didn't create are grouped by
  `app.kubernetes.io/instance` or workload name.
* New apps go to `homelab-apps` (Pod Security `baseline`). Image deploys into `restricted`
  namespaces get a hardened securityContext automatically.
* System namespaces (`kube-*`, `cattle-*`, `fleet-*`) are view-only.

## Setup (one time)

1. **Bootstrap** (cluster owner): `kubectl apply -f k8s/bootstrap/bootstrap.yaml`, which creates the
   namespaces, ServiceAccount and RBAC.
2. **Secrets** in `homelab-ui` (create them from a terminal; never commit them):
   * `proxmox`: `url`, `tokenId`, `secret` (token role: Sys.Audit, VM.Audit, Datastore.Audit,
     Pool.Audit, VM.PowerMgmt, VM.Snapshot)
   * `truenas`: `url` (e.g. `wss://192.168.0.215`), `apiKey`, optional `username`
   * `github`: `token` (fine-grained: Contents, Actions, Workflows, Administration read/write;
     Metadata read)
   * `tailscale-auth`: `TS_AUTHKEY` (reusable, pre-approved, tag `tag:homelab-ui`)
   * `cloudflare-dns`: `api-token` (Cloudflare "Edit zone DNS" for howellsas.com; used for Let's Encrypt)
   * `ghcr`: image pull secret (copied from an existing namespace)
3. **Deploy**: `kubectl apply -k k8s/`
4. **DNS** (Cloudflare, DNS only, not proxied):
   `controller` A → the `controller` node's Tailscale IP, and `*.lan` A → the `homelab-lan` node's
   Tailscale IP.

Proxmox, TrueNAS and GitHub credentials can also be set or rotated later on the Settings page.

## Runbook

* **Logs**: `kubectl logs -n homelab-ui deploy/homelab-ui -c controller --tail=200`
* **Tailscale side**: `kubectl logs -n homelab-ui deploy/homelab-ui -c tailscale --tail=100`
* **"Not signed in"**: the device must be a user-owned tailnet device, not a tagged one. If
  `ALLOWED_LOGINS` is set, your login must be in it.
* **A watch shows "No permission"**: a verb or resource is missing from the bootstrap RBAC; add it
  there.
* **Backups**: `/backup/homelab-ui-YYYY-MM-DD.db` on the `homelab-ui-backup` PVC (NAS), 14 kept.
  To restore, scale to 0, copy one over `/data/db/homelab-ui.db`, then scale to 1. The DB only
  holds history and the audit log; apps live in the cluster.
* **Release**: push a `vX.Y.Z` tag, Actions builds `ghcr.io/chevvyy/homelab-ui:X.Y.Z`; bump
  `newTag` in `k8s/kustomization.yaml` and `kubectl apply -k k8s/`.

## Development

```
npm ci
AUTH_MODE=dev SELF_NAMESPACE=homelab-ui npm run dev:server   # API on 127.0.0.1:3000 (uses your kubeconfig)
npm run dev:web                                              # Vite on :5173, proxies /api
```
