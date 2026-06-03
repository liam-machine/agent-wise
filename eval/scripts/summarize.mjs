#!/usr/bin/env node
/**
 * Summarise a promptfoo results file into the tables that actually drive a
 * model-selection decision:
 *   - mean score per model × rubric dimension
 *   - mean score per model × complexity bucket
 *   - mean score per model × hops (single vs multi)
 *
 * Usage:  node eval/scripts/summarize.mjs [path/to/results.json]
 * Produce results.json first:
 *   cd eval/promptfoo && npx promptfoo@latest eval -c promptfooconfig.generated.json -o results.json
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EVAL = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = process.argv[2] || join(EVAL, 'promptfoo', 'results.json');
if (!existsSync(path)) { console.error(`✗ results file not found: ${path}\n  run promptfoo eval with -o results.json first`); process.exit(1); }

const raw = JSON.parse(readFileSync(path, 'utf8'));
const rows = raw.results?.results || raw.results || [];
if (!rows.length) { console.error('✗ no result rows found in file'); process.exit(1); }

// accumulate score sums/counts keyed by maps
const acc = () => ({ sum: 0, n: 0 });
const byDim = {};       // model -> dim -> acc
const byCx = {};        // model -> complexity -> acc
const byHops = {};      // model -> hops -> acc
const overall = {};     // model -> acc (weighted dimension mean per answer)

for (const r of rows) {
  const model = r.provider?.label || r.provider?.id || r.provider || 'unknown';
  const meta = r.testCase?.metadata || r.metadata || {};
  const comps = r.gradingResult?.componentResults || [];
  byDim[model] ||= {}; byCx[model] ||= {}; byHops[model] ||= {}; overall[model] ||= acc();

  let answerSum = 0, answerW = 0;
  for (const c of comps) {
    const dim = c.assertion?.metric || c.metric || 'score';
    const w = c.assertion?.weight ?? 1;
    const s = typeof c.score === 'number' ? c.score : (c.pass ? 1 : 0);
    byDim[model][dim] ||= acc(); byDim[model][dim].sum += s; byDim[model][dim].n += 1;
    answerSum += s * w; answerW += w;
  }
  const answerScore = answerW ? answerSum / answerW : (typeof r.score === 'number' ? r.score : 0);
  overall[model].sum += answerScore; overall[model].n += 1;

  const cx = meta.complexity != null ? `c${meta.complexity}` : 'c?';
  byCx[model][cx] ||= acc(); byCx[model][cx].sum += answerScore; byCx[model][cx].n += 1;
  const hp = meta.hops || '?';
  byHops[model][hp] ||= acc(); byHops[model][hp].sum += answerScore; byHops[model][hp].n += 1;
}

const fmt = (a) => (a && a.n ? (a.sum / a.n).toFixed(2) : '  - ');
const pct = (a) => (a && a.n ? (100 * a.sum / a.n).toFixed(0) + '%' : ' - ');
const models = Object.keys(overall);
const pad = (s, w) => String(s).padEnd(w);

function table(title, byModel, cols, fmtFn) {
  console.log(`\n## ${title}`);
  console.log(pad('model', 28) + cols.map((c) => pad(c, 10)).join('') + pad('OVERALL', 10));
  for (const m of models) {
    const line = pad(m, 28) + cols.map((c) => pad(fmtFn(byModel[m]?.[c]), 10)).join('') + pad(fmt(overall[m]), 10);
    console.log(line);
  }
}

console.log('# SOP Assistant — model evaluation summary');
console.log(`(scores are 0–1 from the G-Eval judge; OVERALL = weighted dimension mean per answer)`);

table('Score by rubric dimension', byDim, ['Correctness', 'Completeness', 'Groundedness', 'Citation'], pct);

const cxCols = [...new Set(models.flatMap((m) => Object.keys(byCx[m] || {})))].sort();
table('Score by complexity', byCx, cxCols, pct);

table('Score by hops', byHops, ['single', 'multi'], pct);

console.log('\n(Tip: groundedness is the safety metric — weigh it heavily. A high overall with low groundedness means confident fabrication.)');
