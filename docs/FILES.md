# Project guide: what every file does

A quick map of the repo. Each entry says what the file is for and when you'd touch it.
For setup and day-to-day operations, see the [README](../README.md).

```
homelab-ui/
├── server/      backend (Node + Fastify): talks to Kubernetes, Proxmox, TrueNAS, GitHub
├── web/         frontend (React): the website you see
├── k8s/         Kubernetes files that deploy the controller
├── docs/        notes, roadmap and this guide
├── .github/     automatic image builds
└── root files   build and repo config
```

---

## Root files

| File | What it is |
|---|---|
| `README.md` | Start here: what the app does, how it's wired, setup steps and a short runbook. |
| `Dockerfile` | Recipe for the container image. Builds the website and server, adds `kubectl` (used for kustomize), and runs as a non-root user. |
| `.dockerignore` | Files left out of the image build (node_modules, docs, k8s…), keeping builds fast and small. |
| `.gitignore` | Files git never commits: dependencies, build output, local databases, `.env`. |
| `package.json` | Ties `server/` and `web/` together (npm workspaces) and holds the shared commands: `npm run build`, `npm run typecheck`. |
| `package-lock.json` | Exact dependency versions, so every build installs the same thing. Never edit by hand. |

## `.github/workflows/`

| File | What it is |
|---|---|
| `image.yml` | GitHub Actions build. On every push to `main` or a `vX.Y.Z` tag it type-checks the code, builds the image and pushes it to `ghcr.io/chevvyy/homelab-ui`. A tag like `v0.1.5` produces image tag `0.1.5`. |

---

## `server/`: the backend

The brain. It keeps a live copy of the cluster, polls Proxmox, listens to TrueNAS, and does every action you click in the UI.

| File | What it is |
|---|---|
| `package.json` / `tsconfig.json` | Server dependencies and TypeScript settings. |
| `src/index.ts` | **Entry point.** Starts the web server, the Tailscale sign-in check, HTTPS, the health endpoint (`:8081`) and the nightly database backup. |
| `src/config.ts` | **All settings in one place** (namespaces, domains, storage classes, native-UI links), each overridable with an environment variable. |
| `src/auth.ts` | **Sign-in.** Reads the visitor's Tailscale address from the PROXY header, asks Tailscale who it is (`whois`), and turns away tagged or unknown devices. Also decrypts HTTPS. |
| `src/routes.ts` | **The API.** Every button in the UI calls one of these URLs (`/api/apps/...`, `/api/deploy/...`, `/api/proxmox/...`). Each action is recorded in the audit log. |
| `src/ws.ts` | **Live updates.** One WebSocket per browser tab, pushing apps, nodes, Proxmox and TrueNAS changes as they happen, plus live log streaming. |
| `src/db.ts` | Small SQLite database: audit log and GitHub build history. Apps themselves live in the cluster, not here. |
| `src/secrets.ts` | Reads and writes credentials stored as Kubernetes Secrets. Used by Settings to rotate tokens. |
| `src/github.ts` | **Deploy from GitHub.** Pins a commit, detects manifests or a Dockerfile, builds Dockerfiles in GitHub Actions, then deploys. |

### `server/src/k8s/`: Kubernetes logic

| File | What it is |
|---|---|
| `client.ts` | Low-level Kubernetes API calls (requests, streams, finding resource types). |
| `cache.ts` | **Watch engine.** Keeps an up-to-date copy of pods, deployments, services, routes and more; reconnects automatically if a watch expires. |
| `apps.ts` | Groups raw objects into "apps" (workloads + pods + services + routes) and works out each app's status. |
| `status.ts` | **Plain-language errors.** Turns Kubernetes states (ImagePullBackOff, CrashLoop, OOMKilled, Pending, Pod Security…) into a sentence plus a suggested fix. |
| `actions.ts` | Day-to-day actions: restart, scale, edit env, roll back, delete, logs. Refuses changes in system namespaces. |
| `deploy.ts` | Deploys from YAML or an image: adds app labels, does a dry-run preview, applies, and blocks hostname clashes. |
| `exposure.ts` | The **Off / Internal / Public** switch: creates or removes Traefik routes and checks hostnames are free. |
| `links.ts` | **App linking:** injects `NAME_URL`, `NAME_HOST` and `NAME_PORT` so one app can find another. |
| `registry.ts` | Checks an image exists in its registry before deploying, to catch typos. |
| `pullsecret.ts` | Copies the GHCR login into namespaces so private images can be pulled. |
| `lantls.ts` | Copies the `*.lan.howellsas.com` HTTPS certificate into namespaces with Internal apps and keeps it fresh. |
| `nodes.ts` | Node summaries plus live CPU and memory from metrics-server. |
| `labels.ts` | The labels and annotations the controller stamps on everything it creates (`homelab.io/app`, …). |

### `server/src/systems/`

| File | What it is |
|---|---|
| `proxmox.ts` | Proxmox connection: polls every 5 s for nodes, VMs, LXCs and storage; start, stop, reboot and snapshots. |
| `truenas.ts` | TrueNAS connection (view only): pools, datasets and live alerts over its WebSocket API. |

---

## `web/`: the website

| File | What it is |
|---|---|
| `package.json` / `tsconfig.json` / `vite.config.ts` | Frontend dependencies, TypeScript and the Vite build tool. In dev, Vite forwards `/api` to the server. |
| `index.html` | The single HTML page the app loads into. |
| `public/icon.svg`, `public/manifest.webmanifest` | App icon, and the file that lets you "Add to Home Screen" on your phone. |
| `src/main.tsx` | Starts React and wraps the app with routing, data fetching, toasts and confirm dialogs. |
| `src/App.tsx` | **Layout:** sidebar, mobile menu, "Disconnected" banner, page routes, Ctrl+K shortcut. |
| `src/live.ts` | Connects to the live WebSocket and shares its data with every page. Reconnects on its own. |
| `src/api.ts` | Tiny helpers for calling the server API and showing its errors. |
| `src/types.ts` | Shapes of the data the server sends (apps, nodes, VMs, pools…). |
| `src/ui.tsx` | Shared pieces: status badges, usage bars, problem cards, dialogs, toasts, native-UI link buttons, number formatting. |
| `src/styles.css` | All styling: dark and light themes, phone layout. |
| `src/components/CommandPalette.tsx` | **Ctrl+K search:** jump to any app, VM or page, or type `restart <app>`. |

### `web/src/pages/`

| File | What you see |
|---|---|
| `Dashboard.tsx` | Overview: app counts, what needs attention, node load, Proxmox and TrueNAS at a glance. |
| `Apps.tsx` | Every app in every namespace, with filters and status. |
| `AppDetail.tsx` | One app: problems, access switch, links, scaling, pods, live logs, env editor, versions and rollback, events. |
| `Deploy.tsx` | Deploy from an image, a GitHub repo or YAML. Paste anything and it detects which. |
| `Cluster.tsx` | Nodes with CPU, RAM and pods, plus all namespaces. Links to Rancher. |
| `Proxmox.tsx` | Proxmox nodes, storage, VMs and LXCs; power, snapshots and console buttons. |
| `TrueNas.tsx` | TrueNAS pools, datasets and alerts. |
| `Activity.tsx` | GitHub deploy history and the log of every action taken. |
| `Settings.tsx` | Update or rotate the Proxmox, TrueNAS and GitHub credentials. |

---

## `k8s/`: deployment files

Apply everything (except bootstrap) with `kubectl apply -k k8s/`.

| File | What it is |
|---|---|
| `kustomization.yaml` | **The list of files to deploy** and the image version (`newTag`). Bump `newTag` to release a new version. |
| `bootstrap/bootstrap.yaml` | **One-time, cluster owner only.** Creates the `homelab-ui` and `homelab-apps` namespaces and all permissions. Re-apply when permissions change. |
| `controller.yaml` | The controller Deployment: the app container plus a Tailscale sidecar (the `controller` tailnet device), with health checks and mounts. |
| `tailscale-config.yaml` | How Tailscale forwards traffic: the controller (ports 80/443 to the app) and the LAN gateway (80/443 to Traefik). |
| `lan-gateway.yaml` | The `homelab-lan` Tailscale device, the entry point for all `*.lan.howellsas.com` (Internal) addresses. |
| `certificates.yaml` | Let's Encrypt setup (via Cloudflare DNS) and the two certificates: `controller.howellsas.com` and `*.lan.howellsas.com`. |
| `native-uis.yaml` | Routes for `proxmox.lan`, `truenas.lan` and `rancher.lan`, giving the native UIs over Tailscale with trusted HTTPS. |
| `storage.yaml` | Disks: app database (node disk), nightly backups (NAS), and the LAN gateway's Tailscale state. |

**Created by hand, never in the repo:** the Secrets `proxmox`, `truenas`, `github`, `tailscale-auth`, `cloudflare-dns` and `ghcr`.

---

## `docs/`

| File | What it is |
|---|---|
| `FILES.md` | This guide. |
| `ROADMAP.md` | The build plan, phase by phase, and its status. |
| `CONTEXT.md` | Working notes: decisions, verified facts (IPs, versions), incidents and what's pending. Read it before making changes. |
| `source-roadmap.txt` | Text copy of the original 4-week roadmap PDF. Only weeks 1–2 (the website) were built. |

---

## Common tasks: which file?

| I want to… | Edit |
|---|---|
| Change a domain, namespace or storage default | `server/src/config.ts` (or set the env var in `k8s/controller.yaml`) |
| Improve an error message | `server/src/k8s/status.ts` |
| Add a button or change a page | `web/src/pages/<Page>.tsx` |
| Add an API action | `server/src/routes.ts` + the logic in `server/src/k8s/` |
| Give the controller a new permission | `k8s/bootstrap/bootstrap.yaml` (cluster owner re-applies) |
| Release a new version | Commit, push tag `vX.Y.Z`, set `newTag` in `k8s/kustomization.yaml`, `kubectl apply -k k8s/` |
