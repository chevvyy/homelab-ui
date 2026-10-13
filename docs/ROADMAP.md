# homelab-ui: build roadmap (web app only)

Scope: weeks 1–2 of the source roadmap. Phases are ordered by dependency, not by calendar day.
Each phase ends with a demo I verify myself (curl, kubectl or a browser check) before moving on.
**[YOU]** marks steps only the user can do (cluster-scoped changes, credentials, DNS).

## Phase 0: Prerequisites (blocks everything)
- [YOU] Answer the open questions below.
- [YOU] Apply the RBAC I write: a ClusterRole and binding for the wrapper's ServiceAccount
  (read access across the cluster; write access in the namespaces it manages). I can't create
  cluster-scoped objects.
- [YOU] Create the credential Secrets for Proxmox, TrueNAS and Cloudflare (if used). I'll give
  you exact commands that read the values from your terminal; nothing goes through chat.
- Me: repo `chevvyy/homelab-ui`, monorepo (`server/`, `web/`), multi-stage Dockerfile, a GHCR
  workflow.

## Phase 1: Skeleton, sign-in and connections (source days 1–2)
- Fastify and React shell, `/api/health` listing visible namespaces, SQLite on a 1 GiB PVC
  (local-path).
- Password login with a session cookie; Connections table with tokens AES-GCM-encrypted with a
  key from a k8s Secret; "Test connection" for each system.
- Sidebar: Dashboard · Cluster · Proxmox · TrueNAS · Deploy.
- Demo: reached at the internal URL; refreshing keeps you signed in; Proxmox and TrueNAS test
  green.

## Phase 2: Live views (source days 3–4)
- k8s informer cache, with 410 handling, sent as diffs over one WebSocket; app list grouped by
  label; app detail page with pods, events and status.
- Proxmox: nodes (CPU, RAM, status), VM and LXC list, with start, shutdown and stop (confirm
  first).
- TrueNAS: pools, datasets (used and free), live alerts; back-off and a "disconnected" banner.
- Demo: `kubectl scale` appears in under 2 s; a dropped system shows the banner, not a crash.

## Phase 3: Deploy and manage (source days 5–7)
- YAML deploy: multi-doc parse, inject labels, dry-run preview, then server-side apply; source
  stored in an annotation.
- Image deploy: form, registry existence check, generates Deployment, Service, optional PVC and
  route (Off).
- Manage: restart, scale, edit env, live logs, delete by label (keep volumes is the default).
- Demo: traefik/whoami goes through its full lifecycle in the UI only.

## Phase 4: GitHub deploys (source days 8–9, adapted)
- Repo URL, branch and an optional token; tarball pinned to a SHA; detection order
  kustomization > k8s/ or deploy/ > Dockerfile; "Redeploy latest".
- **Dockerfile repos: recommended adaptation.** The in-cluster Kaniko and registry:2 path needs
  `registries.yaml` edited on every node, which is a node-level change. Instead, the wrapper adds
  or uses a GHCR Actions workflow in the repo, triggers it, streams the run status and deploys
  `ghcr.io/chevvyy/<repo>:<sha>`. This is the source roadmap's own cut-list fallback, and it
  matches how your apps are built today. (Kaniko can come later if you want it.)
- Demo: a manifests repo and a Dockerfile repo both deploy and redeploy by SHA.

## Phase 5: Exposure toggle (source day 10, adapted)
- Public: an IngressRoute or Ingress on `<app>.howellsas.com` (the wildcard tunnel already
  routes it).
- Internal: `<app>.lan.howellsas.com` plus an ipAllowList Middleware for 100.64.0.0/10, **or** a
  dedicated Tailscale entrypoint. See the question about this; it may need [YOU] for the Traefik
  config, DNS and a wildcard certificate.
- Off: remove the route. Custom hostname with a collision check across every route in the
  cluster.
- Demo: whoami goes Internal → Public → Off in under 30 s, each state verified with curl.

## Phase 6: Linking and plain-language errors (source days 11–12)
- "Link to" picker, `<TARGET>_URL` and `<TARGET>_HOST` injection, links shown on both apps, a
  dependency warning on delete.
- Status translator (ImagePullBackOff, CrashLoop with exit code and logs, Pending,
  OOMKilled) and API error normalization (409, 422, 403); rollout deadline watcher with
  one-click rollback.
- Demo: 4 deliberate failures, each showing its cause and a fix.

## Phase 7: Polish and hand-off (source days 13–14)
- Home dashboard, Ctrl+K palette, phone layout, nightly SQLite backup (a CronJob to an nfs-bulk
  PVC on the NAS).
- Restart-safety test, token rotation in the UI, share-app under management, README and runbook,
  tag v0.1.0.

## Status (2026-10-13)
- Phases 1-7 code complete and pushed (v0.1.0). Verified locally against the live cluster, and with the image smoke test.
- Blocked on the user's Phase 0 tasks; then deploy, DNS, E2E verification, share-app migration (needs a yes first).

## Open questions → answers recorded in CONTEXT.md §Decisions
