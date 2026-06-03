# SOP Assistant — Evaluation Harness

Generate a graded test set from the Wiseway SOP documents and score candidate
models **through the real SOP agent pipeline** (LibreChat → Ollama model →
`wiseway-docs` MCP `search`/`fetch` → role-gated retrieval → cited answer), with an
LLM-as-judge rubric and complexity-sliced reporting.

This evaluates the **whole chain**, not a bare model: a low score can come from
retrieval, reasoning, or citation — the four rubric dimensions separate which.

## What's here

| Path | What it is |
|---|---|
| `RUBRIC.md` | The scoring contract: 4 dimensions (Correctness/Completeness/Groundedness/Citation), 1–5 pointwise vs a gold answer, bias mitigations. **Read this first.** |
| `questions/questions.json` | 30 verified gold questions with gold answers, source docs, source URLs, and metadata (`hops`, `type`, `complexity`, `role`, `category`). |
| `build/workflow-result.json` | Provenance: the raw output of the question-generation workflow (drafted → adversarially verified → selected). |
| `scripts/setup-eval.sh` | Mints the agent API key and clones the SOP agent once per candidate model. |
| `scripts/build-tests.mjs` | Generates the promptfoo config from `questions.json` + `agents.json` + `.env`. |
| `scripts/summarize.mjs` | Turns promptfoo `results.json` into model × dimension / complexity / hops tables. |
| `scripts/ingest-corpus.mjs` | (One-time) wrote the 5 SOPs into `sample-docs/` and `questions.json` from the workflow result. |
| `promptfoo/promptfooconfig.generated.json` | Generated, gitignored (inlines the key). The runnable eval config. |
| `.env`, `agents.json` | Generated, gitignored. Live API key + base URL + judge; model→agent_id map. |

## How the questions were built

`docs/SOP/*` (1 PDF + 4 DOCX) → text-extracted → a multi-agent workflow cleaned each
into corpus markdown (now in `sample-docs/`), authored single-hop (per-doc) and
multi-hop (cross-doc) questions, **adversarially verified** each one against its
source text (refute-by-default; 38 drafted → 38 grounded → 30 selected), and
balanced the final mix. Retrieval is **whole-document, no chunking**, so multi-hop
questions specifically stress the agent running multiple searches.

## Run it

Prereqs: the stack is up (`docker compose up -d`), the SOP agent exists
(`./deploy/create-agent.sh`), and the SOPs are indexed (they're in `sample-docs/`;
`docker compose up -d --force-recreate wiseway-doc-search` if you change them).

```bash
# 1. Pull the candidate models you want to compare (qwen2.5:7b is already here)
ollama pull llama3.1:8b
ollama pull qwen2.5:3b        # etc. — deliberately include a weaker one

# 2. Create an agent per candidate model + mint the API key
./eval/scripts/setup-eval.sh                 # auto-detects Ollama chat models
#   or be explicit:  ./eval/scripts/setup-eval.sh qwen2.5:7b llama3.1:8b qwen2.5:3b

# 3. Choose the judge (must NOT be a candidate — self-preference bias).
#    Edit EVAL_JUDGE in eval/.env. Recommended: a frontier model via API key:
export ANTHROPIC_API_KEY=sk-ant-...
#    (EVAL_JUDGE defaults to anthropic:messages:claude-sonnet-4-6; or use a
#     strong local model, e.g. ollama:chat:<big-model>, for fully offline grading.)

# 4. Generate the promptfoo config and run
node eval/scripts/build-tests.mjs
cd eval/promptfoo && npx promptfoo@latest eval -c promptfooconfig.generated.json -o results.json --no-cache

# 5. Decision tables (model × dimension / complexity / hops)
cd ../.. && node eval/scripts/summarize.mjs
#    Rich UI:  cd eval/promptfoo && npx promptfoo@latest view
```

`EVAL_JUDGE` can also be overridden per-run via env, e.g.
`EVAL_JUDGE=ollama:chat:qwen2.5:7b node eval/scripts/build-tests.mjs`.

## Design notes & caveats

- **Run as admin (full access).** The quality run uses the admin user, whose role
  sees all four doc categories, so retrieval is never starved — isolating *model*
  quality. The role gate (does `office` correctly *not* see `safety`?) is a separate
  concern; build a small gate-specific set if you want to assert no-leak behaviour.
- **Judge ≠ candidate.** The judge must be stronger than and different from every
  candidate. Don't grade qwen with qwen.
- **Question set is slightly easy-skewed** (complexity c1=8/c2=10/c3=8/c4=3/c5=1;
  4/30 multi-hop). Fine for a first pass; add harder multi-hop items to stress
  stronger models. Spot-check ~5 gold answers by hand to anchor the judge.
- **Generated files inline the API key** and are gitignored. Re-running
  `setup-eval.sh` mints a fresh key each time.
- **Always run with `--no-cache`.** promptfoo caches responses keyed on
  (provider, prompt). If you change the *pipeline* (doc-search code, the agent's
  retrieval) but not the prompt or agent_id, a plain re-run silently returns the
  OLD cached answers (0s duration is the tell). `--no-cache` forces fresh agent
  calls. This bit the first fixed-pipeline run.
- **doc-search is a built image, not mounted code.** Editing
  `mcp-doc-search/server.js` or `backends/*` requires a real rebuild:
  `docker compose build --no-cache wiseway-doc-search && docker compose up -d
  --force-recreate wiseway-doc-search`. A plain `--force-recreate` (or even
  `up -d --build` without recreate) can keep running the stale image — verify with
  `docker exec wiseway-doc-search grep … /app/server.js`. Only `sample-docs/` is
  bind-mounted, so corpus changes alone just need a restart.
- **The `search`/`fetch` doc_id fix.** `search` now emits `(doc_id: …)` per hit and
  `fetch` resolves leniently (id, id-with-extension, or source_url). Before this,
  `fetch` was unusable (search never exposed the id), so models could only answer
  from short snippets — which made careful models refuse and unfairly tanked their
  scores. If you swap to the `graph` backend, mirror the lenient `fetch` resolution
  there too.
