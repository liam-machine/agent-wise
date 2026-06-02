// Microsoft Graph APP-ONLY backend for the Wiseway MCP doc-search tool.
//
// Production path: searches a SharePoint document library via Microsoft Graph
// using an app-only (client-credentials) token — the Entra "machine login".
// Same interface as the local-folder backend:
//
//   search(query, limit) -> [{ doc_id, title, source_url, snippet, category }]
//   fetch(doc_id)        -> {  doc_id, title, source_url, body,    category }
//
// Role filtering does NOT happen here — the role gate lives in server.js and
// runs on the Hit list this backend returns.
//
// ---------------------------------------------------------------------------
// WHY LIST+EXTRACT INSTEAD OF Graph search(q=):
//   The Graph per-drive `/root/search(q=)` endpoint returns 500 generalException
//   for app-only Sites.Selected access on this (freshly provisioned) site — a
//   known limitation. Listing + downloading works fine, so we enumerate files
//   under a root folder, extract their text (.docx via mammoth; .txt/.md/.csv
//   as plain text), cache it, and rank locally. This also means we can answer
//   from the *contents* of Word documents, which Graph's /content returns as a
//   binary zip (not text).
//
// ENTRA / SHAREPOINT PREREQUISITES (one-time, done by a tenant admin):
//   1. App registration with a client secret -> TENANT_ID, GRAPH_CLIENT_ID,
//      GRAPH_CLIENT_SECRET.
//   2. Microsoft Graph *application* permission `Sites.Selected` + admin consent.
//   3. Grant the app `read` on the target site only:
//        POST /sites/{site-id}/permissions
//        { "roles": ["read"], "grantedToIdentities":[{ "application":
//          { "id": "<GRAPH_CLIENT_ID>", "displayName": "wiseway-doc-search" } }] }
//   4. SHAREPOINT_SITE_PATH (default "sites/YourHRSite"),
//      SHAREPOINT_ROOT_FOLDER (default "Wiseway-Demo") scope the indexed subtree.
// ---------------------------------------------------------------------------

import mammoth from 'mammoth';

const TENANT_ID = process.env.TENANT_ID || '';
const GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || '';
const GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || '';
const SHAREPOINT_SITE_PATH = process.env.SHAREPOINT_SITE_PATH || 'sites/YourHRSite';
const SHAREPOINT_DRIVE_ID = process.env.SHAREPOINT_DRIVE_ID || '';
const SHAREPOINT_HOSTNAME = process.env.SHAREPOINT_HOSTNAME || 'contoso.sharepoint.com';
const SHAREPOINT_ROOT_FOLDER = (process.env.SHAREPOINT_ROOT_FOLDER || 'Wiseway-Demo').replace(/^\/+|\/+$/g, '');
const INDEX_TTL_MS = Number(process.env.GRAPH_INDEX_TTL_MS || 5 * 60 * 1000);

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

// --- site + drive resolution (cached) --------------------------------------
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

/**
 * Derive a document category from a driveItem's parent folder path.
 * Defaults to "hr" if nothing recognizable is present.
 */
function deriveCategory(item) {
  const parentPath = (item.parentReference && item.parentReference.path) || '';
  const segments = parentPath.split('/').map((s) => s.toLowerCase()).filter(Boolean);
  for (const seg of segments) {
    if (seg.includes('payroll')) return 'payroll';
    if (seg.includes('safety') || seg.includes('whs')) return 'safety';
    if (seg.includes('sop') || seg.includes('procedure')) return 'sop';
    if (seg.includes('hr') || seg.includes('human')) return 'hr';
  }
  return 'hr';
}

// --- listing + text extraction ---------------------------------------------

/** Recursively list files under the SHAREPOINT_ROOT_FOLDER subtree. */
async function listFiles(token, driveId) {
  const files = [];
  async function walk(relPath) {
    const sel = '$select=id,name,file,folder,webUrl,parentReference&$top=200';
    const url = relPath
      ? `/drives/${driveId}/root:/${relPath.split('/').map(encodeURIComponent).join('/')}:/children?${sel}`
      : `/drives/${driveId}/root/children?${sel}`;
    let page = await graphGet(url, token);
    while (true) {
      for (const it of page.value || []) {
        if (it.folder) {
          await walk(relPath ? `${relPath}/${it.name}` : it.name);
        } else if (it.file) {
          files.push(it);
        }
      }
      if (!page['@odata.nextLink']) break;
      page = await graphGet(page['@odata.nextLink'], token);
    }
  }
  await walk(SHAREPOINT_ROOT_FOLDER);
  return files;
}

/** Download a driveItem and extract plain text (docx via mammoth). */
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
  // Other types (xlsx, pdf, images): index by filename only.
  return '';
}

// --- in-memory index (cached) ----------------------------------------------
let indexCache = null;
let indexCachedAt = 0;
let indexBuilding = null;

async function getIndexed(token, driveId) {
  const now = Date.now();
  if (indexCache && now - indexCachedAt < INDEX_TTL_MS) return indexCache;
  if (indexBuilding) return indexBuilding;
  indexBuilding = (async () => {
    const files = await listFiles(token, driveId);
    const indexed = [];
    for (const f of files) {
      const text = await extractText(token, driveId, f);
      indexed.push({
        doc_id: f.id,
        title: f.name,
        source_url: f.webUrl || '',
        text,
        category: deriveCategory(f),
      });
    }
    indexCache = indexed;
    indexCachedAt = Date.now();
    indexBuilding = null;
    return indexed;
  })();
  return indexBuilding;
}

function snippetAround(text, terms, maxLen = 280) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return flat.slice(0, maxLen) + (flat.length > maxLen ? '…' : '');
  const start = Math.max(0, at - 80);
  const end = Math.min(flat.length, start + maxLen);
  return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '');
}

/** List-and-rank search over the indexed SharePoint subtree. */
export async function search(query, limit = 8) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const token = await getAppToken();
  const driveId = await resolveDriveId(token);
  const docs = await getIndexed(token, driveId);
  const terms = q.split(/\s+/).filter((t) => t.length > 1);

  const scored = docs
    .map((d) => {
      const title = d.title.toLowerCase();
      const hay = `${title} ${d.text.toLowerCase()}`;
      let score = 0;
      for (const t of terms) {
        const occurrences = hay.split(t).length - 1;
        score += occurrences;
        if (title.includes(t)) score += 5; // filename matches weigh heavily
      }
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));

  return scored.map(({ d }) => ({
    doc_id: d.doc_id,
    title: d.title,
    source_url: d.source_url,
    snippet: snippetAround(d.text, terms) || d.title,
    category: d.category,
  }));
}

/** Fetch one document's full extracted text by id. */
export async function fetch_(doc_id) {
  const token = await getAppToken();
  const driveId = await resolveDriveId(token);
  const docs = await getIndexed(token, driveId);
  const hit = docs.find((x) => x.doc_id === doc_id);
  if (hit) {
    return {
      doc_id: hit.doc_id,
      title: hit.title,
      source_url: hit.source_url,
      body: hit.text || '(no extractable text content)',
      category: hit.category,
    };
  }
  // Fallback: fetch metadata + extract directly if not in the cached index.
  const meta = await graphGet(`/drives/${driveId}/items/${encodeURIComponent(doc_id)}`, token);
  const body = await extractText(token, driveId, meta);
  return {
    doc_id: meta.id,
    title: meta.name || meta.id,
    source_url: meta.webUrl || '',
    body: body || '(no extractable text content)',
    category: deriveCategory(meta),
  };
}

export { fetch_ as fetch };
export default { search, fetch: fetch_ };
