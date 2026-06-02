# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repo.

## What this repo is

**agent-wise** is a proof-of-concept Wiseway-branded AI assistant for blue-collar
staff. Staff log in, ask plain-English HR / SOP / safety questions, and get
**cited** answers drawn **only** from documents their **role** is allowed to see —
a warehouse worker can never see payroll docs, and every fact links back to its
source policy.

It is a **handover PoC**. It runs locally out-of-the-box against bundled sample
docs, a mock phone+PIN login, and a local LLM, so the Wiseway integration team can
see the whole workflow end-to-end before wiring it into real systems. The pieces
flagged `INTEGRATE:` (mock IdP, local doc backend, local model) are the ones the
team replaces.

Read `README.md` for the runbook. The two handover docs are the real deliverables:
- **`docs/INTEGRATION.md`** — the handover guide: every touch point the team must
  build (auth/SSO, hosting, SharePoint, the LLM, roles, doc-proxy, audit, secrets,
  security review).
- **`docs/ARCHITECTURE.md`** — clean architecture + diagrams.

> Note: as of this writing `docs/` is empty — `INTEGRATION.md` and
> `ARCHITECTURE.md` are still to be written. Several in-repo comments and the older
> sub-READMEs point at them; create them rather than inventing alternative paths.

## The chain (how it works)

Staff log in via OIDC → LibreChat gets identity + a business **role** → staff ask a
question → the pinned **"Wiseway HR & SOP Assistant"** agent (local LLM) calls the
doc-search MCP tool → **the tool filters documents by the user's role before
anything reaches the model** → the model answers with a cited `[Title](source_url)`
link.

## Services + how to run

Four Docker services (`docker-compose.yml`) plus the LLM running **natively on the
host** (Ollama, Metal GPU — deliberately not in Docker):

| Service | Port | What it is | Source of truth |
|---|---|---|---|
| `librechat` | 3080 | Chat UI + API + agent runtime (forked LibreChat image) | `deploy/librechat.yaml` |
| `mongodb` | — | LibreChat datastore (Mongo 8) | — |
| `wiseway-idp` | 9000 | **MOCK** OIDC provider (phone + PIN) — LOCAL DEV ONLY | `mock-idp/` |
| `wiseway-doc-search` | 8000 | Role-scoped doc-search tool over MCP — **the access gate** | `mcp-doc-search/` |
| Ollama (host) | 11434 | Local LLM `qwen2.5:7b`, reached at `http://host.docker.internal:11434/v1/` | configured in `deploy/librechat.yaml` `endpoints.custom` |

First-run (full steps in `README.md`):

```bash
cp deploy/.env.example deploy/.env     # then fill the REPLACE_ME_* crypto secrets
./mock-idp/gen-certs.sh                 # self-signed cert for the mock IdP
echo "127.0.0.1 host.docker.internal" | sudo tee -a /etc/hosts
ollama pull qwen2.5:7b && ollama serve
docker compose up -d
# After each demo user logs in once (creates their Mongo user doc):
./deploy/seed-roles.sh                  # writes the business role onto each user
```

Open <http://localhost:3080> (auto-redirects to the Wiseway phone+PIN login). Demo
logins + role→category table are in `README.md`.

Run / tail:

```bash
docker compose logs -f librechat wiseway-idp wiseway-doc-search   # tail all three
docker compose restart wiseway-idp librechat                      # after editing env/config
docker compose up -d --force-recreate wiseway-doc-search          # after changing the doc backend
docker compose down        # stop, keep data       |     down -v   # also drop volumes
```

## Where the source of truth lives (by concern)

- **Auth / login** → `mock-idp/` — a `node-oidc-provider` phone+PIN simulator.
  `staff.js` is the demo user directory (mobile/pin/role/name/email/sub);
  `server.js` configures the OIDC provider and emits the `role` claim;
  `views/login.html` is the branded login page. **Replaced wholesale at
  integration** by Wiseway SSO.
- **Retrieval + roles (the security spine)** → `mcp-doc-search/`:
  - `server.js` — the MCP server and the **only** place the role gate is applied.
  - `roles.yaml` — the role → allowed-category map (the policy).
  - `backends/local-folder.js` — BM25 (MiniSearch) over `sample-docs/` (default).
  - `backends/graph.js` — real SharePoint via Microsoft Graph app-only.
  - `backend.js` — selects the backend from `WISEWAY_DOC_BACKEND`.
- **LibreChat wiring** → `deploy/librechat.yaml` — branding, the Ollama custom
  endpoint, the `wiseway-docs` MCP server (headers), and the `Wiseway HR & SOP
  Assistant` model spec. Keep **all** Wiseway customization here; never patch
  LibreChat source. Env lives in `deploy/.env` (copied from `deploy/.env.example`,
  gitignored).
- **Branding** → `deploy/wiseway-assets/` (logo + favicons, mounted over
  LibreChat's `/app/client/dist/assets`). Plus three text knobs:
  `APP_TITLE` (env), `interface.customWelcome`, `interface.customFooter`.
- **Sample corpus** → `sample-docs/` — 6 HR/SOP/safety/payroll markdown docs with
  YAML front-matter (`title`, `category`, `source_url`). `category` is what the
  role gate filters on.

## Swappable doc backend: `WISEWAY_DOC_BACKEND = local | graph`

- `local` (default, no creds) — BM25 over `sample-docs/`.
- `graph` — real SharePoint via Microsoft Graph **app-only** (the "machine
  login"): an Entra app (client id + secret) granted `Sites.Selected` **read** on
  **one** site. Staff have no SharePoint accounts; this one service identity reads
  on their behalf. See `ENTRA-APP-SETUP.md`.

Both backends expose the **same** interface (`search(query, limit)` /
`fetch(doc_id)` returning `{ doc_id, title, source_url, snippet/body, category }`)
and **neither** does role filtering — so swapping the backend cannot weaken the
gate. (`graph.js` lists files under `SHAREPOINT_ROOT_FOLDER`, downloads + extracts
`.docx` text with `mammoth`, and ranks locally; it does **not** use Graph
`/search` because that endpoint returns 500 under app-only `Sites.Selected`. Note
the code comments in `graph.js` and the recipe in `ENTRA-APP-SETUP.md` differ on
list-and-rank vs `/search` — the list-and-rank code is what actually runs.)

## Security invariant (do not break this)

**The role gate is enforced in the tool, never by the model.** Identity is never a
tool argument and never comes from the LLM. LibreChat injects three headers on
every MCP call (`deploy/librechat.yaml` `mcpServers.wiseway-docs.headers`):

- `X-User-Role` ← `{{LIBRECHAT_USER_ROLE}}` — the business role.
- `X-User-Id` ← `{{LIBRECHAT_USER_ID}}` — for the audit log.
- `X-Mcp-Key` ← `${WISEWAY_MCP_SHARED_SECRET}` — proves the call came from LibreChat.

`mcp-doc-search/server.js`:
- rejects any request whose `X-Mcp-Key` ≠ `WISEWAY_MCP_SHARED_SECRET` (`401`);
- reads the role from `X-User-Role`, looks it up in `roles.yaml`, and **drops
  disallowed-category hits before returning** — the model never sees them;
- **fails closed**: an unknown/empty role gets an empty allow-set (reads nothing),
  and `fetch` on a restricted doc behaves identically to a missing doc (no leak).
- logs one JSON audit line per call (`tool, role, user_id, query/doc_id,
  returned_doc_ids`) to stdout.

When editing, keep these three things true: role is **header-only**, filtering
happens **server-side in `server.js`**, and any new backend stays role-unaware.

## The LibreChat role / permission nuance (important)

LibreChat lands every OIDC user as the platform role `USER`. The **business** role
(`warehouse`/`driver`/`office`/`hr-admin`) is the `role` string on the user's Mongo
document — that is what flows to the tool via `{{LIBRECHAT_USER_ROLE}}`.
`deploy/seed-roles.sh` writes it (keyed by email) after first login.

Catch: in LibreChat, `role` **also** drives the user's own feature permissions via
a `roles` collection in Mongo. `seed-roles.sh` sets `user.role` but does **not**
create matching `roles`-collection documents — so for the demo this works because
the agent + MCP tool don't depend on per-role feature perms, but at integration the
business roles **must exist in the Mongo `roles` collection** (clone the `USER`
permission set) or those users may lose UI capabilities. Flag this in
`docs/INTEGRATION.md` under auth/roles.

## The pinned agent (one-time, UI-only)

The **"Wiseway HR & SOP Assistant"** agent is created **once** in LibreChat's Agent
Builder UI (it cannot be declared in yaml): endpoint Ollama, model `qwen2.5:7b`,
add the `search` + `fetch` tools from the `wiseway-docs` MCP server, paste the
citing system prompt (the load-bearing text is in `deploy/librechat.yaml` as a
comment above `modelSpecs`). Then copy the resulting `agent_id` into
`modelSpecs.list[0].preset.agent_id` and restart LibreChat. The agent's in-chat
avatar is uploaded once in the same UI.

## Common gotchas (discovered the hard way)

- **OIDC issuer must be HTTPS** — LibreChat rejects a plain-HTTP issuer, so the
  mock IdP serves TLS (`gen-certs.sh` + `NODE_EXTRA_CA_CERTS`). Issuer is
  `https://host.docker.internal:9000` and must resolve the **same** from the
  browser and the container — hence the `/etc/hosts` line.
- **`mcpSettings.allowedDomains` must list the internal MCP host** (`wiseway-doc-search`)
  or LibreChat's SSRF guard blocks the connection ("Domain … is not allowed").
- **`DOMAIN_SERVER` / `DOMAIN_CLIENT` are required** — LibreChat builds the OIDC
  callback `redirect_uri` from them; unset → login fails with "Invalid URL".
- **The agents endpoint must be enabled** (`endpoints.agents` + `interface.agents:
  true`) — it hosts the assistant and its MCP tools.
- **`modelSpecs.iconURL` must be a PNG** (`/assets/icon-192x192.png`) — an SVG that
  wraps a raster fails to render in-chat.
- **`X-Mcp-Key` mismatch = 401 from doc-search** — the same value must be in
  `deploy/.env` (`WISEWAY_MCP_SHARED_SECRET`) and the header in `librechat.yaml`.
- **No role scoping = role not seeded** — re-run `seed-roles.sh` and re-login; the
  user doc must exist (first login) before the role can be written.
- `qwen2.5:7b` is the tool-calling model the demo relies on; a different local
  model may not reliably call `search`/`fetch` or cite.

## Filename drift to watch

Some older sub-READMEs (`deploy/README.md`) refer to `deploy/.env.wiseway.example`
and a `deploy/data-node/` Mongo volume. The actual files are
**`deploy/.env.example`** and the named volume **`mongo-data`** (see
`docker-compose.yml`). Trust the real files; fix the stale references if you touch
those docs.

## Hard rules

- **No real secrets in the repo, ever** — it is clean; keep it clean. All real
  secrets (Graph client secret, LibreChat crypto keys, MCP shared secret) live only
  in the gitignored `deploy/.env`.
- Keep the four runtimes of "the same thing" consistent: the mock IdP staff list
  (`mock-idp/staff.js`), the role map (`mcp-doc-search/roles.yaml`), the Mongo seed
  (`deploy/seed-roles.sh`), and the README staff/role tables all describe the same
  four users and four roles — change one, change all.
- Reference files by their real paths. Verify against the actual files before
  documenting — this is a handover; accuracy is the product.
