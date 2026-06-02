# Wiseway MCP doc-search — the role-scoped document tool

This is the **security boundary** for document access in the Wiseway Staff
Assistant demo. It is a Model Context Protocol (MCP) server, served over
**Streamable HTTP** by Express on **port 8000** at path **`/mcp`**
(service name `wiseway-doc-search`).

The local model (`qwen2.5:7b` via Ollama) can only see Wiseway documents
through this server, and only the documents its role is allowed to read.

---

## Tool contract

Two tools. **Role is NEVER a tool argument** — the model cannot ask for another
role's documents.

| Tool | Input schema | Returns |
|---|---|---|
| `search` | `{ query: string, top?: number }` | text blocks, one per hit: `"[i] Title — source_url\nsnippet"` |
| `fetch`  | `{ doc_id: string }` | one text block: `"[Title] — source_url\n\n<body>"` |

Citations are returned as plain text the local model is instructed to render as
markdown links `[Title](source_url)`. We do **not** rely on Anthropic
`search_result` auto-citation — the model here is a local Ollama model.

The backend Hit shape (shared by both backends):

```
search(query, limit) -> [{ doc_id, title, source_url, snippet, category }]
fetch(doc_id)        -> {  doc_id, title, source_url, body,    category } | null
```

`doc_id` for the local backend is the markdown filename without its extension.

---

## Security model — header trust, fail-closed

Identity arrives **only** via HTTP headers that LibreChat injects on every MCP
call. The model never supplies any of them.

| Header | Meaning | Source |
|---|---|---|
| `X-Mcp-Key` | shared secret proving the call came from LibreChat | `${WISEWAY_MCP_SHARED_SECRET}` |
| `X-User-Role` | the caller's Wiseway business role | `{{LIBRECHAT_USER_ROLE}}` (Mongo user doc) |
| `X-User-Id` | the caller's id (audit only) | `{{LIBRECHAT_USER_ID}}` |

Enforcement order on every `POST /mcp`:

1. **Caller authentication.** If `X-Mcp-Key !== WISEWAY_MCP_SHARED_SECRET`,
   respond `401` immediately. Only LibreChat holds the secret, so nothing else
   on the Docker network can reach the tools. **Fail closed:** if the env var is
   unset, every request is rejected.
2. **Identity resolution.** `role` and `userId` are read from the trusted
   headers — never from the tool input, never from the model.
3. **Per-request isolation.** The transport runs in **stateless mode**
   (`sessionIdGenerator: undefined`) and a fresh `McpServer` is built per
   request, capturing `role`/`userId` in the tool-handler closures. Role is
   therefore **per-request**, never a module global — concurrent callers with
   different roles cannot bleed into each other.
4. **Server-side category filter (the gate).** `roles.yaml` maps each role to
   its allowed categories. After the backend returns Hits, any hit whose
   `category` is not allowed for the caller's role is **dropped before the
   result leaves the server**. The model never sees a disallowed document — not
   its title, snippet, source URL, or body. `fetch` of a disallowed (or
   nonexistent) `doc_id` returns the same "nothing available" message, so the
   tool does not leak the existence of restricted documents.
5. **Audit.** Every call is logged as one JSON line including `role`,
   `user_id`, the `query`/`doc_id`, and `returned_doc_ids`, with an ISO
   timestamp from the local runtime clock.

Unknown or empty roles fail closed (empty allow-set → can read nothing).

### Role → category map (`roles.yaml`)

```
warehouse: [hr, sop, safety]
driver:    [hr, sop, safety]
office:    [hr, sop]
hr-admin:  [hr, sop, safety, payroll]
```

Document categories in the corpus: `hr`, `sop`, `safety`, `payroll`.
Only `hr-admin` can read `payroll`; only warehouse/driver/hr-admin can read
`safety`.

---

## Backends — local vs graph

Selected by env `WISEWAY_DOC_BACKEND` (default `local`). **The role gate runs
on whatever the backend returns**, so swapping the backend cannot weaken
security.

### `local` (default)

Reads markdown from `SAMPLE_DOCS_DIR` (default `/app/sample-docs`, bind-mounted
from `../sample-docs`). Parses YAML front-matter (`title`, `category`,
`source_url`) with `gray-matter` and builds a BM25 index over title + body with
MiniSearch.

### `graph`

Microsoft Graph **app-only** (client-credentials) against a SharePoint document
library. Acquires a token from
`https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token` with scope
`https://graph.microsoft.com/.default`, resolves the site + default drive, then
searches via **`GET /drives/{drive-id}/root/search(q=)`** (the per-drive
endpoint that respects `Sites.Selected` — we deliberately do **not** use
`/search/query`). Category is derived from the parent folder name (default
`hr`). `fetch` downloads item content text.

Env for graph: `TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`,
`SHAREPOINT_SITE_PATH` (default `sites/YourHRSite`), `SHAREPOINT_DRIVE_ID`
(optional), `SHAREPOINT_HOSTNAME` (default `contoso.sharepoint.com`).

**Entra prerequisites** (one-time, tenant admin): register an app with a
client secret; grant the **application** permission `Sites.Selected` (Graph)
and admin-consent it; then grant *this app* `read` on the target site via
`POST /sites/{site-id}/permissions`. See the header comment in
`backends/graph.js` for the exact payload. The graph backend is
untested-but-correct in this demo build.

### Flipping local → graph

Set in the service's environment (compose / `.env`):

```
WISEWAY_DOC_BACKEND=graph
TENANT_ID=...
GRAPH_CLIENT_ID=...
GRAPH_CLIENT_SECRET=...
SHAREPOINT_SITE_PATH=sites/YourHRSite
```

No code change is needed — `backend.js` reads the env at startup.

---

## Run

In the demo this service is built and run by the top-level `docker-compose.yml`
(service `wiseway-doc-search`, host port `8000`). Standalone:

```bash
npm install
WISEWAY_MCP_SHARED_SECRET=wiseway-mcp-shared-secret \
SAMPLE_DOCS_DIR=../sample-docs \
npm start
# -> POST http://localhost:8000/mcp   (GET http://localhost:8000/health for liveness)
```

`GET /health` returns `{ ok: true, backend }` and requires no secret.

---

## Files

| File | Purpose |
|---|---|
| `server.js` | MCP server + Express; the security gate (header auth, role filter, audit). |
| `backend.js` | Selects local vs graph by `WISEWAY_DOC_BACKEND`. |
| `backends/local-folder.js` | Markdown + BM25 (MiniSearch) backend. |
| `backends/graph.js` | Microsoft Graph app-only SharePoint backend. |
| `roles.yaml` | Role → allowed-categories map (the gate). |
| `package.json` / `Dockerfile` | Build (node:20-slim, EXPOSE 8000). |
