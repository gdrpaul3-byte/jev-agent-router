# Cache-aware routing and complex mission evaluation

Approved direction: combine exact result reuse, JEV, cache-aware small LLM routing, and Astra for difficult decisions. Keep existing routing ledgers and the frozen 12-case benchmark unchanged.

## Product boundary

The new router recommends a next route. It never executes a browser action, sends a message, or grants approval. The host supplies trusted task difficulty, eligible providers and cost/latency estimates. A deterministic selector compares eligible candidates; it does not spend an extra model call to pick a model. Unknown quality is not evidence of suitability. Complex tasks go to Astra. Routine tasks default to JEV until credible, recent cost observations favor Luna. Semantic abstention can escalate once; transport errors are not retried.

Exact result reuse is scoped by namespace, caller scope, normalized task/evidence/available routes/approval policy, model and configuration, with a bounded TTL. Changed evidence invalidates reuse. Only accepted recommendations are cached. Pending calls are durable and never silently repeated after an uncertain failure. Cache replay retains original decision provenance and reports zero new inference calls. The host must recheck external state and authorization before acting.

LLM prompt caching is distinct: a stable policy/context prefix is explicitly marked, dynamic evidence follows it, and the model still generates a new answer. OpenRouter responses provide the actual cached/write token counts and credit charge. Prefix identity predicts eligibility, not guaranteed hits. No cross-model KV cache reuse is assumed.

Successful scoped observations are kept separately from exact-result identity. Recent JEV metered input-cost estimates and warm-Luna reported credit charges compete using the same cost/latency objective; neither is confused with an invoice. Explicit host estimates take precedence per provider. No extra paid calls are made to collect observations. Unknown, stale, future or mismatched observations cannot establish eligibility.

## Modules and contracts

- `src/structured-llm.mjs`: bounded, strict JSON calls to OpenRouter's OpenAI default endpoint; allowlisted Luna (`none`) and Astra (`low`), no tools/retries/provider fallback. Validates schema and response; preserves usage and cost on invalid model answers when available.
- `src/adaptive-router.mjs` and CLI: exact cache, local model selection, advisory decisions and optional one-time semantic escalation. Existing public routing APIs remain intact.
- `benchmarks/complex-mission-cases.mjs` and JSON: two synthetic, multi-document missions with base and changed-evidence variants; labels are evaluator-local. Documents require amendment precedence, date/amount calculations, incomplete information and approval boundaries.
- `benchmarks/complex-mission-eval.mjs`: all arms use the product router for evidence selection, retrieve the same local document corpus through selected routes, and use Astra to produce the final structured artifact. Deterministic expected-field scoring; no LLM judge or answer-key repair.

## Matched experiment

Arms: Astra-only routing and synthesis; Luna routing plus Astra synthesis; adaptive routing plus Astra synthesis. All get the same inputs, document access, output schema, prompt-cache options and exact-result-cache opportunity. Each task has up to three evidence-routing steps followed by synthesis. Stage-one errors remain failures and are not silently replaced by ground truth. All dispatch and synthesis cost/time count.

Phases: first observed base call (not claimed forced cold), changed evidence sharing the policy prefix, exact base replay. Exact replay must be quality-preserving with zero new inference. A change in decisive evidence must produce a miss and the updated expected artifact. Route and final quality are scored separately. Provider cached-token evidence determines warm/cold labels, not execution order.

Before live calls, freeze the fixture hash and run meaningful negative tests and the full existing suite. The live pilot has a maximum 80 POSTs and a conservative $5 inference reservation limit, no retries, fresh output directory, and checkpointed sanitized reports. Upper reservations use UTF-8 request bytes at conservative model input/cache-write rates plus maximum output tokens. They are operational guards, not invoice guarantees. An unknown charged amount stops further calls. All aborted/failing attempts stay in the report.

## Claims and limitations

This is an advisory product increment and a controlled local workflow evaluation. Synthetic expected answers have not been human-validated; the small sample does not establish production accuracy or statistical superiority. The experiment is not live browser execution, Claude/Grok verification, or video recording. Measured OpenRouter credit deductions and JEV list-price estimates remain distinct. Cache writes, fallback calls, failures, final synthesis and exact replay are all included. No publication or repository visibility change is part of this work.

## Implementation and verification checklist

- [x] Strict Luna/Astra transport: tests first; malformed schema/output, deadline, drift, usage accounting and explicit cache controls.
- [x] Adaptive router and CLI: tests first; cost selection, stale observations, TTL, changed evidence, approvals, lock/pending, replay and escalation accounting.
- [x] Complex fixtures/scorer: tests first; answer-key separation, exact arithmetic, altered evidence, incomplete data, illegal approvals and malformed artifacts.
- [x] Whole-workflow harness: tests first; identical cache privileges, all-call accounting, budget reservation, error distinction, sanitized checkpoint and frozen hashes.
- [x] Review integrated implementation, run complete regression suite, execute bounded live pilot and document actual results without tuning labels to outcomes.

Sources checked 2026-09-24: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching), [Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra).
