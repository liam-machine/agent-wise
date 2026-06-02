// Microsoft Graph APP-ONLY backend for the Wiseway MCP doc-search tool.
//
// Production path: searches the granted SharePoint site via the Microsoft
// Search API (`POST /search/query`) using an app-only (client-credentials)
// token — the Entra "machine login". Same interface as the local-folder backend:
//
//   search(query, limit) -> [{ doc_id, title, source_url, snippet, category }]
//   fetch(doc_id)        -> {  doc_id, title, source_url, body,    category }
//
// Role filtering does NOT happen here — the role gate lives in server.js and
// runs on the Hit list this backend returns (it filters on `category`).
//
// ---------------------------------------------------------------------------
// WHY THE MICROSOFT SEARCH API (`/search/query`):
//   It queries SharePoint's own search index across the whole site the app is
//   granted on — so it finds files in ANY folder (no configured root) and
//   matches the *contents* of Word docs, PDFs, etc. that SharePoint already
//   indexed. Two non-obvious requirements:
//     1. With APPLICATION (app-only) permissions you MUST pass a `region`
//        (e.g. "AUS") or it 400s: "Region is required when request with
//        application permission." Valid regions are tenant-specific.
//     2. `Sites.Selected` transparently scopes results to the granted site(s),
//        so no explicit path filter is needed for the security boundary.
//   (The older per-drive `/root/search(q=)` endpoint 500s under app-only
//   Sites.Selected — a different, weaker API. Don't use it.)
//
// ENTRA / SHAREPOINT PREREQUISITES (one-time, tenant admin):
//   1. App registration + client secret -> TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET.
//   2. Graph *application* permission `Sites.Selected` + admin consent.
//   3. Grant the app `read` on the target site (POST /sites/{site-id}/permissions).
//   4. GRAPH_SEARCH_REGION = your tenant's Microsoft Search region (default "AUS").
// ---------------------------------------------------------------------------

import mammoth from 'mammoth';

const TENANT_ID = process.env.TENANT_ID || '';
const GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || '';
const GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || '';
const SHAREPOINT_SITE_PATH = process.env.SHAREPOINT_SITE_PATH || 'sites/YourHRSite';
const SHAREPOINT_DRIVE_ID = process.env.SHAREPOINT_DRIVE_ID || '';
const SHAREPOINT_HOSTNAME = process.env.SHAREPOINT_HOSTNAME || 'contoso.sharepoint.com';
// Microsoft Search requires a region for app-only requests. Set to your tenant's Search region (e.g. AUS, NAM, EUR).
const GRAPH_SEARCH_REGION = (process.env.GRAPH_SEARCH_REGION || 'AUS').trim();

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// --- token cache -----------------------------------------------------------
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAppToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;
  if (!TENANT_ID || !GRAPH_CLIENT_ID || !GRAPH_CLIENT_SECRET) {
    throw new Error('graph backend misconfigured: TENANT_ID, GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET are required');
  }
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(TENANT_ID)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: GRAPH_CLIENT_ID,
    client_secret: GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`graph token request failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  cachedToken = json.access_token;
  tokenExpiresAt = Date.now() + Number(json.expires_in || 3600) * 1000;
  return cachedToken;
}

async function graphGet(pathOrUrl, token) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`graph GET ${url} failed: ${res.status} ${text}`);
  }
  return res.json();
}

// --- site + drive resolution (cached) — used by fetch() --------------------
let cachedDriveId = null;

async function resolveDriveId(token) {
  if (cachedDriveId) return cachedDriveId;
  if (SHAREPOINT_DRIVE_ID) {
    cachedDriveId = SHAREPOINT_DRIVE_ID;
    return cachedDriveId;
  }
  const site = await graphGet(`/sites/${SHAREPOINT_HOSTNAME}:/${SHAREPOINT_SITE_PATH}`, token);
  const drive = await graphGet(`/sites/${site.id}/drive`, token);
  cachedDriveId = drive.id;
  return cachedDriveId;
}

// --- category derivation ---------------------------------------------------
/**
 * Derive a document category from any string that carries the folder path —
 * the SharePoint webUrl (search results) or a parentReference path (item
 * metadata). This is the security-relevant label server.js gates on, so it
 * defaults CLOSED-ish to "hr" (the least-sensitive category) when nothing
 * recognizable is present. Folder naming conventions drive this:
 *   …/Payroll/…  -> payroll   …/Safety|WHS/… -> safety
 *   …/SOP|Procedure/… -> sop   …/HR|Human/…  -> hr
 */
function categoryFromPath(str) {
  const s = String(str || '').toLowerCase();
  if (s.includes('payroll')) return 'payroll';
  if (s.includes('safety') || s.includes('whs')) return 'safety';
  if (s.includes('sop') || s.includes('procedure')) return 'sop';
  if (s.includes('hr') || s.includes('human')) return 'hr';
  return 'hr';
}

/** Strip Microsoft Search hit-highlight markup (<c0>…</c0>, <ddd/>) to plain text. */
function cleanSummary(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- search via the Microsoft Search API -----------------------------------
/**
 * Query SharePoint search across the whole granted site. Returns Hits the same
 * shape the local backend does; server.js then drops any whose category the
 * caller's role may not see.
 */
export async function search(query, limit = 8) {
  const q = String(query || '').trim();
  if (!q) return [];
  const token = await getAppToken();

  const reqBody = {
    requests: [
      {
        entityTypes: ['driveItem'],
        query: { queryString: q },
        region: GRAPH_SEARCH_REGION,
        from: 0,
        // over-fetch: we drop folders/non-files below, then trim to `limit`.
        size: Math.max(limit * 2, 10),
        // `id` is REQUIRED (it's the doc_id / fetch key); without it every hit
        // is dropped. webUrl carries the folder path we derive `category` from.
        fields: ['id', 'name', 'webUrl', 'file', 'folder'],
      },
    ],
  };

  const res = await fetch(`${GRAPH_BASE}/search/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`graph search/query failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  const containers = (data.value && data.value[0] && data.value[0].hitsContainers) || [];
  const hits = containers.flatMap((c) => c.hits || []);

  const out = [];
  for (const h of hits) {
    const r = h.resource || {};
    if (!r.id) continue;
    const name = r.name || '';
    // Skip folders themselves (Search returns e.g. the "…SOP" folder as a hit).
    if (r.folder && !r.file) continue;
    if (!/\.[a-z0-9]{2,6}$/i.test(name)) continue;
    out.push({
      doc_id: r.id,
      title: name,
      // Search returns webUrl as a raw path with literal spaces; encode them
      // (-> %20) or the markdown link breaks at the first space.
      source_url: encodeURI(r.webUrl || ''),
      snippet: cleanSummary(h.summary) || name,
      category: categoryFromPath(r.webUrl || (r.parentReference && r.parentReference.path) || ''),
    });
    if (out.length >= limit) break;
  }
  return out;
}

// --- fetch one document's full text (download + extract) -------------------
async function extractText(token, driveId, item) {
  const name = (item.name || '').toLowerCase();
  const res = await fetch(`${GRAPH_BASE}/drives/${driveId}/items/${item.id}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return '';
  if (name.endsWith('.docx')) {
    try {
      const buf = Buffer.from(await res.arrayBuffer());
      const out = await mammoth.extractRawText({ buffer: buf });
      return (out.value || '').trim();
    } catch {
      return '';
    }
  }
  if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv')) {
    return (await res.text().catch(() => '')).trim();
  }
  // PDF / xlsx / images: SharePoint search already indexed their text and
  // search() returns a usable snippet. Full-body extraction (e.g. a PDF parser)
  // is a follow-up; for now the model answers/cites from the search snippet.
  return '';
}

/** Fetch one document's full extracted text by driveItem id. */
export async function fetch_(doc_id) {
  const token = await getAppToken();
  const driveId = await resolveDriveId(token);
  const meta = await graphGet(`/drives/${driveId}/items/${encodeURIComponent(doc_id)}`, token);
  const body = await extractText(token, driveId, meta);
  return {
    doc_id: meta.id,
    title: meta.name || meta.id,
    source_url: encodeURI(meta.webUrl || ''),
    body: body || '(no extractable text content — open the source link)',
    category: categoryFromPath(meta.webUrl || (meta.parentReference && meta.parentReference.path) || ''),
  };
}

export { fetch_ as fetch };
export default { search, fetch: fetch_ };
