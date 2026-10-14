# homelab-ui: working context

Read this first in any new session instead of re-reading chat. Keep it current.

## Ask (2026-10-12)
- Build the **web app** from the user's "Homelab Control Plane" roadmap (`source-roadmap.txt`,
  weeks 1–2 only). **Do not build weeks 3–4** (Tauri desktop or iPhone app, device pairing, ntfy).
- One UI to monitor the 3 systems and deploy and manage apps on them. It does not need to match
  Rancher (already installed); the goals are easy deploys and ease of use.
- User wants questions asked up front, and my own roadmap (`ROADMAP.md`).

## Source roadmap essentials (weeks 1–2)
- Stack: Node + Fastify (TS) backend; React + Vite + TanStack Query frontend served by the
  backend; one container; SQLite on a small PVC; one WebSocket pushes diffs.
- k8s: @kubernetes/client-node informers (Namespaces, Deployments, ReplicaSets, Pods, Services,
  Ingresses, IngressRoutes, PVCs, Events). Handle 410 Gone by relisting.
- Proxmox: REST with an API token, polling /cluster/resources every 5 s; VM and LXC start,
  shutdown and stop.
- TrueNAS: JSON-RPC 2.0 WebSocket with an API key (pin the API version); pools, datasets,
  subscribing to alert.list.
- App = labels `homelab.io/app=<name>`, `homelab.io/managed=true`; source in an annotation.
- Deploy sources: pasted YAML (server-side dry-run, then SSA with a fixed field manager), image
  form (registry existence check; Deployment, Service, PVC and route), GitHub repo (tarball pinned
  to SHA; detect kustomization.yaml > k8s/ or deploy/ > Dockerfile).
- Manage: restart, scale, edit env, logs, rollback to the previous ReplicaSet, delete by label
  (keep volumes on by default).
- Exposure toggle: Internal (`<app>.lan.howellsas.com`, Tailscale only) / Public
  (`<app>.howellsas.com`) / Off. Custom hostname with a collision check.
- Linking: inject `<TARGET>_URL` and `<TARGET>_HOST`, then roll; warn when deleting a dependency.
- Errors in plain language: ImagePullBackOff, CrashLoopBackOff (exit code and last 20 log lines),
  Pending, OOMKilled; 409, 422 and 403 normalized; rollout deadline leads to a rollback offer.
- Polish: home dashboard, Ctrl+K palette, phone layout, nightly SQLite backup.
- Wrap-up: move share-app under management, restart-safety test, token rotation in the UI,
  README, tag v0.1.
- One sign-in; every system credential stays server-side, encrypted in SQLite.

## Cluster facts I verified (2026-10-12)
- k3s v1.36.3, 4 nodes (Traefik LB IPs 192.168.0.155/.197/.204/.26). Rancher installed (cattle-*).
- My SA `claude:claude`: full namespaced rights in claude-sandbox and can **list pods in all
  namespaces**. It **cannot** create ClusterRoles, list nodes, StorageClasses or IngressClasses.
- Traefik (kube-system) has only the `web` and `websecure` entrypoints, so **no Tailscale-only
  entrypoint exists**. CRDs: traefik.io/v1alpha1 IngressRoute and Middleware are available.
- cloudflared (2 replicas) runs in ns `cloudflare`. Per the runbook, *.howellsas.com already
  reaches Traefik.
- Tailscale runs as a DaemonSet on all 4 nodes (ns `tailscale`).
- Storage: **csi-driver-nfs** (`nfs-bulk`) and `local-path`. democratic-csi is not installed,
  even though the roadmap assumes it.
- cert-manager is installed.
- Other namespaces: arr, forecast-chat, networking (empty), cloudflare, tailscale.

## Constraints from CLAUDE.md
- I deploy only into `claude-sandbox` (restricted PSS, with requests and limits). Cluster-scoped
  or kube-system changes go to the user.
- Images: GHCR `ghcr.io/chevvyy/<app>` through GitHub Actions; the repo is private,
  `chevvyy/<app>`.
- Secrets go in k8s Secrets, never in chat or the repo. Never print the GitHub token.

## Decisions / answers
(fill in as the user answers the questions in ROADMAP.md §Open questions)
- Q1: The 3 systems are k3s (4 nodes), Proxmox (a single machine, 192.168.0.36, probably :8006) and TrueNAS.
- Q2: The wrapper runs in a new namespace `homelab-ui`. The user applies the RBAC I write.
- Q3: Apps deploy to a new namespace (I picked `homelab-apps`). GHCR pulls must work in other
  namespaces too, so sync the pull secret into them.
- Q4: The wrapper's hostname is `controller.howellsas.com`.
- Q5: Tailscale-only, but routed through Traefik (IngressRoute + Middleware). No extra TLS
  verification work needed.
- Q6: Public = just a route on `<app>.howellsas.com`. No Cloudflare API or DNS automation.
- Q7: Proxmox: read access plus power (start, shutdown, stop) and snapshot. The user creates the
  API token.
- Q8: TrueNAS is **view-only** (pools, datasets, alerts). Keep it simple.
- Q9: Build wherever is best. The user allowed reusing my GitHub token, but it must never be
  stored elsewhere or given to deployed apps.
- Q10: Sign-in uses Tailscale identity (no password).
- Q11: Storage: nfs-bulk by default, local-path for databases.
- Q12: Display everything in all namespaces; existing apps stay in their namespaces.
- Q13: Build straight through. Check in only for major items or when stuck, and give the user
  exact step-by-step tasks.

## Findings after answers (2026-10-12)
- **Traefik never sees client IPs.** Tested: requests through the LB IPs arrive as 10.42.x.0
  (node/flannel) and tunnel requests as the cloudflared pod IP. Cause: externalTrafficPolicy=Cluster
  plus svclb SNAT. So a 100.64.0.0/10 ipAllowList on Traefik will NOT work, and there is no
  Tailscale identity behind Traefik.
- `*.howellsas.com` (single-label wildcard) does not cover `*.lan.howellsas.com`. Cloudflare only
  sends names to the tunnel when their DNS points there.
- The GHCR pull secret is `claude-sandbox/ghcr` (default SA imagePullSecrets). The plan is to copy
  it into homelab-ui as the source, and the controller syncs it into each namespace it deploys to
  and patches that namespace's default SA.
- metrics.k8s.io is available for node and pod CPU/RAM.
- Bootstrap RBAC for the user to apply: `k8s/bootstrap/bootstrap.yaml` (namespaces homelab-ui
  restricted, homelab-apps baseline; SA homelab-ui; ClusterRoles view, operate and manage;
  claude:claude gets manage in both namespaces).
- Deviation: system credentials live in k8s Secrets in homelab-ui (created by the user), not in
  encrypted SQLite. UI rotation writes to the Secret.

## Confirmed 2026-10-13 (A ok, B separate)
- A: Access. A Tailscale sidecar in the controller pod (tag:homelab-ui, userspace mode) runs
  `tailscale serve` → localhost and adds Tailscale-User-Login headers, which gives real Tailscale
  sign-in. DNS: Cloudflare A record `controller` → its 100.x IP (DNS only). Internal app mode:
  a Tailscale "lan gateway" pod proxies to Traefik, plus a `*.lan` A record → gateway 100.x;
  Traefik still routes internal and public apps.
- B: GitHub token. Recommend a separate fine-grained token for the controller in Secret
  homelab-ui/github. The alternative is copying Claude's token there (the user said "never store
  elsewhere", so that conflicts).
- User tasks issued: apply bootstrap, Proxmox token, TrueNAS key + version + URL, Tailscale auth
  key. DNS records come later, once the 100.x IPs are known.
- A confirmed: Tailscale sidecar for controller access + lan gateway for Internal apps.
- B confirmed: separate controller token in Secret homelab-ui/github (key `token`). NEVER copy Claude's token there.
- User tasks 1-5 pending (as of 2026-10-13). TrueNAS version unknown -> support both 25.x/26 (api/current endpoint).

## Build progress
(update per phase)
- AUTH DESIGN (verified in tailscale source v1.104): `tailscale serve` HTTP mode appends the
  MagicDNS suffix to the Host, so a custom host (controller.howellsas.com) would not match. Use
  instead serve config `{"TCP":{"80":{"TCPForward":"127.0.0.1:3000","ProxyProtocol":1}}}`.
  The backend parses the PROXY v1 header to get the tailnet source IP, then calls LocalAPI
  `/localapi/v0/whois?addr=ip:port` over the TS_SOCKET unix socket (shared emptyDir) to get
  the login, and rejects tagged devices. The UI listener is bound to 127.0.0.1:3000 only; probes
  use a separate :8081 /healthz.
- LAN gateway: a separate tailscale pod (hostname `homelab-lan`) with TCPForward 80 → traefik.kube-system:80.
  Internal apps = Traefik route Host(<app>.lan.howellsas.com) on `web`. User adds DNS `*.lan` A → gateway IP.
- cloudflared reaches Traefik's 'web' entrypoint (:80): my test IngressRoute on [web] was reachable at https://<x>.howellsas.com. Public routes use entrypoint web.
- 2026-10-13: Server core written: config.ts, k8s/{client,cache,labels,status,apps}.ts. Smoke test (`npx tsx src/_smoke.ts`)
  OK against the live cluster: 54 apps. claude SA lacks watch on nodes and cluster-wide ingressroutes (expected; the controller SA has them).
- Existing convention: `*.home.howellsas.com` hosts in ns arr (sonarr, radarr...). Unknown whether LAN-only; treated as "public"
  by hostExposure for now. Ask the user at the next check-in.
- Live findings worth telling the user: arr/flaresolverr and claude-sandbox/thp were OOMKilled; claude-sandbox/thp-test is not ready.
- NAS (likely TrueNAS) at 192.168.0.215 (NFS server used by arr pods).
- Proxmox https://192.168.0.36:8006 reachable from pods (401 w/o token).
- 2026-10-13: Server feature-complete (routes.ts, ws.ts, auth.ts, db.ts, github.ts, systems/{proxmox,truenas}.ts, k8s/{actions,deploy,exposure,links,registry,pullsecret,nodes}.ts).
  Local dev run: `$SCRATCH/restart.sh` (AUTH_MODE=dev, port 3300, health 8381, SELF/APPS ns = claude-sandbox).
  Verified live: image check, dry-run, deploy, Public via tunnel (curl 200, Off → 404), internal route via Traefik,
  restart, scale, env + validation, link env injection, rollback, logs, delete (+linkedBy), kube-system guard, 403 translation,
  PodSecurity translation. Image deploys auto-harden securityContext in namespaces with enforce=restricted.
- TrueNAS = 25.10.x at 192.168.0.215 (from /api/versions). The controller pins the newest listed API version.
- Next: web/ (React + Vite + TanStack Query), Dockerfile, workflow, k8s manifests (controller + tailscale sidecar, lan gateway).
export LD_LIBRARY_PATH=/home/node/.local/chromelibs/root/usr/lib/x86_64-linux-gnu:/home/node/.local/chromelibs/root/lib/x86_64-linux-gnu  # for screenshots: node $SCRATCH/pw/shot.mjs URL OUT [w h scheme]
- 2026-10-13: Web UI built (Dashboard, Apps, AppDetail, Deploy, Cluster, Proxmox, TrueNAS, Activity, Settings, Ctrl+K palette,
  mobile layout). Verified with headless Chromium screenshots (desktop + 390px light).
- Repo chevvyy/homelab-ui (private) pushed; Actions builds OK; image ghcr.io/chevvyy/homelab-ui:0.1.0 exists (tag v0.1.0).
  Smoke pod in claude-sandbox: health OK, UI served. Startup takes ~10-20 s.
- k8s/: storage (data local-path, backup nfs-bulk, lan-gateway-state), tailscale-serve ConfigMap, controller (+tailscale sidecar,
  userspace, state on PVC, TS_KUBE_SECRET=""), lan-gateway. Deploy: `kubectl apply -k k8s/` (namespace homelab-ui).
- WAITING ON USER: bootstrap apply, secrets proxmox/truenas/github/tailscale-auth. Then I: copy ghcr pull secret
  claude-sandbox → homelab-ui (pipe, never print), apply -k, read the tailscale IPs of controller/homelab-lan, and give the user
  the DNS records (controller A + *.lan A, DNS only). Then do an E2E check in homelab-apps (image, GitHub manifests, GitHub Dockerfile,
  internal/public, links, 4 failure modes). Later: share-app migration (ask first: it is live at share.howellsas.com).
- 2026-10-14: User completed tasks 1-5. DEPLOYED v0.1.1 in homelab-ui. Tailscale IPs: controller=100.65.27.122, homelab-lan=100.107.42.126
  (persist across restarts). Verified from the pod: Proxmox VE 9.2.9 (node "home", 4 guests; token has all 6 privs),
  TrueNAS 25.10.7 (pool Tankl ONLINE, API v25.10.5), GitHub token OK, all 14 watches OK, whois sign-in path OK.
- INCIDENT: a failed sed mask printed the base64 values of secrets github/proxmox/truenas/tailscale-auth in my tool output →
  told user to rotate all four. Never print secret objects again; use jsonpath on .data keys only.
- E2E in homelab-apps (all passed, then cleaned up): image+public via tunnel, internal via Traefik, off→404, link + reach,
  rollback keeps link env, 4 failure modes (bad image / crash w/ log lines / OOM / unschedulable), GitHub manifests,
  own-repo Dockerfile (workflow committed to repo), upstream repo via chevvyy/homelab-builds, redeploy latest, collision guard.
  Leftovers on GitHub: test repo chevvyy/hlui-e2e, GHCR packages hlui-e2e + traefik-whoami (user may delete).
- PENDING USER: Cloudflare DNS (controller A 100.65.27.122, *.lan A 100.107.42.126, DNS only), secret rotation, answers on
  *.home.howellsas.com and share-app migration. Then: real-browser login check (needs user), share-app migration if yes.
- 2026-10-14: User reports "Google is blocking" controller site on PC → most likely Chrome's default "Always use secure
  connections" warning for http://. Proposed HTTPS: (A, recommended) Let's Encrypt DNS-01 via Cloudflare token + cert-manager
  Issuer in homelab-ui (bootstrap updated with cert-manager.io rules; user must re-apply), controller terminates TLS after the
  PROXY header, *.lan wildcard cert for Internal apps; or (B) Tailscale HTTPS on controller.<tailnet>.ts.net. Awaiting choice.
- 2026-10-14: User chose option 1 (Let's Encrypt). v0.1.2 deployed: Issuer letsencrypt (DNS-01, Secret cloudflare-dns/api-token),
  certs controller-tls + lan-wildcard-tls READY (LE YR2, exp 2027-01-12, auto-renew). Controller: tailnet :443 → 127.0.0.1:3443
  (TLS after PROXY header, cert reloaded on change), :80 → 308 to https. Internal routes: websecure + tls lan-wildcard-tls
  (copied per ns by k8s/lantls.ts, resynced 6h) + `<app>-route-http` redirect via Middleware homelab-https-redirect.
  Verified: trusted TLS on controller, internal app 200 over https (trusted), http→https 301.
- 2026-10-14: user confirmed *.home.howellsas.com = home only → PRIVATE_DOMAINS (display as internal/'Home only').
- 2026-10-14: CONFIRMED working in a real browser on the user's iPhone (DNS + Tailscale + HTTPS + whois sign-in). PC (devinpc, Windows, Chrome) shows 'Your Internet access is blocked' → local PC issue (tailnet ping to devinpc OK, ACL allows it). Awaiting error code / Test-NetConnection result.
