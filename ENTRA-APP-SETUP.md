# Entra App Setup — SharePoint machine identity for doc-search

This document registers the **machine identity** the `mcp-doc-search` service uses
when `WISEWAY_DOC_BACKEND=graph`. It signs in as itself (app-only / client
credentials — no user), and is granted **read access to only the YourHRSite
SharePoint site** using Microsoft Graph **Sites.Selected**. This is the least-
privilege way to let a backend service read one site without giving it tenant-wide
SharePoint access.

> Target site for this demo:
> `https://contoso.sharepoint.com/sites/YourHRSite`
> (`SHAREPOINT_SITE_PATH=sites/YourHRSite`)

## Why a machine account (and not a shared user)

- **No human credentials in a container.** A shared user account would mean storing
  a person's password/MFA-bypass in the service — fragile and a security liability.
  An app registration uses a client secret (or certificate) scoped to exactly the
  Graph permissions you grant, and nothing else.
- **Least privilege via `Sites.Selected`.** Plain `Sites.Read.All` would let the app
  read **every** SharePoint site in the tenant. `Sites.Selected` grants **zero**
  sites by default; you then explicitly grant read on **only** YourHRSite. The
  blast radius is one site.
- **Per-user trimming is impossible app-only.** Because the app reads as itself, not
  as the signed-in staff member, Graph cannot trim results to "what this user may
  see." That is **exactly why role gating lives in the tool**: `mcp-doc-search`
  receives the user's business role in `X-User-Role` and filters categories against
  `roles.yaml` server-side before returning anything to the model.

## Step 1 — Create the App registration

1. Go to <https://entra.microsoft.com> → **Identity → Applications → App
   registrations → New registration**.
2. **Name:** `wiseway-doc-search` (or similar).
3. **Supported account types:** *Accounts in this organizational directory only*
   (single tenant).
4. Leave **Redirect URI** blank (this is a daemon / app-only client — no interactive
   sign-in).
5. **Register.**
6. From the app **Overview**, copy:
   - **Application (client) ID** → this becomes `GRAPH_CLIENT_ID`
   - **Directory (tenant) ID** → this becomes `TENANT_ID`

## Step 2 — Add the Graph **application** permission `Sites.Selected`

1. In the app → **API permissions → Add a permission → Microsoft Graph**.
2. Choose **Application permissions** (NOT delegated — this is app-only).
3. Search for and select **`Sites.Selected`**.
4. **Add permissions.**

## Step 3 — Grant admin consent

1. Still on **API permissions**, click **Grant admin consent for &lt;tenant&gt;**.
2. Confirm. `Sites.Selected` should now show **Granted** with a green check.

> Admin consent here only consents to the *capability* "this app may access
> sites it has been explicitly granted." It grants **no** sites yet — that's Step 5.

## Step 4 — Create a client secret

1. In the app → **Certificates &amp; secrets → Client secrets → New client secret**.
2. Give it a description and a sensible expiry (e.g. 6 months for a demo).
3. **Add**, then **immediately copy the secret _Value_** (not the Secret ID — the
   Value is shown only once) → this becomes `GRAPH_CLIENT_SECRET`.

> **Store it safely.** Put it only in the gitignored `deploy/.env` (never in
> `.env.wiseway.example`, never committed). For anything beyond a demo, prefer a
> certificate or a secret vault over a client secret.

## Step 5 — Grant the app **read** on ONLY the YourHRSite site

`Sites.Selected` grants nothing until you explicitly add a site permission. **The
Entra/Azure portal UI cannot do per-site grants** — you must call Graph directly,
via **Graph Explorer** (signed in as an admin) or **PowerShell**
(`New-MgSitePermission`).

### 5a. Resolve the site ID

`GET` the site by its path to get its `id`:

```http
GET https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/YourHRSite
```

The response `id` looks like
`contoso.sharepoint.com,<site-guid>,<web-guid>` — use that whole string as
`{site-id}` below.

### 5b. Grant the app read on that site

```http
POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
Content-Type: application/json

{
  "roles": ["read"],
  "grantedToIdentities": [
    {
      "application": {
        "id": "<GRAPH_CLIENT_ID>",
        "displayName": "wiseway-doc-search"
      }
    }
  ]
}
```

A `201 Created` with a permission `id` and `"roles": ["read"]` means the app can now
read **this site and nothing else**.

### PowerShell equivalent

```powershell
Connect-MgGraph -Scopes "Sites.FullControl.All"

$site = Get-MgSite -Search "YourHRSite"   # or Get-MgSite by path

New-MgSitePermission -SiteId $site.Id -BodyParameter @{
  roles = @("read")
  grantedToIdentities = @(@{
    application = @{ id = "<GRAPH_CLIENT_ID>"; displayName = "wiseway-doc-search" }
  })
}
```

> `New-MgSitePermission` requires an admin with a site-permission-management scope
> such as `Sites.FullControl.All` for the **grant** itself; the **app** still only
> ends up with `read` on the one site.

## Step 6 — Set the environment variables

Put these in the gitignored `deploy/.env` (copied from `deploy/.env.wiseway.example`)
and flip the backend to `graph`:

```bash
WISEWAY_DOC_BACKEND=graph
TENANT_ID=<Directory (tenant) ID from Step 1>
GRAPH_CLIENT_ID=<Application (client) ID from Step 1>
GRAPH_CLIENT_SECRET=<secret Value from Step 4>
SHAREPOINT_SITE_PATH=sites/YourHRSite
# SHAREPOINT_DRIVE_ID=<optional — pin a specific document library drive id>
```

Then recreate the service so it reads the new env:

```bash
docker compose up -d --force-recreate wiseway-doc-search
```

## How the graph backend uses these

The `graph` backend authenticates app-only (client credentials) with
`TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET`, resolves the site from
`SHAREPOINT_SITE_PATH` and its document-library **drive**, then **lists,
downloads, extracts, and ranks locally** — it does **not** call Graph's
`search(q=)` at all.

Why: the per-drive `GET /drives/{drive-id}/root/search(q='…')` endpoint returns
`500 generalException` under app-only `Sites.Selected` access (a known Graph
limitation on freshly provisioned sites). So instead, the backend:

1. **Lists** every file under `SHAREPOINT_ROOT_FOLDER` by walking the drive tree
   (`GET /drives/{drive-id}/root:/{folder}:/children`, following `@odata.nextLink`).
2. **Downloads** each file's bytes (`GET /drives/{drive-id}/items/{item-id}/content`).
3. **Extracts** plain text — `.docx` via the `mammoth` library, `.txt`/`.md`/`.csv`
   as plain text — caches it in an in-memory index (TTL `GRAPH_INDEX_TTL_MS`,
   default 5 min), and **ranks locally** (term-frequency with a filename-match
   boost). Extracting text also means the tool can answer from the *contents* of
   Word documents, which Graph's `/content` returns as a binary zip rather than text.

Listing + downloading both work fine under `Sites.Selected`; only `search(q=)`
fails — which is why this backend avoids it. (The tenant-wide `/search/query`
endpoint is also unused, as it assumes broad search permissions the app does not
have.) Returned `driveItem`s are mapped to the same hit shape as the local backend
(`doc_id`, `title`, `source_url`, `snippet`, `category`), with `category` derived
from the parent folder name (default `hr`), and then run through the **same role
filter** before anything reaches the model.

> Source of truth: `mcp-doc-search/backends/graph.js` (see the "WHY LIST+EXTRACT
> INSTEAD OF Graph search(q=)" header comment and the `listFiles` / `extractText`
> / `getIndexed` / `search` functions).

## Security recap

- App-only machine identity — no human credentials baked into the service.
- `Sites.Selected` + a single per-site `read` grant = least privilege; the app can
  read YourHRSite and nothing else in the tenant.
- App-only access can't do per-user trimming, so **role-based access control is
  enforced in the tool** (`mcp-doc-search` + `roles.yaml`), not by SharePoint.
- The client secret lives only in the gitignored `deploy/.env`; rotate it on its
  expiry and prefer a certificate/vault outside the demo.
