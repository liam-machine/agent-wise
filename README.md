# agent-wise — Wiseway Staff Assistant (PoC)

A Wiseway-branded AI assistant that lets blue-collar staff ask plain-English
**HR and SOP questions** and get **cited answers, scoped to their role**. A
warehouse worker and an HR admin can ask the exact same question and get
different answers — because the assistant only ever reads the documents the
person's role is allowed to see, and it links the source policy for every fact.

This repository is a **proof-of-concept being handed over to the Wiseway
integration team**. It runs end-to-end on one laptop out of the box — bundled
sample documents, a simple User/Admin demo login, and a local LLM — so you can see
the whole workflow working before wiring it into Wiseway's real systems. Each
of those three stand-ins is a clearly marked seam that you replace at
integration time.

> **Integration team: start here, then read [`docs/INTEGRATION.md`](docs/INTEGRATION.md).**
> That guide walks every touch point you need to build (SSO, hosting,
> SharePoint, the model, roles, citations, audit, secrets, security review).

---

## For non-technical readers (the 30-second version)

Staff log in on their phone, type a question, and get an answer drawn **only**
from the company documents their job is allowed to see — with a link back to the
source every time. A warehouse worker asking "what are the pay classifications?"
gets *nothing*, because payroll isn't theirs to read; an HR admin asking the same
question gets the answer. The model never even sees documents the person can't
access — that filtering happens in a separate tool, not in the AI. The result is
an assistant that's helpful, honest about what it doesn't know, and can't leak
sensitive HR or payroll information across roles.

This is a demonstration build, not a production system. The full plan for making
it production-ready is in [`docs/INTEGRATION.md`](docs/INTEGRATION.md).

---

## What you get

- **A working chat assistant** — LibreChat (chat UI + agent runtime) pinned to a
  single "Wiseway HR & SOP Assistant" agent backed by a local LLM.
- **Role-scoped, cited answers** — the assistant answers only from documents the
  user's role allows, and cites each fact as a clickable source link.
- **A security gate that lives in the tool, not the model** — document access is
  filtered server-side in the doc-search tool before anything reaches the LLM, so
  the model cannot reveal what it never sees.
- **A simple demo login** — a User/Admin password box (not real auth) so you can
  exercise the whole sign-in → role → answer flow with no external dependencies.
- **Swappable document backend** — runs against bundled sample Markdown docs by
  default; flip one environment variable to read a real SharePoint site via a
  Microsoft Graph "machine login."
- **Wiseway branding** — logo, favicons, welcome text, and the in-chat assistant
  icon already wired in.

---

## Run it locally

Prerequisites: **Docker Desktop** (running) and **Ollama** installed *natively* on
the host (it uses the GPU, so it does **not** run in Docker — get it from
<https://ollama.com>). Allow ~16 GB free RAM for the model plus the stack.

Five steps (these mirror the header of [`docker-compose.yml`](docker-compose.yml)):

```bash
# 1. Create your env file, then fill in the REPLACE_ME crypto secrets.
#    (Leave the Graph creds blank for the local-docs demo.)
cp deploy/.env.example deploy/.env

# 2. Make host.docker.internal resolve in your browser too (one-time, for Ollama).
echo "127.0.0.1 host.docker.internal" | sudo tee -a /etc/hosts

# 3. Start the local model and pull the 7B model it uses.
ollama serve            # often already running after install
ollama pull qwen2.5:7b

# 4. Bring up the stack.
docker compose up -d

# 5. Create the two demo logins (User / Admin).
./deploy/create-accounts.sh
```

Then open **<http://localhost:3080>** — a Wiseway **User / Admin password box**
appears (the demo login gate; see [Demo logins](#demo-logins)).

One more one-time step makes the demo fully functional:

- **Create the agent once, then share it.** Sign in as **Admin**, build the
  "Wiseway HR & SOP Assistant" in LibreChat's **Agent Builder** (it can't be
  declared in YAML), pin it as the default, and **share it publicly** (Agent
  Builder → Share → anyone-can-view) so the **User** account can use it too. The
  recipe — model, MCP tools, system prompt — is in the comments of
  [`deploy/librechat.yaml`](deploy/librechat.yaml) under `modelSpecs`.

> **Asset edits need a recreate.** If you change the login box or branding under
> `deploy/wiseway-assets/`, run `docker compose up -d --force-recreate librechat`
> (Docker's macOS bind mount pins the file inode) and hard-reload the browser
> (LibreChat is a PWA — its service worker caches the assets).

### Demo logins

The login box asks you to pick **User** or **Admin** and type a password. The two
accounts are created by [`deploy/create-accounts.sh`](deploy/create-accounts.sh).

| Choose    | Password | LibreChat role | UI      | Reads                                         |
|-----------|----------|----------------|---------|-----------------------------------------------|
| **User**  | `user`   | `warehouse`    | minimal | HR + SOP + Safety                             |
| **Admin** | `admin`  | `ADMIN`        | full    | everything incl. **payroll**; manages agents  |

> **Demo only — not real security.** Anyone with the URL and "admin" gets full
> access. Replace with Wiseway SSO before any real data (see
> [`docs/INTEGRATION.md`](docs/INTEGRATION.md) §1).

What each role may read (the gate, defined in
[`mcp-doc-search/roles.yaml`](mcp-doc-search/roles.yaml)):

| Role        | Allowed document categories               |
|-------------|-------------------------------------------|
| `warehouse` | hr, sop, safety                           |
| `driver`    | hr, sop, safety                           |
| `office`    | hr, sop                                   |
| `hr-admin`  | hr, sop, safety, **payroll**              |
| `admin`     | hr, sop, safety, **payroll** (everything) |

**The moment that lands the point:** sign in as **User** (warehouse) and ask *"what
are the pay classifications?"* — the assistant finds nothing it's allowed to show
and says so plainly. Sign in as **Admin** and ask the same thing — now it returns
the payroll document, cited. The warehouse user was never told a payroll doc
exists; it was filtered out server-side before the model saw it.

---

## How it works

The chain, login to cited answer:

1. **Staff log in** through the demo login gate (a User/Admin password box locally;
   Wiseway SSO after integration).
2. **LibreChat receives the identity and the role**, and pins the user to the
   "Wiseway HR & SOP Assistant" agent running on the local LLM.
3. **Staff ask a question.** The agent calls the **doc-search tool over MCP**,
   with the user's role injected as a trusted HTTP header (`X-User-Role`) — never
   as a model-supplied argument.
4. **The tool reads the documents and filters by role first.** It checks
   [`roles.yaml`](mcp-doc-search/roles.yaml) (role → allowed categories) and
   **drops every disallowed document before returning anything** to the model. A
   shared-secret header (`X-Mcp-Key`) ensures only LibreChat can call the tool.
5. **The model answers from what's left**, citing each fact as a Markdown link
   `[Title](source_url)` back to the source policy.

**Role-based access is the security spine, and it is enforced in the tool, never
in the model.** The model only ever sees documents the user's role permits, so it
cannot reveal anything outside that role.

Two seams worth knowing up front:

- **Two role concepts.** LibreChat's own `USER` role governs app features;
  Wiseway's *business* role (warehouse/driver/office/hr-admin) governs document
  access and is what reaches the tool. In the demo, `deploy/create-accounts.sh` sets the
  business role on each user. The integration nuance — and why the business roles
  must also exist in LibreChat's Mongo `roles` collection — is in
  [`docs/INTEGRATION.md §1`](docs/INTEGRATION.md).
- **Local vs. SharePoint.** The default `local` backend runs BM25 search over the
  bundled `sample-docs/`. The `graph` backend reads a real SharePoint site via a
  Microsoft Graph **app-only "machine login"** — one Entra service identity granted
  `Sites.Selected` read on a single site, reading on staff's behalf (staff have no
  SharePoint accounts). Set `WISEWAY_DOC_BACKEND=graph` and provide the Graph
  creds to switch. See [`ENTRA-APP-SETUP.md`](ENTRA-APP-SETUP.md) and
  [`docs/INTEGRATION.md §3`](docs/INTEGRATION.md). The role gate is identical for
  both backends.

---

## The stack

Three containers plus the host LLM:

| Service              | Port   | What it is                                                                 |
|----------------------|--------|---------------------------------------------------------------------------|
| `librechat`          | `3080` | Chat UI + agent API (forked LibreChat). The demo login gate is a CSS/JS overlay on its client. |
| `mongodb`            | —      | LibreChat's datastore (users, roles, conversations).                      |
| `wiseway-doc-search` | `8000` | Role-scoped document-search tool, exposed over MCP — **the access gate**. |

The LLM (**Ollama**, model `qwen2.5:7b`) runs **natively on the host**, not in
Docker, reached from the containers at `http://host.docker.internal:11434/v1/` and
configured in [`deploy/librechat.yaml`](deploy/librechat.yaml) under
`endpoints.custom`.

---

## Repo map

| Path                   | What lives there                                                                       |
|------------------------|----------------------------------------------------------------------------------------|
| `docker-compose.yml`   | The local-dev stack — wires the four services together. Its header is the quickstart.   |
| `README.md`            | This file — overview, quickstart, repo map.                                            |
| `CLAUDE.md`            | Guidance for Claude Code working in this repo.                                          |
| `ENTRA-APP-SETUP.md`   | How to register the Entra app and grant `Sites.Selected` read on one SharePoint site.   |
| `docs/`                | Handover docs — **`INTEGRATION.md`** (the build guide) and `ARCHITECTURE.md`.           |
| `deploy/`              | Deployment glue: `librechat.yaml`, `.env.example`, brand assets, the demo login gate (`wiseway-assets/wiseway-role-ui.*`), `create-accounts.sh`. |
| `mcp-doc-search/`      | The role-scoped doc-search MCP tool: `server.js` (the gate), backends, `roles.yaml`.    |
| `sample-docs/`         | Six sample HR/SOP/safety/payroll Markdown docs used by the `local` backend.             |

---

## A note on status

**This is a proof-of-concept for handover, not a production system.** The mock
identity provider, the self-signed certificates, and the local model are
deliberate stand-ins for the demo. They must be replaced — and the integrated
system security-reviewed — before any real staff or real documents are involved.
The complete plan, including the security checklist, is in
[`docs/INTEGRATION.md`](docs/INTEGRATION.md) (see its security section).
