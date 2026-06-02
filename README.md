# agent-wise — Wiseway Staff Assistant (PoC)

A Wiseway-branded AI assistant that lets blue-collar staff ask plain-English
**HR and SOP questions** and get **cited answers, scoped to their role**. A
warehouse worker and an HR admin can ask the exact same question and get
different answers — because the assistant only ever reads the documents the
person's role is allowed to see, and it links the source policy for every fact.

This repository is a **proof-of-concept being handed over to the Wiseway
integration team**. It runs end-to-end on one laptop out of the box — bundled
sample documents, a mock phone-and-PIN login, and a local LLM — so you can see
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
- **A mock phone + PIN login** — a throwaway OIDC identity provider so you can
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

# 2. Generate the mock IdP's self-signed TLS cert.
./mock-idp/gen-certs.sh

# 3. Make host.docker.internal resolve in your browser too (one-time).
echo "127.0.0.1 host.docker.internal" | sudo tee -a /etc/hosts

# 4. Start the local model and pull the 7B model it uses.
ollama serve            # often already running after install
ollama pull qwen2.5:7b

# 5. Bring up the stack.
docker compose up -d
```

Then open **<http://localhost:3080>**. With auto-redirect on, you land straight on
the Wiseway phone-and-PIN login.

Two more one-time steps make the demo fully functional:

- **Seed the business roles.** After each demo user has logged in once (so their
  Mongo user document exists), run `deploy/seed-roles.sh`, then log out and back
  in. This writes the business role (warehouse / driver / office / hr-admin) onto
  each user — the value that flows to the doc-search tool and decides what they can
  read. (LibreChat lands every OIDC user as the generic `USER` role; the business
  role is a separate string the tool reads — see [How it works](#how-it-works).)
- **Create the agent once.** The "Wiseway HR & SOP Assistant" agent is built once
  in LibreChat's **Agent Builder** UI (it can't be declared in YAML), then pinned
  as the default. The full recipe — model, MCP tools, system prompt — is in the
  comments of [`deploy/librechat.yaml`](deploy/librechat.yaml) under `modelSpecs`.

### Demo logins

Log in with the **mobile number** and **PIN**. These four identities are the
single source of truth in [`mock-idp/staff.js`](mock-idp/staff.js) and are mirrored
by [`deploy/seed-roles.sh`](deploy/seed-roles.sh).

| Mobile       | PIN  | Role        | Name                   |
|--------------|------|-------------|------------------------|
| `0412345678` | 1234 | `warehouse` | Sam Tran (Warehouse)   |
| `0423456789` | 2345 | `driver`    | Dee Okafor (Driver)    |
| `0434567890` | 3456 | `office`    | Olivia Park (Office)   |
| `0445678901` | 4567 | `hr-admin`  | Hannah Reed (HR Admin) |

What each role may read (the gate, defined in
[`mcp-doc-search/roles.yaml`](mcp-doc-search/roles.yaml)):

| Role        | Allowed document categories          |
|-------------|--------------------------------------|
| `warehouse` | hr, sop, safety                      |
| `driver`    | hr, sop, safety                      |
| `office`    | hr, sop                              |
| `hr-admin`  | hr, sop, safety, **payroll**         |

**The moment that lands the point:** log in as Sam (warehouse) and ask *"what are
the pay classifications?"* — the assistant finds nothing it's allowed to show and
says so plainly. Log in as Hannah (hr-admin) and ask the same thing — now it
returns the payroll document, cited. The warehouse user was never told a payroll
doc exists; it was filtered out server-side before the model saw it.

---

## How it works

The chain, login to cited answer:

1. **Staff log in** through the OIDC identity provider (mock phone+PIN locally;
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
  access and is what reaches the tool. In the demo, `deploy/seed-roles.sh` sets the
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

Four containers plus the host LLM:

| Service              | Port   | What it is                                                                 |
|----------------------|--------|---------------------------------------------------------------------------|
| `librechat`          | `3080` | Chat UI + agent API (forked LibreChat).                                    |
| `mongodb`            | —      | LibreChat's datastore (users, roles, conversations).                      |
| `wiseway-idp`        | `9000` | **Mock** OIDC phone+PIN provider — *local dev only*, replaced at integration. |
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
| `deploy/`              | Deployment glue: `librechat.yaml`, `.env.example`, brand assets, `seed-roles.sh`.       |
| `mock-idp/`            | The mock phone+PIN OIDC provider (Node, `oidc-provider`). **Local dev only.**           |
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
