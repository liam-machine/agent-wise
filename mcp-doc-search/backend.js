// Backend selector for the Wiseway MCP doc-search tool.
//
// WISEWAY_DOC_BACKEND = local | graph   (default: local)
//
// Both backends expose the same interface:
//   search(query, limit) -> [{ doc_id, title, source_url, snippet, category }]
//   fetch(doc_id)        -> {  doc_id, title, source_url, body,    category } | null
//
// Neither backend applies role-based filtering — that is done once, in
// server.js, on whatever Hit list the selected backend returns. Swapping the
// backend therefore cannot weaken the security gate.

import * as localBackend from './backends/local-folder.js';
import * as graphBackend from './backends/graph.js';

const selected = (process.env.WISEWAY_DOC_BACKEND || 'local').toLowerCase().trim();

let backend;
if (selected === 'graph') {
  backend = graphBackend;
} else {
  backend = localBackend;
}

export const BACKEND_NAME = selected === 'graph' ? 'graph' : 'local';

export async function search(query, limit) {
  return backend.search(query, limit);
}

export async function fetch(doc_id) {
  return backend.fetch(doc_id);
}

export default { search, fetch, BACKEND_NAME };
