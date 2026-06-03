// Local-folder backend for the Wiseway MCP doc-search tool.
//
// Reads markdown documents from SAMPLE_DOCS_DIR (default /app/sample-docs),
// parses YAML front-matter with gray-matter, and builds a BM25 index over
// title + body with MiniSearch. Implements the shared backend interface:
//
//   search(query, limit) -> [{ doc_id, title, source_url, snippet, category }]
//   fetch(doc_id)        -> {  doc_id, title, source_url, body,    category }
//
// doc_id is the markdown filename without its extension.
//
// NOTE: this backend does NOT apply role filtering. Role-based access control
// is enforced in server.js AFTER the backend returns, so the security gate is
// in exactly one place regardless of which backend is selected.

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import MiniSearch from 'minisearch';

const SAMPLE_DOCS_DIR = process.env.SAMPLE_DOCS_DIR || '/app/sample-docs';

const VALID_CATEGORIES = new Set(['hr', 'sop', 'safety', 'payroll']);

// In-memory document store: doc_id -> full document record.
const docs = new Map();

let miniSearch = null;

/**
 * Recursively collect every .md / .markdown file under a directory.
 */
function collectMarkdownFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        component: 'local-folder',
        msg: 'cannot read sample-docs dir',
        dir,
        error: String(err && err.message ? err.message : err),
      }),
    );
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdownFiles(full));
    } else if (/\.(md|markdown)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Build a short snippet from body text.
 */
function makeSnippet(body, maxLen = 240) {
  const flat = String(body || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= maxLen) return flat;
  return flat.slice(0, maxLen).trimEnd() + '…';
}

/**
 * Load (or reload) all documents and rebuild the BM25 index.
 * Called once at module load; idempotent.
 */
function loadCorpus() {
  docs.clear();

  const files = collectMarkdownFiles(SAMPLE_DOCS_DIR);
  const records = [];

  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const parsed = matter(raw);
    const fm = parsed.data || {};
    const body = parsed.content || '';

    const docId = path.basename(file).replace(/\.(md|markdown)$/i, '');
    const title = String(fm.title || docId);
    let category = String(fm.category || '').toLowerCase().trim();

    if (!VALID_CATEGORIES.has(category)) {
      // Unknown / missing category — keep the doc but mark it so the role
      // gate in server.js can treat it conservatively. We surface it as-is;
      // because no role allows an unknown category, it will be filtered out.
      console.error(
        JSON.stringify({
          level: 'warn',
          component: 'local-folder',
          msg: 'document has missing/invalid category',
          file,
          category: fm.category ?? null,
        }),
      );
    }

    const sourceUrl = String(fm.source_url || '');

    const record = {
      doc_id: docId,
      title,
      category,
      source_url: sourceUrl,
      body,
      snippet: makeSnippet(body),
    };

    docs.set(docId, record);
    records.push({
      id: docId,
      title,
      body,
    });
  }

  miniSearch = new MiniSearch({
    fields: ['title', 'body'],
    storeFields: ['title'],
    searchOptions: {
      boost: { title: 2 },
      prefix: true,
      fuzzy: 0.2,
      combineWith: 'OR',
    },
  });
  miniSearch.addAll(records);

  console.error(
    JSON.stringify({
      level: 'info',
      component: 'local-folder',
      msg: 'corpus loaded',
      dir: SAMPLE_DOCS_DIR,
      documents: docs.size,
    }),
  );
}

loadCorpus();

/**
 * BM25 search over title + body.
 * Returns the Hit shape WITHOUT any role filtering (that happens upstream).
 */
export async function search(query, limit = 8) {
  if (!miniSearch) return [];
  const q = String(query || '').trim();
  if (!q) return [];

  const hits = miniSearch.search(q).slice(0, Math.max(1, limit));

  return hits
    .map((hit) => {
      const doc = docs.get(hit.id);
      if (!doc) return null;
      return {
        doc_id: doc.doc_id,
        title: doc.title,
        source_url: doc.source_url,
        snippet: doc.snippet,
        category: doc.category,
      };
    })
    .filter(Boolean);
}

/**
 * Resolve the id a model passed to fetch against our doc store. Models often
 * don't echo the exact doc_id: they append a file extension (".docx"), or pass
 * the whole source_url. Be lenient so a correct intent isn't lost to formatting.
 * This does NOT weaken the role gate — server.js still re-checks doc.category.
 */
function resolveDoc(idOrUrl) {
  const raw = String(idOrUrl || '').trim();
  if (!raw) return null;
  const stripExt = (s) => s.replace(/\.(md|markdown|docx?|pdf|txt|html?)$/i, '');

  // 1. exact doc_id
  if (docs.has(raw)) return docs.get(raw);
  // 2. doc_id with a trailing file extension (e.g. "forklift-operation-sop.docx")
  if (docs.has(stripExt(raw))) return docs.get(stripExt(raw));
  // 3. a full URL or path — use the last segment, url-decoded, extension stripped
  let tail = raw.split(/[\\/]/).pop();
  try { tail = decodeURIComponent(tail); } catch { /* leave as-is */ }
  if (docs.has(stripExt(tail))) return docs.get(stripExt(tail));
  // 4. last resort: a hit whose source_url matches what was passed
  for (const d of docs.values()) {
    if (d.source_url && (d.source_url === raw || d.source_url === tail)) return d;
  }
  return null;
}

/**
 * Fetch a single document by id (or source_url / id-with-extension). Returns
 * null if unknown.
 */
export async function fetch(doc_id) {
  const doc = resolveDoc(doc_id);
  if (!doc) return null;
  return {
    doc_id: doc.doc_id,
    title: doc.title,
    source_url: doc.source_url,
    body: doc.body,
    category: doc.category,
  };
}

export default { search, fetch };
