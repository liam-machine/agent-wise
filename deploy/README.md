# Wiseway Staff Assistant — deploy/

This folder holds the deployment glue for the demo: the LibreChat runtime
config, the environment template, the Wiseway brand assets, and the role-seed
script. The root `docker-compose.yml` wires everything together.

> All Wiseway customization lives in these added files. LibreChat source is
> never patched.

---

## What's in here

| File | Purpose |
|---|---|
| `librechat.yaml` | LibreChat runtime config — interface branding, the Ollama custom endpoint, the role-scoped `wiseway-docs` MCP server, and the `Wiseway HR & SOP Assistant` model spec. Mounted to `/app/librechat.yaml`. |
| `.env.wiseway.example` | Template for `deploy/.env` (which is gitignored). Copy it, then fill in the crypto secrets. |
| `wiseway-assets/logo.svg` | Wiseway wordmark. Mounted over `/app/client/public/assets/logo.svg`. |
| `wiseway-assets/favicon.svg` | Wiseway favicon mark. Mounted over `/app/client/public/assets/favicon.svg`. |
| `seed-roles.sh` | Sets each demo user's **business role** in Mongo (warehouse / driver / office / hr-admin). |
| `data-node/` | MongoDB data volume (created on first run; not committed). |

---

## One-time host setup

### 1. Add the `host.docker.internal` hosts entry (required)

The mock OIDC issuer is `http://host.docker.internal:9000`. The browser and the
LibreChat container **must resolve that host the same way**, or the OIDC
redirect will fail. Docker Desktop already resolves `host.docker.internal`
inside containers — but the macOS browser does not by default. Add it once:

```bash
echo "127.0.0.1 host.docker.internal" | sudo tee -a /etc/hosts
```

Verify:

```bash
ping -c1 host.docker.internal   # should resolve to 127.0.0.1
```

### 2. Run Ollama natively (required)

Ollama runs **natively on the macOS host** for Metal GPU acceleration — it is
deliberately **not** a Docker service. LibreChat reaches it across the Docker
bridge at `http://host.docker.internal:11434/v1/`.

```bash
ollama serve            # if not already running as a service
ollama pull qwen2.5:7b  # the model LibreChat is configured to use
```

### 3. Create your env file

```bash
cp deploy/.env.wiseway.example deploy/.env
```

Then edit `deploy/.env` and replace every `REPLACE_ME_*` crypto secret. Generate
fresh values with the official helper at
<https://www.librechat.ai/toolkit/creds_generator>, or locally:

```bash
# JWT_SECRET, JWT_REFRESH_SECRET, CREDS_KEY, OPENID_SESSION_SECRET  (64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# CREDS_IV  (32 hex chars)
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

The demo shared secrets (`WISEWAY_MCP_SHARED_SECRET`, `OPENID_CLIENT_SECRET`)
can be left as-is for local use.

---

## Bringing the stack up

From the repo root (`poc-staff-assistant/`):

```bash
docker compose up -d --build
```

Services:

| Service | Host port | What it is |
|---|---|---|
| `librechat` | 3080 | LibreChat API + UI → <http://localhost:3080> |
| `mongodb` | — | Mongo 8.0.20, data in `deploy/data-node/` |
| `wiseway-idp` | 9000 | Mock OIDC IdP (phone + PIN) |
| `wiseway-doc-search` | 8000 | Role-scoped MCP doc-search (`/mcp`) |

Open <http://localhost:3080>, click **Wiseway Staff Login**, and sign in with a
demo phone + PIN (see the table below).

---

## Demo staff

| Mobile | PIN | Business role | Display name | Email |
|---|---|---|---|---|
| 0412345678 | 1234 | `warehouse` | Sam Tran (Warehouse) | sam.tran@wiseway.demo |
| 0423456789 | 2345 | `driver` | Dee Okafor (Driver) | dee.okafor@wiseway.demo |
| 0434567890 | 3456 | `office` | Olivia Park (Office) | olivia.park@wiseway.demo |
| 0445678901 | 4567 | `hr-admin` | Hannah Reed (HR Admin) | hannah.reed@wiseway.demo |

Each role may read different document categories — that gate is enforced
server-side in the MCP doc-search service (`mcp-doc-search/roles.yaml`):

| Role | Allowed categories |
|---|---|
| `warehouse` | hr, sop, safety |
| `driver` | hr, sop, safety |
| `office` | hr, sop |
| `hr-admin` | hr, sop, safety, payroll |

---

## Seeding business roles (important)

LibreChat's OIDC strategy lands **every** new user as the generic `USER` role.
The Wiseway **business role** (`warehouse` / `driver` / `office` / `hr-admin`)
is a separate string on the user document. LibreChat substitutes it into the
`X-User-Role` header (`{{LIBRECHAT_USER_ROLE}}`) that the MCP tool reads to
decide which documents the user may see.

The user document is created on first login, so:

1. Have each demo user sign in once via **Wiseway Staff Login**.
2. Run the seed script:

   ```bash
   ./deploy/seed-roles.sh
   ```

   It runs `mongosh` inside the `mongodb` container (no host install needed) and
   sets each demo email to its business role. It is **idempotent** — re-run any
   time. Users who haven't logged in yet are reported as "awaiting first login";
   just re-run after they do.

> You can also pre-seed before login — the `updateOne` calls simply match zero
> documents until the user exists, then take effect on the next run.

---

## How branding works (which knob does what)

Four independent knobs, all owned by this repo:

| Knob | Where | Controls |
|---|---|---|
| `APP_TITLE` | `deploy/.env` → consumed by LibreChat | App name shown in the header / browser tab. Set to `Wiseway Assistant`. |
| `interface.customWelcome` | `librechat.yaml` | The greeting shown on a fresh chat. |
| `interface.customFooter` | `librechat.yaml` | The footer line under the composer (`Wiseway Logistics — internal use only`). |
| `wiseway-assets/logo.svg` + `favicon.svg` | mounted over `/app/client/public/assets/…` in `docker-compose.yml` | The logo + favicon. Replace the SVGs and restart — no rebuild needed. |

The model spec `Wiseway HR & SOP Assistant` in `librechat.yaml` also carries its
own `greeting` and `iconURL: /assets/logo.svg`, so the curated assistant card is
branded too.

### Finishing the assistant (one-time, in the UI)

`librechat.yaml`'s model spec references an agent by id, but the agent itself is
created once in the **Agent Builder** UI:

1. Sign in as an admin and open **Agents → New agent**.
2. Endpoint **Ollama**, model **qwen2.5:7b**.
3. Add the `search` and `fetch` tools from the `wiseway-docs` MCP server.
4. Paste the citing system prompt (the full text is in `librechat.yaml` as a
   comment above `modelSpecs`).
5. Save, copy the agent id (e.g. `agent_xxxxxxxx`), paste it into
   `modelSpecs.list[0].preset.agent_id` in `librechat.yaml`, and restart
   LibreChat (`docker compose restart librechat`).

---

## Resetting

```bash
docker compose down            # stop, keep data
docker compose down -v         # stop and drop named volumes
rm -rf deploy/data-node        # wipe Mongo data (forces fresh users on next run)
```
