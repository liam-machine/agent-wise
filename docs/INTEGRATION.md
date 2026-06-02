# Integration Guide — agent-wise → Wiseway production

**This is the handover document.** It is the contract between the PoC you have
been given and the production system your team will build. Read it end-to-end
before changing anything.

It is organised around **nine integration touch points**. Each touch point has
a *Goal*, the concrete *What to do* (exact files and environment variables), the
*Decisions to make*, and a *PoC shortcut vs production* note that tells you what
the demo fakes and what production must do instead.

Companion docs:
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how the four services fit together.
- **[../ENTRA-APP-SETUP.md](../ENTRA-APP-SETUP.md)** — step-by-step Entra app
  registration and the SharePoint per-site grant (referenced from §3).
- **[../README.md](../README.md)** — local quickstart and the demo script.

---

## Executive summary

The PoC proves one thing end-to-end: **a blue-collar staff member can log in with
a phone number, ask an HR or safety question in plain English, and get a cited
answer drawn only from the documents their job role is allowed to see** — with a
warehouse worker provably unable to retrieve payroll documents. It runs today on
one machine against bundled sample documents, a mock login, and a local AI model,
so you can watch the whole workflow before wiring in real systems.

Integration means swapping each fake for the real Wiseway equivalent **without
changing the workflow or the security model**: replace the mock login with
Wiseway SSO, point the document tool at the real SharePoint HR/SOP library, host
the AI model on approved Australian infrastructure, and run the four services on
Wiseway's own platform. The access control that makes a warehouse worker unable
to read payroll is enforced in one place — the document-search tool — and that
does not change when you integrate; it only gets fed real identities and real
documents.

---

## Touch-point summary

| # | Touch point | What the team builds | Files / env affected | Effort / owner |
|---|---|---|---|---|
| 1 | **Auth / login → Wiseway SSO** | Repoint LibreChat OIDC at Wiseway's OAuth2/OIDC endpoints; map the `role` claim to the business role the tool reads | `deploy/.env` (`OPENID_*`), `deploy/seed-roles.sh` / Mongo `users` + `roles` collections | Medium — IdP/SSO team + integration |
| 2 | **Hosting** | Run LibreChat, MongoDB, the doc-search tool and the LLM on Wiseway infra; TLS, persistence, scaling | `docker-compose.yml` → orchestrator manifests; `deploy/librechat.yaml` | Large — platform/infra |
| 3 | **SharePoint (machine login)** | Register the Entra app, grant `Sites.Selected` read on the HR/SOP site, flip the backend to `graph` | `deploy/.env` (`TENANT_ID`, `GRAPH_*`, `SHAREPOINT_*`), `docker-compose.yml` (`WISEWAY_DOC_BACKEND`), [ENTRA-APP-SETUP.md](../ENTRA-APP-SETUP.md) | Medium — M365 admin + integration |
| 4 | **The LLM / model** | Choose and host an AU-region model (self-host or cloud); point LibreChat at it | `deploy/librechat.yaml` (`endpoints.custom`) | Medium/Large — ML/platform + privacy |
| 5 | **Roles & access policy** | Define the role catalogue and role→category map; structure SharePoint into per-category folders | `mcp-doc-search/roles.yaml`, SharePoint folder layout, HR/IdP role source | Medium — HR + security + integration |
| 6 | **Citation links / doc-proxy** | Build a small proxy so cited links open for login-less staff | new service + `mcp-doc-search` (link rewrite) | Small/Medium — integration |
| 7 | **Audit / logging** | Pipe the tool's JSON audit lines to the SIEM; set retention + PII handling | `mcp-doc-search/server.js` (already logs), log pipeline | Small — security/platform |
| 8 | **Secrets management** | Move every secret into a vault; rotate the Graph client secret on expiry | `deploy/.env` → vault, orchestrator secret store | Small/Medium — platform/security |
| 9 | **Security review** | Replace mock IdP + demo certs + demo signing key; pen-test the integrated system | `mock-idp/` (deleted), `deploy/.env` crypto secrets | Medium — security |

> **Where the demo and the older sub-folder READMEs disagree, this guide and the
> code are authoritative.** A few older notes drifted from the current code (the
> env template is `deploy/.env.example`, not `.env.wiseway.example`; Mongo data is
> a named volume `mongo-data`, not `deploy/data-node`; brand assets mount under
> `/app/client/dist/assets`; the in-chat icon is a PNG; the graph backend lists +
> extracts rather than calling Graph `search(q=)`). Those points are called out
> below where they matter.

---

## §1 — Auth / login → Wiseway SSO

### Goal
Replace the mock phone+PIN identity provider (`mock-idp/`, service `wiseway-idp`)
with Wiseway's real SSO so staff sign in with their actual corporate/merged
staff+warehouse credentials, and so the **business role** that drives document
access flows from a trusted source rather than a hand-seeded Mongo field.

### What to do

**1. Stand down the mock IdP.** Delete the `wiseway-idp` service from
`docker-compose.yml` (and the `depends_on: wiseway-idp` line under `librechat`),
and remove the mock-cert volume mount and the `NODE_EXTRA_CA_CERTS` env line that
exist only to trust the mock IdP's self-signed certificate:

```yaml
# docker-compose.yml — remove from the librechat service once on real SSO:
#   - NODE_EXTRA_CA_CERTS=/app/certs/idp.crt
#   - ./mock-idp/certs/idp.crt:/app/certs/idp.crt:ro
```

The whole `mock-idp/` directory can then be deleted from the deployment image.

**2. Repoint LibreChat's OIDC at the four Wiseway OAuth2/OIDC endpoints.** All of
this lives in `deploy/.env` under the **OpenID Connect** block. LibreChat uses
standard OIDC discovery, so you primarily set the **issuer**; LibreChat then reads
`/.well-known/openid-configuration` to find the authorize/token/jwks/userinfo
URLs. Provide the issuer that exposes these four endpoints:

| Wiseway endpoint | Role in the flow |
|---|---|
| `/oauth2/authorize` | browser is redirected here to log in |
| `/oauth2/token` | LibreChat exchanges the auth code for tokens |
| `/oauth2/jwks` | LibreChat fetches signing keys to validate the ID token |
| `/userinfo` | LibreChat reads user claims (fallback if not in the ID token) |

Set in `deploy/.env`:

```bash
OPENID_ISSUER=https://login.wiseway.example/        # the real Wiseway SSO issuer (CA-signed HTTPS)
OPENID_CLIENT_ID=<client id Wiseway issues for LibreChat>
OPENID_CLIENT_SECRET=<from vault — see §8>
OPENID_CALLBACK_URL=/oauth/openid/callback          # full URL is DOMAIN_SERVER + this
OPENID_SCOPE=openid profile email                   # add the scope that carries the role claim
OPENID_USERNAME_CLAIM=preferred_username
OPENID_NAME_CLAIM=name
OPENID_EMAIL_CLAIM=email
OPENID_AUTO_REDIRECT=true                            # skip LibreChat's own login screen
OPENID_BUTTON_LABEL=Wiseway Staff Login
OPENID_SESSION_SECRET=<fresh 64-hex random — see §8>
```

Also set the public base URLs LibreChat uses to build the callback `redirect_uri`
(in `deploy/.env`): `DOMAIN_SERVER` and `DOMAIN_CLIENT` must be the real public
HTTPS URL of the app, and that exact `redirect_uri`
(`<DOMAIN_SERVER>/oauth/openid/callback`) must be registered on the Wiseway SSO
client. Keep `ALLOW_EMAIL_LOGIN=false`, `ALLOW_REGISTRATION=false`,
`ALLOW_SOCIAL_LOGIN=true` so SSO is the only way in.

**3. Make the IdP emit a role claim.** The single most important integration
requirement: **the Wiseway IdP must return each user's business role**
(warehouse / driver / office / hr-admin, or whatever §5 defines) in a token
claim — ideally on the `profile` scope. In the mock IdP this is the `role` claim
(see `mock-idp/server.js`, `claims.profile` includes `role`). If Wiseway's IdP
calls it something else, you map it in step 4.

**4. Get the role onto the Mongo user document — and mind the roles-collection
nuance.** This is the subtle part. LibreChat lands **every** OIDC user as its
generic platform role `USER`. The *business* role is a separate string,
`user.role`, on the Mongo user document. That string is what LibreChat
substitutes into the `{{LIBRECHAT_USER_ROLE}}` template, which becomes the
`X-User-Role` header the doc-search tool reads (see `deploy/librechat.yaml`
`mcpServers.wiseway-docs.headers`).

In the demo, `deploy/seed-roles.sh` hand-writes `user.role` per email. **You must
replace the hand-seed with automatic mapping from the IdP role claim.** Two
viable paths:

- **Preferred:** configure LibreChat's OIDC role mapping so the claim from step 3
  is written to `user.role` at login (LibreChat supports mapping an OIDC claim to
  the user role; map your role claim → `user.role`). No seed script in prod.
- **Bridge:** keep a small reconciliation job that reads the role from the HR
  system / IdP and writes `user.role` (the same field `seed-roles.sh` writes),
  keyed by the stable user identifier (email or `sub`).

> **The roles-collection nuance — do not skip this.** In LibreChat, `user.role`
> ALSO selects the user's feature-permission set, and LibreChat looks that role up
> in its Mongo **`roles`** collection. Out of the box that collection contains
> only `USER` (and `ADMIN`). If you set `user.role = "warehouse"` and there is no
> `warehouse` document in the `roles` collection, LibreChat has no permission set
> for that user and the UI can misbehave. **Therefore each business role must also
> exist as a document in the Mongo `roles` collection, cloned from the `USER`
> permissions.** In the demo this is implicitly fine because the values still
> resolve; in production, seed the `roles` collection once with one cloned-from-
> `USER` document per business role (`warehouse`, `driver`, `office`, `hr-admin`,
> …) so the business role works both as a doc-access key *and* as a valid
> LibreChat permission role.

### Decisions to make
- **How does the role reach us?** A token claim (cleanest) vs a lookup against the
  HR system at login. Pick one and own it.
- **Claim name and value vocabulary.** The values must match the keys in
  `mcp-doc-search/roles.yaml` exactly (case-insensitive; the tool lowercases). If
  the IdP emits e.g. `WAREHOUSE_OPERATOR`, add a normalisation map.
- **Stable user key.** `sub` (opaque, stable) vs email (human-readable, can
  change). The tool only needs the role; the audit log keys on `X-User-Id`.
- **Login UX for shared/kiosk warehouse devices** (session length, auto-logout).

### PoC shortcut vs production
- **Shortcut:** mock OIDC provider, phone+PIN against four hard-coded accounts in
  `mock-idp/staff.js`, a throwaway committed signing key, a self-signed cert, and
  a manual `seed-roles.sh` to set roles.
- **Production:** real Wiseway SSO over CA-signed HTTPS, real credential policy
  and MFA owned by the IdP, role delivered by claim, role-to-Mongo mapping
  automated, and the `roles` collection pre-seeded. **The mock IdP is not secure
  and must be removed** (see §9).

---

## §2 — Hosting (front end + back end on Wiseway infra)

### Goal
Run the four moving parts — LibreChat (UI + API), MongoDB, the doc-search tool,
and the LLM — on Wiseway's own infrastructure, with TLS, durable storage,
backups, and the ability to scale, replacing the single-laptop Docker Compose
stack.

### What to do

**Translate the stack.** `docker-compose.yml` defines the topology you need to
reproduce on the target orchestrator (Kubernetes, ECS, App Service, etc.):

| Compose service | Production shape | Notes |
|---|---|---|
| `librechat` (`:3080`) | Stateless web/API deployment behind ingress + TLS | Reads config from `deploy/librechat.yaml` (mount as `/app/librechat.yaml` via `CONFIG_PATH`) and env from `deploy/.env`. Scale horizontally; it is stateless apart from Mongo. |
| `mongodb` | **Managed/HA MongoDB with persistence + backups** | The demo uses a single `mongo:8.0.20` with a named volume `mongo-data`. Production needs real durability — this holds users, roles, and conversation history. |
| `wiseway-doc-search` (`:8000`) | Internal-only deployment | Stateless; in-memory index/cache only (rebuilds on start, 5-min TTL for the graph backend). Reachable from LibreChat by service name; **not** publicly exposed. |
| Ollama (host) | The LLM — see §4 | In the demo this runs natively on the host at `http://host.docker.internal:11434/v1/`; in production it becomes a hosted endpoint. |

**Wiring you must preserve:**
- LibreChat → doc-search over `http://wiseway-doc-search:8000/mcp` (or the prod
  equivalent service DNS). The hostname must be in
  `deploy/librechat.yaml` `mcpSettings.allowedDomains` or LibreChat's SSRF guard
  blocks it ("Domain … is not allowed").
- LibreChat → LLM `baseURL` in `deploy/librechat.yaml` `endpoints.custom`.
- LibreChat → MongoDB via `MONGO_URI` in `deploy/.env`.
- LibreChat → Wiseway SSO (§1) and doc-search → SharePoint (§3) need **egress**
  from the cluster to those endpoints.

**Networking / exposure rules:**
- Only LibreChat is public (behind ingress + TLS). MongoDB, doc-search, and the
  LLM are internal.
- Keep the `X-Mcp-Key` shared-secret gate (§7/§8) so even on the internal network
  only LibreChat can call the tool.
- Drop the `extra_hosts: host.docker.internal` entries and the
  `NODE_EXTRA_CA_CERTS`/self-signed-cert mounts — those are local-dev artefacts.

### Decisions to make
- **Orchestrator and ingress/TLS** stack (cert source, WAF in front of LibreChat).
- **MongoDB**: managed service vs self-run replica set; backup cadence and
  retention for conversation history (which is PII — coordinate with §7).
- **Scaling**: LibreChat and doc-search scale horizontally; the LLM is the
  capacity-and-cost driver (§4). Doc-search holds an in-memory index per replica —
  fine, but each replica warms independently.
- **Config delivery**: how `librechat.yaml` and env reach the pods (ConfigMap +
  secret store, per §8).

### PoC shortcut vs production
- **Shortcut:** single-host Docker Compose; Mongo with no backups in a local
  volume; everything on one bridge network; `host.docker.internal` hops; LLM on
  the laptop's GPU.
- **Production:** orchestrated, TLS-terminated, horizontally scalable services;
  HA Mongo with backups; private networking with only LibreChat exposed; LLM as a
  managed/hosted endpoint.

---

## §3 — SharePoint (the machine login)

### Goal
Switch the doc-search tool from the bundled sample documents to the **real
Wiseway HR/SOP SharePoint library**, read by a single least-privilege machine
identity — because login-less staff have no SharePoint accounts of their own.

### What to do

Follow **[ENTRA-APP-SETUP.md](../ENTRA-APP-SETUP.md)** for the click-by-click; the
summary:

**1. Register the Entra app (the "machine login").** A single-tenant app
registration with a client secret. This identity signs in *as itself* (app-only /
client credentials), not as any staff member. From it you get `TENANT_ID`
(directory id) and `GRAPH_CLIENT_ID` (application id); create a client secret for
`GRAPH_CLIENT_SECRET`.

**2. Grant `Sites.Selected` read on ONLY the HR/SOP site.** Add the Microsoft
Graph **application** permission `Sites.Selected` and admin-consent it. By itself
that grants zero sites. Then grant *this app* `read` on the one target site. **The
Entra/Azure portal cannot do a per-site grant** — you must call Graph directly
(Graph Explorer or PowerShell `New-MgSitePermission`):

```http
POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
{ "roles": ["read"],
  "grantedToIdentities": [ { "application":
    { "id": "<GRAPH_CLIENT_ID>", "displayName": "wiseway-doc-search" } } ] }
```

Blast radius = exactly one SharePoint site, read-only.

**3. Set the Graph environment and flip the backend.** Put the real credentials in
`deploy/.env` (never committed — see §8). The variable names the code actually
reads (`mcp-doc-search/backends/graph.js`):

```bash
TENANT_ID=<directory/tenant id>
GRAPH_CLIENT_ID=<application/client id>
GRAPH_CLIENT_SECRET=<secret value — from vault>
SHAREPOINT_HOSTNAME=<tenant>.sharepoint.com          # default in code: contoso.sharepoint.com
SHAREPOINT_SITE_PATH=sites/<YourHRSite>              # default in code: sites/YourHRSite
SHAREPOINT_ROOT_FOLDER=<root subtree to index>       # default in code/compose: Wiseway-Demo
# SHAREPOINT_DRIVE_ID=<optional — pin a specific document library drive>
```

Flip the backend selector. In `docker-compose.yml` it is currently
`WISEWAY_DOC_BACKEND=local` on the `wiseway-doc-search` service; set it to
`graph` (or set it in `deploy/.env`):

```yaml
# docker-compose.yml, wiseway-doc-search service:
- WISEWAY_DOC_BACKEND=graph
```

Recreate the service so it reads the new env (`backend.js` selects the backend at
startup): `docker compose up -d --force-recreate wiseway-doc-search`.

**4. Understand how the graph backend actually reads SharePoint** (so you size and
debug it correctly). It does **not** use Graph's `search(q=)` endpoint —
that endpoint returns `500 generalException` under app-only `Sites.Selected`.
Instead `graph.js`:
1. resolves the site → its default document-library **drive**;
2. **recursively lists** every file under `SHAREPOINT_ROOT_FOLDER`;
3. **downloads** each file and **extracts text** (`.docx` via the `mammoth`
   library; `.txt`/`.md`/`.csv` as plain text; other types indexed by filename
   only);
4. **caches** the extracted corpus in memory (5-minute TTL, `GRAPH_INDEX_TTL_MS`)
   and **ranks locally** with a simple term-frequency score.

Implications: the first query after a cache miss pays the cost of listing +
downloading + extracting the whole subtree, so keep the indexed subtree scoped and
sized sensibly, and expect a cold-start delay per replica. PDFs and spreadsheets
are matched by filename only (no body text) — convert to `.docx`/`.md` if their
contents need to be searchable.

**5. Category comes from the folder.** The document *category* (which drives the
role gate, §5) is derived from the file's **parent folder name**: a path segment
containing `payroll` → `payroll`, `safety`/`whs` → `safety`,
`sop`/`procedure` → `sop`, `hr`/`human` → `hr`, otherwise default `hr`. **This is
why SharePoint must be foldered by category** — see §5.

### Decisions to make
- **Which site / library** is the source of truth for HR/SOP/safety/payroll docs.
- **Secret vs certificate** for the app credential (certificate preferred for
  production; the code currently uses a client secret).
- **Indexed subtree size** vs cold-start latency and download cost; consider a
  warmed/persistent index if the corpus is large.
- **`source_url` reachability** — the citation URL is the real SharePoint
  `webUrl`, which **will not open** for login-less staff (see §6).

### PoC shortcut vs production
- **Shortcut:** `WISEWAY_DOC_BACKEND=local` reads six markdown files from
  `sample-docs/` (BM25 via MiniSearch); no SharePoint, no credentials. The sample
  docs' front-matter even encodes the eventual SharePoint `source_url`s as the
  contract for the real library.
- **Production:** `WISEWAY_DOC_BACKEND=graph` against the real site via the
  least-privilege machine identity, with category-foldered content (§5), the
  client secret in a vault and on a rotation schedule (§8), and a doc-proxy for
  citations (§6).

---

## §4 — The LLM / model

### Goal
Replace the laptop's local Ollama model with a production model hosted on
**approved Australian infrastructure**, because staff questions can contain
personal information and the **Australian Privacy Act / data-residency** rules
apply to where that text is processed.

### What to do

The model is configured in `deploy/librechat.yaml` under `endpoints.custom`. The
demo entry points at Ollama on the host:

```yaml
endpoints:
  custom:
    - name: "Ollama"
      apiKey: "ollama"
      baseURL: "http://host.docker.internal:11434/v1/"   # <- change this
      models:
        default: ["qwen2.5:7b"]
```

To integrate, **point `baseURL` at the production model's OpenAI-compatible
endpoint** and set `apiKey` (from the vault, §8), then list the served model
name(s) under `models.default`. Two hosting shapes:

- **Self-hosted on Wiseway GPUs** (vLLM or Ollama on a GPU node/cluster): keeps
  every query inside Wiseway's network; you own the GPUs and scaling. Point
  `baseURL` at the internal inference service.
- **AU-region managed model** (e.g. AWS Bedrock *Sydney* / Azure OpenAI
  *Australia East*): no GPUs to run, data stays in-region. If the managed service
  is not natively OpenAI-compatible, front it with a small adapter and point
  `baseURL` at that.

Whichever you choose, confirm the model is a competent **tool-caller** — the whole
workflow depends on the model reliably calling the `search`/`fetch` MCP tools and
then citing. `qwen2.5:7b` was chosen for the demo specifically because it
tool-calls reliably; validate any replacement against the demo script before
trusting it.

The agent's citing instruction is load-bearing and lives in the agent's system
prompt (see the example prompt in `deploy/librechat.yaml`'s comment above
`modelSpecs`) — re-use it, since smaller local models will not auto-cite without
the explicit instruction.

### Decisions to make
- **Self-host vs AU-cloud** — the core call, driven by data-residency posture,
  GPU appetite, and cost. **Anything that sends query text outside Australia must
  clear privacy review first.**
- **Model + size** — quality vs latency vs GPU cost; must tool-call reliably.
- **Capacity/scaling** for concurrent staff at shift change.
- **Whether the chosen model still cites well** with the existing system prompt.

### PoC shortcut vs production
- **Shortcut:** `qwen2.5:7b` on Ollama, on the developer's laptop GPU, reached via
  `host.docker.internal`.
- **Production:** an approved, AU-resident, appropriately sized model on Wiseway-
  managed infra, with the `baseURL`/`apiKey` repointed in `librechat.yaml` and the
  credential in a vault.

---

## §5 — Roles & access policy

### Goal
Turn the demo's four-role map into Wiseway's real role catalogue and category
policy, and structure SharePoint so that the folder-derived category actually
gives meaningful role separation.

### What to do

**1. Define the role → category map** in `mcp-doc-search/roles.yaml`. This file is
the security policy in one place. The demo:

```yaml
roles:
  warehouse: [hr, sop, safety]
  driver:    [hr, sop, safety]
  office:    [hr, sop]
  hr-admin:  [hr, sop, safety, payroll]
```

Replace these with Wiseway's real roles and the categories each may read. Rules
the code enforces: roles are matched case-insensitively; a role **not listed here
gets an empty allow-set and can read nothing** (fail-closed); categories are
free-form strings but must match the folder-derived categories from §3
(`hr`, `sop`, `safety`, `payroll`, plus any you add).

**2. Structure SharePoint into per-category subfolders.** Because the graph
backend derives a document's category from its **parent folder name** (§3 step 5),
the real site must be foldered so each document lands in the right category — e.g.
under the indexed root:

```
<SHAREPOINT_ROOT_FOLDER>/
  HR/          -> category hr
  SOP/         -> category sop
  Safety/      -> category safety   (also matches "WHS")
  Payroll/     -> category payroll
```

A document in a folder that matches none of the keywords defaults to `hr`. **If
everything sits in one flat folder, every document becomes `hr` and role
separation collapses** — so the folder layout is a real security requirement, not
cosmetic. (Note the sample-docs `source_url`s currently point at a single
`Wiseway-Demo/HR-AU/` folder; production must fan documents out into the
category subfolders above.)

**3. Map roles from the system of record.** Decide where each staff member's role
comes from (HR system, the IdP claim from §1) and ensure those role values match
the `roles.yaml` keys (add a normalisation step if the source vocabulary differs).

### Decisions to make
- **The role catalogue** and **role→category matrix** — an HR/security policy
  decision, not just config. Get it signed off.
- **Category taxonomy** — keep the four, or add (e.g. `compliance`, `induction`).
  Every new category needs both a folder keyword rule and a `roles.yaml` entry.
- **Folder vs metadata for category** — the current code uses folder name; if
  Wiseway prefers SharePoint columns/metadata, that's a `graph.js`
  `deriveCategory()` change to plan.
- **Default-category policy** — is "unknown folder → `hr`" acceptable, or should
  unknown fail closed?

### PoC shortcut vs production
- **Shortcut:** four roles, four categories, category inferred from a single demo
  folder; role values hand-seeded to match `roles.yaml`.
- **Production:** the real role catalogue, SharePoint foldered by category, roles
  sourced from the IdP/HR system and normalised to the `roles.yaml` keys.

---

## §6 — Citation links / doc-proxy

### Goal
Make every cited source link actually **open** for a staff member who has no
SharePoint account — the unavoidable trade-off of the app-only machine login.

### What to do
With the graph backend, the citation `source_url` is the document's real
SharePoint `webUrl`. Staff authenticate to the *app* via SSO but have **no
SharePoint identity**, so clicking that link prompts them for a Microsoft login
they don't have, and the link fails. Two fixes:

- **Recommended — a small doc-proxy.** Build a lightweight service that, given a
  `doc_id`, streams the file using the **same machine login** the doc-search tool
  already uses (Graph app-only download). Rewrite citation links to point at the
  proxy (`https://assistant.wiseway.example/doc/<doc_id>`) instead of the raw
  `webUrl`. The proxy must **re-check the caller's role** against the same
  `roles.yaml` policy before streaming, so it can't be used to bypass the gate.
  The rewrite happens where hits are formatted (`mcp-doc-search/server.js`, the
  `search`/`fetch` text blocks).
- **Alternative — inline snippets only.** Render the cited snippet/body inline and
  drop the outbound link entirely, so there is nothing to fail to open. Simpler,
  but staff can't see the full source document.

### Decisions to make
- **Proxy vs inline-only** (proxy preserves "open the real document"; inline is
  less to build and operate).
- If proxy: **its own authn** (must trust the same SSO session) and **its own role
  re-check** (never trust the requested `doc_id` alone).
- Audit proxy downloads alongside the tool's audit log (§7).

### PoC shortcut vs production
- **Shortcut:** local backend `source_url`s are illustrative SharePoint URLs that
  don't need to open; the demo is about *showing a cited link*, not serving the
  file.
- **Production:** a role-aware doc-proxy (or inline snippets) so citations
  resolve for login-less staff without weakening the role gate.

---

## §7 — Audit / logging

### Goal
Get the document-access audit trail into Wiseway's SIEM, with defined retention
and PII handling.

### What to do
The tool **already emits a structured JSON audit line per call** — see
`audit()` in `mcp-doc-search/server.js`. Each line includes an ISO timestamp,
`tool` (`search`/`fetch`), `role`, `user_id`, the `query` or `doc_id`, the backend
name, and crucially `returned_doc_ids` (exactly which documents were surfaced).
Rejected calls (bad/missing `X-Mcp-Key`) and errors are logged too. It writes to
**stdout**, so:

- **Ship stdout to the SIEM** via the platform's normal log pipeline (the
  container already does the work; you just collect it).
- **Set retention** to meet Wiseway's policy for access logs.
- **Handle PII deliberately.** The `query` field is free text a staff member typed
  and can contain personal information; `user_id` is an identifier. Decide whether
  to store the raw query, redact/hash it, or shorten its retention — and document
  that decision.
- If you build the doc-proxy (§6), feed its download events into the same trail.

### Decisions to make
- **Retention period** and storage location for the audit log.
- **PII posture** on the `query` field (store / redact / hash / short-TTL).
- **Alerting** — e.g. flag bursts of `reject` (bad-key) events as a tamper signal.

### PoC shortcut vs production
- **Shortcut:** JSON lines to the container's stdout; nobody collects them.
- **Production:** stdout shipped to the SIEM, retention set, query-field PII
  handled per policy, alerts on rejects.

---

## §8 — Secrets management

### Goal
Get every secret out of `deploy/.env` and into a managed vault, and put the Graph
client secret on a rotation schedule before it expires.

### What to do
Inventory the secrets the system uses and move each into the orchestrator's secret
store / a vault, injecting them as env at runtime instead of a committed-adjacent
file. The secrets:

| Secret (env var) | Used by | Notes |
|---|---|---|
| `GRAPH_CLIENT_SECRET` | doc-search graph backend | **Rotate before expiry (~180 days).** Prefer a certificate. |
| `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CREDS_KEY`, `CREDS_IV` | LibreChat crypto | The `.env.example` ships `REPLACE_ME_*` placeholders — generate fresh per the one-liners in `deploy/.env.example` and never reuse the examples. |
| `OPENID_CLIENT_SECRET`, `OPENID_SESSION_SECRET` | OIDC login | Real values from Wiseway SSO + fresh session secret. |
| `WISEWAY_MCP_SHARED_SECRET` | LibreChat ↔ doc-search gate | The `X-Mcp-Key`. Generate a strong value; both sides must match. |

`deploy/.env` is already gitignored (see `.gitignore`), and the repo ships only
placeholders — **keep it that way**: no real secret ever lands in a tracked file.

### Decisions to make
- **Which vault** (Key Vault / Secrets Manager / sealed secrets / etc.) and how
  it injects into pods.
- **Rotation automation** for `GRAPH_CLIENT_SECRET` (and ideally a move to a
  certificate); rotation runbook for the LibreChat crypto keys and the MCP key.
- **Per-environment** secrets (dev/test/prod) and least-privilege access to them.

### PoC shortcut vs production
- **Shortcut:** all secrets in a gitignored `deploy/.env`; the MCP key and OIDC
  client secret are deliberately weak demo placeholders.
- **Production:** every secret in a vault, injected at runtime, rotated on
  schedule, scoped per environment.

---

## §9 — Security review before go-live

### Goal
Make sure nothing from the demo's "make-it-work-on-a-laptop" shortcuts survives
into production, and that the integrated system is independently tested.

### What to do — the demo artefacts that are NOT production-safe
- **The mock IdP (`mock-idp/`) is not security.** It authenticates four hard-coded
  accounts against plaintext PINs in `mock-idp/staff.js`. **Delete it** once on
  real SSO (§1).
- **The demo signing key is public.** `mock-idp/server.js` contains a throwaway
  RSA private key committed on purpose so the JWKS is stable across restarts. It
  is published in this repo — it must **never** be used anywhere real. Real signing
  keys belong to Wiseway SSO.
- **The self-signed certs are throwaway.** Generated by `mock-idp/gen-certs.sh`;
  trusted only via `NODE_EXTRA_CA_CERTS` for local dev. Production uses CA-signed
  TLS everywhere; remove that cert mount and env line.
- **Demo crypto/secret placeholders** in `deploy/.env.example` (`REPLACE_ME_*`,
  `wiseway-demo-secret`, `wiseway-mcp-shared-secret`) must be regenerated as real
  vault-held secrets (§8).
- **The agent is built once in the UI.** The `Wiseway HR & SOP Assistant` agent
  cannot be declared in YAML; it is created in LibreChat's Agent Builder and pinned
  by `agent_id` in `deploy/librechat.yaml` `modelSpecs`. Recreate it per
  environment and confirm the citing system prompt and the `search`/`fetch` tools
  are attached. (Branding: the in-chat icon comes from `modelSpecs.iconURL` and
  **must be a PNG** — the demo uses `/assets/icon-192x192.png`; an SVG that wraps a
  raster image fails to render. Logo/favicons are mounted over
  `/app/client/dist/assets`.)

### What to verify holds in production
- The role gate is enforced **in the tool, not the model** — confirm a low-
  privilege role provably cannot retrieve a restricted category (repeat the
  warehouse-vs-payroll demo against real data).
- The `X-Mcp-Key` gate is in place so only LibreChat can reach doc-search.
- The doc-proxy (§6), if built, re-checks role before streaming.
- Secrets are vaulted (§8) and the audit trail flows to the SIEM (§7).

### Decisions to make
- **Pen-test scope and timing** — the integrated system (SSO, app, tool,
  SharePoint, proxy) must be penetration-tested before go-live.
- **Privacy/DPIA sign-off** for query data and model hosting (ties to §4).
- **Threat model review** of the header-trust design under the real network.

### PoC shortcut vs production
- **Shortcut:** mock IdP, public demo signing key, self-signed certs, placeholder
  secrets — all fine on a laptop, none acceptable in production.
- **Production:** all demo auth artefacts removed, real SSO and TLS, vaulted
  secrets, and an independent pen-test + privacy sign-off before go-live.

---

## Go-live checklist

- [ ] **§1** Mock IdP removed; LibreChat `OPENID_*` pointed at Wiseway SSO
  (`/oauth2/authorize`, `/oauth2/token`, `/oauth2/jwks`, `/userinfo`); CA-signed
  HTTPS issuer; `redirect_uri` registered on the SSO client.
- [ ] **§1** IdP emits a role claim; role auto-maps to Mongo `user.role`; each
  business role exists as a cloned-from-`USER` document in the Mongo `roles`
  collection.
- [ ] **§2** LibreChat + Mongo + doc-search + LLM running on Wiseway infra; only
  LibreChat public; TLS at the ingress; Mongo persistent + backed up.
- [ ] **§3** Entra app registered; `Sites.Selected` read granted per-site on the
  real HR/SOP site; `TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET`/
  `SHAREPOINT_*` set; `WISEWAY_DOC_BACKEND=graph`.
- [ ] **§4** Approved AU-region model hosted; `endpoints.custom.baseURL`/`apiKey`
  repointed; tool-calling + citation validated against the demo script.
- [ ] **§5** `roles.yaml` reflects the real role→category policy; SharePoint
  foldered by category; role values normalised to the `roles.yaml` keys.
- [ ] **§6** Doc-proxy (role-rechecking) live, or inline snippets — citations open
  for login-less staff.
- [ ] **§7** Tool audit lines shipped to the SIEM; retention + query-PII policy
  set.
- [ ] **§8** All secrets in a vault; `GRAPH_CLIENT_SECRET` rotation scheduled;
  no real secret in any tracked file.
- [ ] **§9** Demo signing key/certs/placeholders gone; warehouse-vs-payroll gate
  re-verified on real data; pen-test + privacy sign-off complete.

---

## Security note

The local demo is intentionally insecure where insecurity buys convenience: the
**mock IdP is not real authentication**, the **OIDC signing key is a throwaway
committed in the repo**, the **TLS certs are self-signed**, and the **shared
secrets are demo placeholders**. None of these may reach production. Before go-
live, remove every demo auth artefact (§1, §9), move all secrets to a vault (§8),
confirm the role gate holds in the tool against real data, and have the integrated
system **independently penetration-tested** and cleared by privacy review.
