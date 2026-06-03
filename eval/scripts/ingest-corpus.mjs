#!/usr/bin/env node
/**
 * Turn the build-workflow result into on-disk artifacts:
 *   - sample-docs/<file>.md     — each SOP, with YAML front-matter (title/category/source_url)
 *   - eval/questions/questions.json — the 30 verified gold questions
 *   - eval/build/workflow-result.json — provenance copy of the raw result
 *
 * Usage:  node eval/scripts/ingest-corpus.mjs <path-to-workflow-output.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EVAL = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(EVAL, '..');
const src = process.argv[2];
if (!src) { console.error('usage: ingest-corpus.mjs <workflow-output.json>'); process.exit(1); }

const top = JSON.parse(readFileSync(src, 'utf8'));
const result = top.result || top;            // workflow return is under .result
const { corpus = [], questions = [], mix_summary = '', stats = {} } = result;

// Original source filenames -> stable SharePoint-style source_url (demo placeholder)
const ORIG = {
  'abf-77g': 'ABF 77G-General training material_v3.pdf',
  'depot-warehouse': 'Depot_Warehouse Operations SOP_v3.docx',
  'cl-tns': 'Generating CL and TNs_v3.docx',
  'security': 'Security Response SOP_v2.docx',
  'visitor': 'Visitor SOP_v4 - Perth.docx',
};
const SP = 'https://contoso.sharepoint.com/sites/WisewayDepot/Shared%20Documents/SOP/';
const srcUrl = (key, filename) => SP + encodeURIComponent(ORIG[key] || filename);

// Undo the HTML entity escaping the authoring agents applied to markdown.
const unescapeHtml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

mkdirSync(join(EVAL, 'build'), { recursive: true });
mkdirSync(join(EVAL, 'questions'), { recursive: true });
writeFileSync(join(EVAL, 'build', 'workflow-result.json'), JSON.stringify(result, null, 2));

const urlByFile = {};
for (const d of corpus) {
  const url = srcUrl(d.key, d.filename);
  urlByFile[d.filename] = url;
  const body = unescapeHtml(d.markdown).trim();
  const fm = `---\ntitle: ${d.title.replace(/\n/g, ' ')}\ncategory: ${d.category}\nsource_url: ${url}\n---\n\n`;
  const out = join(REPO, 'sample-docs', d.filename);
  writeFileSync(out, fm + body + '\n');
  console.log(`corpus  ${d.filename}  [${d.category}]  ${body.length} chars`);
}

// Enrich each question with the resolved source_url(s) for citation grading.
const enriched = questions.map((q) => ({
  ...q,
  source_urls: (q.source_docs || []).map((f) => urlByFile[f]).filter(Boolean),
}));
writeFileSync(join(EVAL, 'questions', 'questions.json'), JSON.stringify(enriched, null, 2));

console.log(`\nquestions: ${enriched.length}  (drafted ${stats.drafted}, survived ${stats.survived})`);
console.log(`mix: ${mix_summary}`);
console.log(`\nwrote eval/questions/questions.json + ${corpus.length} corpus docs to sample-docs/`);
