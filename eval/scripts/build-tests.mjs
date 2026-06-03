#!/usr/bin/env node
/**
 * Generate a ready-to-run promptfoo config from:
 *   - eval/agents.json        (candidate model -> agent_id, from setup-eval.sh)
 *   - eval/questions/questions.json  (the 30 gold questions, from the build workflow)
 *   - eval/.env               (base URL, API key, judge model)
 *
 * Emits eval/promptfoo/promptfooconfig.generated.json  (gitignored — inlines the key):
 *   - one provider per candidate agent (OpenAI-compatible remote-agents endpoint)
 *   - the prompt is just the question (the SOP agent owns its own system prompt)
 *   - the 4-dimension G-Eval rubric as the shared assertion set, judged by EVAL_JUDGE
 *   - each test tagged with complexity/hops/type/role metadata for slicing
 *
 * Run:  node eval/scripts/build-tests.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EVAL = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseEnv(p) {
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = parseEnv(join(EVAL, '.env'));
const BASE = env.WISEWAY_EVAL_BASE_URL;
const KEY = env.WISEWAY_EVAL_KEY;
const JUDGE = process.env.EVAL_JUDGE || env.EVAL_JUDGE || 'anthropic:messages:claude-sonnet-4-6';
if (!BASE || !KEY) { console.error('✗ eval/.env missing WISEWAY_EVAL_BASE_URL/WISEWAY_EVAL_KEY — run setup-eval.sh'); process.exit(1); }

const agents = JSON.parse(readFileSync(join(EVAL, 'agents.json'), 'utf8'));
const qPath = join(EVAL, 'questions', 'questions.json');
if (!existsSync(qPath)) { console.error('✗ eval/questions/questions.json not found — the build workflow must finish first'); process.exit(1); }
const questions = JSON.parse(readFileSync(qPath, 'utf8'));

// --- the 4 rubric dimensions as G-Eval criteria (see eval/RUBRIC.md) --------
// Each is graded 1-5 by the judge (G-Eval normalises to 0-1). {{gold_answer}}
// and {{source_docs}} are interpolated per test. Length is explicitly not quality.
const DIM = (name, body, threshold, weight) => ({
  type: 'g-eval',
  value:
    `Dimension: ${name}. ${body} ` +
    `Reference (gold) answer: "{{gold_answer}}". Source document(s): {{source_docs}}. ` +
    `Score 1 (fails) to 5 (expert). Length is NOT quality — unsupported padding must not raise the score. ` +
    `Give a one-line reason, then the score.`,
  threshold,
  weight,
  metric: name,
});

const assert = [
  DIM('Correctness', 'Does the candidate answer factually agree with the gold answer, with no contradictions or wrong facts?', 0.6, 0.30),
  DIM('Completeness', 'Does it cover ALL required points in the gold answer (every threshold, condition, and step)?', 0.6, 0.25),
  DIM('Groundedness', 'Is every claim supported by the source document(s) — no invented policy, no inference beyond the text? If the gold answer is a refusal ("not in the documents") and the candidate fabricates one, this is a 1.', 0.8, 0.30),
  DIM('Citation', 'Does it cite the correct source doc as a Markdown [Title](source_url) link matching what retrieval returned?', 0.5, 0.15),
];

const providers = agents.map((a) => ({
  id: `openai:chat:${a.agent_id}`,
  label: a.label,
  config: { apiBaseUrl: BASE, apiKey: KEY, temperature: 0, max_tokens: 1024 },
}));

const tests = questions.map((q) => ({
  description: `${q.id}: ${q.question}`,
  vars: {
    question: q.question,
    gold_answer: q.gold_answer,
    source_docs: (q.source_docs || []).join(', '),
  },
  metadata: {
    id: q.id, complexity: q.complexity, hops: q.hops, type: q.type,
    role: q.role, category: q.category, source_docs: (q.source_docs || []).join('|'),
  },
}));

const config = {
  description: 'Wiseway SOP Assistant — model quality eval (full pipeline via LibreChat remote agents)',
  providers,
  prompts: ['{{question}}'],
  defaultTest: { options: { provider: JUDGE }, assert },
  tests,
};

const outPath = join(EVAL, 'promptfoo', 'promptfooconfig.generated.json');
writeFileSync(outPath, JSON.stringify(config, null, 2));
console.log(`✓ wrote ${outPath}`);
console.log(`  providers: ${providers.map((p) => p.label).join(', ')}`);
console.log(`  tests: ${tests.length} questions × ${assert.length} dimensions, judge=${JUDGE}`);
console.log(`\nRun:  cd eval/promptfoo && npx promptfoo@latest eval -c promptfooconfig.generated.json`);
console.log(`Then: node eval/scripts/summarize.mjs   # complexity-sliced scores`);
