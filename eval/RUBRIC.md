# SOP Assistant — Evaluation Rubric (LLM-as-Judge)

This is the scoring contract. A separate, strong **judge model** scores each
candidate answer **pointwise against a gold answer** (we have reference answers,
so this is more reliable and cheaper than pairwise ranking). The judge never sees
which model produced an answer, and **must not be one of the candidate models**
(self-preference bias).

## What is being measured

Every candidate answer is produced by the **real SOP agent** (LibreChat → Ollama
model → `wiseway-docs` MCP `search`/`fetch` → role-gated retrieval → cited answer).
So a low score can reflect retrieval *or* reasoning *or* citation — the four
dimensions below separate these so failures are attributable.

## The four dimensions (scored independently, 1–5)

Each dimension is scored 1–5 by the judge, with explicit reasoning emitted **before**
the score (G-Eval / chain-of-thought form — this measurably improves accuracy and
reduces judge variance).

| # | Dimension | Question the judge answers | Why it matters here |
|---|-----------|----------------------------|---------------------|
| 1 | **Correctness** | Does the answer factually agree with the gold answer? Any contradictions or wrong facts? | A wrong HR/SOP/safety answer is actively harmful. |
| 2 | **Completeness** | Does it cover all the required points in the gold answer (thresholds, conditions, steps)? | Partial answers ("you need a licence" without "HRWL class LF") are unsafe in practice. |
| 3 | **Groundedness** | Is every claim supported by the source documents — no invented policy, no inference beyond the text? | **The safety-critical dimension.** A confident-but-unsupported answer is worse than "I don't know." Score this hardest. |
| 4 | **Citation** | Does it cite the correct source doc(s) as a Markdown `[Title](source_url)` link, matching what retrieval returned? | The product promise is *cited* answers traceable to policy. |

### 1–5 anchors (same scale, applied per dimension)

- **5** — Fully meets the dimension. Indistinguishable from an expert answer.
- **4** — Minor shortfall that wouldn't mislead a staff member.
- **3** — Usable but with a real gap (a missing condition, a vague citation).
- **2** — Significant problem (a wrong/missing key fact, or an uncited claim).
- **1** — Fails the dimension (contradicts the gold answer / fabricated / uncited).

A special case used across all dimensions: if the gold answer is **"not in the
documents you can access"** (the correct refusal for a role-gated / absent doc) and
the candidate instead fabricates an answer, **Groundedness = 1** regardless of how
plausible it sounds.

## Scoring protocol

- **Pointwise, reference-grounded.** Judge sees: the question, the gold answer, the
  candidate answer, and the source doc title(s). It does **not** see the model name.
- **Reason-then-score.** The judge writes a one-line justification per dimension
  before emitting the integer — never a bare number.
- **Aggregate.** Per answer: report all four 1–5 scores. A single headline number,
  if needed, is a weighted mean: **Correctness 0.30, Completeness 0.25,
  Groundedness 0.30, Citation 0.15** (groundedness + correctness dominate).
- **Pass threshold** (for CI-style gating, optional): mean ≥ 4.0 **and**
  Groundedness ≥ 4. Groundedness has a hard floor — you cannot pass on a fabrication.

## Bias mitigations (treated as requirements, not nice-to-haves)

- **Self-preference** — the judge is a different, stronger model than any candidate.
  Configured in one place (`eval/promptfoo/promptfooconfig.yaml`, `defaultTest.options.provider`).
- **Verbosity** — the rubric states explicitly: *length is not quality*; padding with
  unsupported detail lowers Groundedness, it does not raise Completeness.
- **Position** — N/A for pointwise scoring (only one answer is judged at a time).
- **Authority/style** — confident tone is not evidence; the judge scores against the
  gold answer and source text only. Calibrate by hand-grading ~5 anchor answers and
  spot-checking the judge against them.

## Question complexity metadata (for slicing results)

Each question carries metadata so we can see *where* a model degrades, not just an
average. Two orthogonal axes plus a 1–5 roll-up:

- **`hops`** — `single` (answerable from one whole retrieved doc) vs `multi`
  (requires the agent to search/fetch 2+ distinct docs and synthesise). Because
  retrieval is **whole-document, no chunking**, `multi` specifically stresses the
  agent's willingness to run multiple searches.
- **`type`** — `factoid` (direct lookup) · `reasoning` (conditional logic /
  interpretation) · `aggregation` (combine several facts).
- **`complexity`** — 1 (trivial single fact) … 5 (multi-doc synthesis or subtle
  conditional reasoning). Assigned by the author **and** independently re-rated by an
  adversarial verifier; the verifier's rating is the stored one.

Results are reported sliced by `complexity` and `hops` so you can answer "this model
is fine on single-hop factoids but collapses on multi-hop reasoning" — the decision
a model-selection actually turns on.
