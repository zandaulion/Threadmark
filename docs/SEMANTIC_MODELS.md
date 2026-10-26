# CPU alternatives to Jev

Assessment date: 2026-10-17. CPU-only evaluation with four inference threads. Private host specifications are omitted. No production settings were changed. All evaluation text and monitoring conditions were authored synthetically; no account messages, database contents, credentials, or live Jev requests were used.

**Recommendation:** keep the current deployment unchanged. Kev-0.8B is the most promising compatible candidate tested, but its reference CPU runtime is too slow for the existing request path and its thresholds and dates need work. Prototype a quantized CPU runtime, use locally parsed date candidates, and validate provider-specific thresholds on a separate larger set. If inference still exceeds delivery budgets, move it to bounded background jobs. Laya multilingual did not pass even basic quality checks; SemIf/Qwen3.5-4B Q4 passed its limited category probes but took about a minute per basic request and cannot express the existing larger date choices. Smaller SemIf models and optimized Kev runtimes remain unmeasured.

## What Threadmark needs

`app/server/jev.mjs` has nine base Noul questions: payment, meeting, reminder, invoice, urgency, promotional purpose, personal obligation, transactional relevance, and recipient specificity. The context/payment-safety group adds four questions; date extraction adds ten; up to twenty monitors can add further questions. The sample tester asks the base nine. Actual ingestion normally enables both `paymentSafety` and `extractDate` for non-receipts, so otherwise-unmatched messages generally ask 23 questions before monitors. Even with context storage disabled, `paymentSafety` includes the four context/payment-safety questions. Local candidates can omit unrelated built-ins. A fully populated request can contain 43 questions.

The existing behavior depends on more than an argmax. Generic detections require 0.78, invoices 0.68, and the actionable-date gate 0.80. Gmail promotional routing combines several probabilities, including 0.85/0.90/0.95 promotional gates and 0.15/0.30 relevance ceilings. These numbers cannot be assumed to transfer to a different model.

Inputs can include 12,000 characters of Romanian or English message text and six recent context snippets of up to 2,000 characters each. Date questions have up to 61 choices. The production timeout is 4.5 seconds, bounded to at most 8 seconds by the detector constructor. Local alerts survive provider failures, but unmatched semantic alerts and monitors can be missed.

## Candidates

| Candidate | Fit to the interface | CPU considerations | Initial assessment |
| --- | --- | --- | --- |
| Laya multilingual, 322M | Noul and Choice, structured state/instructions, compatible HTTP service | Smallest relevant multilingual checkpoint; default combined sequence limit 1,024 tokens; configurable longer input | Measure with unchanged prompts first; Romanian support alone does not establish task accuracy |
| Kev-0.8B | Compatible `/v1/systemone`, all current primitives and choice counts | Reference CPU path uses fp32; state-prefix reuse; smallest Kev | Practical size for an initial CPU screen, but upstream warns of weaker transfer quality |
| Kev-4B | Same compatible interface | About 16 GB of fp32 weights before working memory; substantially more demanding than 0.8B | Stronger quality candidate, but not yet measured here; quantized native runtime would need separate validation |
| SemIf over Qwen3.5-4B Q4 | Native CLI scoring method over frozen instruction weights; requires an adapter | Documented llama.cpp CPU backend and shared-state restoration; roughly 3 GB GGUF | Worth screening; its reference limit of 16 options cannot answer Threadmark's day/hour/minute questions unchanged |

SemIf is a scoring method over existing open models, rather than a dedicated replacement checkpoint. Its raw option scores are explicitly uncalibrated; its temperature-fitting tools require workload labels. Kev carries a fitted temperature, which still needs validation on Threadmark. Laya also recommends workload-specific evaluation and calibration.

Primary sources: [Laya](https://github.com/NandhaKishorM/laya), [Laya CPU measurements](https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md#server-cpu-amd-epyc-9r14-4-cores-linux), [Kev](https://github.com/jaredpalmer/kev), [Kev-0.8B model card](https://github.com/jaredpalmer/kev/blob/main/docs/model-cards/kev-0.8b.md), [SemIf CPU backend](https://github.com/TheoLeeCJ/SemIf-OpenJev/blob/main/src/semif_phase1/llamacpp_backend.py), [SemIf calibration](https://github.com/TheoLeeCJ/SemIf-OpenJev/blob/main/docs/CALIBRATION.md).

## Screening protocol

The corpus in `examples/semantic-eval.mjs` has 29 cases: 16 Romanian and 13 English, with 166 explicitly labeled Noul judgments, 11 relevant date choices, and three expected final dates. It covers invoices, invoicing ads, paid receipts, contributions, appointments, forms, vouchers, newsletters, urgent account matters, social messages, misleading bulk hints, context changes/cancellations, semantic monitors, and an invoice at the end of a longer message. Most cases use the minimal nine-question sample-tester shape; three request the date questions and two request context questions. These timings therefore understate the work of many real ingestion calls.

The exporter captures the exact request constructed by the production detector through its injected client. Native runners execute real model inference. The scorer replays each response through the same detector, preserving monitor/invoice precedence, existing thresholds, and date gates. Expected labels are never sent to a model.

Noul correctness at 0.5, Brier score, relevant detection gates, final category, and final date are reported separately. Missing scores count as incorrect, rather than silently becoming negative labels. Unsupported SemIf choices are recorded and omitted, so its date results expose the integration gap. No temperature or threshold was fitted on this small corpus.

This is a falsification screen, not an estimate of inbox accuracy. Paired translations and multiple labels per message are correlated. It does not exercise the full ingestion pipeline, Gmail suppression decisions, notifications, urgency ordering, attachment processing, outages, concurrent traffic, or sustained memory usage. There is no measured Jev baseline. A successful screen would justify a larger held-out evaluation, not deployment.

## Measured results

| Runtime | Correct category, including no alert | Labeled Noul correct at 0.5 | Brier (lower is better) | Median / p95 request | Over 4.5 s |
| --- | --- | --- | --- | --- | --- |
| Laya multilingual, unchanged prompts | 8/29 | 72/166 | 0.4623 | 3.59 / 11.31 s | 6/29 |
| Kev-0.8B v1.0, fp32 serving path | 25/29 | 149/166 | 0.1215 | 19.10 / 58.01 s | 29/29 |

Both returned the correct final date on only 1/3 date cases: rejecting the optional voucher date. Neither resolved either positive date correctly. Both got 5/11 labeled date choices right; the independent actionable-date gate and combination of fields matter more than individual choice accuracy.

Laya repeatedly interpreted ads, receipts, and appointments as invoices. For example, the Romanian invoicing-software ad received invoice probability 0.9468, versus 0.7219 for the real Romanian bill. A single threshold change cannot repair that ordering. The clean run repeated all 29 answer objects exactly from the first run. Only the clean run's timings are reported above; the earlier run overlapped native compilation and is excluded.

A second Laya experiment replaced the nine base questions with concise instructions and default yes/no criteria on the first twenty cases. Median latency fell to 1.51 s (p95 1.78 s), but only 8/20 categories and 78/136 labeled Nouls were correct. This was an exploratory prompt change on a subset, not a controlled estimate of improvement or a production modification. Its exact requests and outputs are saved separately.

Kev handled all first sixteen basic invoice/payment/meeting/task/marketing cases correctly at the category level. Across the complete corpus it missed the urgent English account task (reminder 0.7041), the Romanian appointment (meeting 0.7797), the Romanian build monitor (0.7387), and the long-message invoice (invoice 0.2994; payment 0.6025). The first three demonstrate threshold transfer problems; the invoice also shows a semantic failure. Fitting temperatures alone cannot fix every miss. Its reference CPU path uses PyTorch fallbacks for the Gated DeltaNet kernels; these timings do not establish how a GGUF or another optimized CPU runtime would perform.

Peak observed process RSS, including loading/transient allocations, was about 2.97 GiB for Laya and 6.28 GiB for Kev. Basic nine-question requests took roughly 3.2–3.8 s with Laya and 18–20 s with Kev; larger request shapes cost more. These are sequential native measurements on a shared server, not dedicated-host throughput benchmarks.

SemIf's Qwen3.5-4B Q4 CPU configuration was screened separately on four Romanian compatibility probes (`invoice-ro`, `invoice-marketing-ro`, `meeting-ro`, `date-ro`), rather than the full corpus. Categories were correct on 4/4 and labeled Nouls on 20/21 at 0.5. Basic requests took 61.05–63.47 s; the date probe took 103.12 s. It returned the three supported labeled date choices correctly but could not represent the day/hour/minute choices, so the resulting date was absent. Peak process RSS was about 5.95 GiB. Those hard integration and latency failures were sufficient to stop expansion to the full corpus. This smaller probe set cannot support a comparable general accuracy claim, and says nothing measured about smaller SemIf base models. The native library used a CPU-only build with OpenMP.

The exact synthetic requests and raw outputs are in [evaluations/2026-10-17-cpu](evaluations/2026-10-17-cpu/). They contain public model metadata and authored fixtures only. The scorer was checked with an independently constructed known-answer response set: 166/166 Nouls, 11/11 choices, 29/29 categories, and 3/3 dates. All 83 existing Threadmark tests passed with localhost networking available; three server suites failed under the restricted network sandbox and passed when rerun with loopback access.

## Reproduce

Install each model runtime in a separate virtual environment. Keep downloaded weights and temporary results outside the repository. The Node harness uses the existing app dependency installation.

This run used Laya 0.4.8, Kev source `1f04cfa28e6a708485b28a9585010b9e436b776e`, and SemIf source `23cf1f39fc9534fe81437200959b6dfc7106e45a`. SemIf's GGUF came from `bartowski/Qwen_Qwen3.5-4B-GGUF` revision `4168f45a16a1290d65a4ec0fa312ae917a4c15d6`. Exact model revisions and runtime versions are also stored with the result rows.

```bash
node scripts/evaluate-semantic-model.mjs --export /tmp/threadmark-requests.jsonl

# In a Python environment with laya==0.4.8:
python scripts/evaluate-laya.py --input /tmp/threadmark-requests.jsonl \
  --output /tmp/threadmark-laya.jsonl

# In an environment with jaredpalmer/kev installed from source (not the unrelated PyPI package):
python scripts/evaluate-kev.py --input /tmp/threadmark-requests.jsonl \
  --output /tmp/threadmark-kev.jsonl

# In an environment with SemIf's llamacpp extra and its pinned Qwen tokenizer:
python scripts/evaluate-semif.py --input /tmp/threadmark-requests.jsonl \
  --output /tmp/threadmark-semif.jsonl --gguf /path/to/Qwen_Qwen3.5-4B-Q4_K_M.gguf

node scripts/evaluate-semantic-model.mjs --responses /tmp/threadmark-laya.jsonl \
  --model laya-multilingual --out /tmp/threadmark-laya-report.json

# Score the archived SemIf compatibility probes (a different, smaller sample):
node scripts/evaluate-semantic-model.mjs \
  --responses docs/evaluations/2026-10-17-cpu/semif.jsonl \
  --ids invoice-ro,invoice-marketing-ro,meeting-ro,date-ro \
  --model semif-qwen3.5-4b-q4 --out /tmp/threadmark-semif-report.json
```

The native runners use four CPU threads and exclude model loading and one warmup from their timings. Kev and SemIf use an unrelated warmup; Laya warms its first request, without a prefix cache. Each response records model revisions, runtime versions, timing scope, and peak process RSS. RSS includes runtime and transient loading allocations, not just steady-state weights. SemIf also records the GGUF checksum and prompt hashes. The scorer fixes the timezone to Europe/Bucharest for expected dates. Use `--ids invoice-ro,meeting-en` with the Node harness to export or score an explicitly selected subset.

For an already running local compatible server, use `--base-url http://127.0.0.1:PORT --model MODEL --out /tmp/report.json` instead of `--responses`. This measures sequential HTTP requests with a generous evaluation timeout; it does not change Threadmark's production timeout. Never point this unauthenticated screening mode at the hosted Jev API.

## Integration implications

The installed TypeSafe JavaScript SDK already honors `TYPESAFE_BASE_URL`; the detector passes `JEV_MODEL`. However, Threadmark's environment splitter does not currently preserve `TYPESAFE_BASE_URL`, the enabled check still requires a key or injected client, and UI/privacy text and status assume TypeSafe AI. A proper local-provider change should address those together, including accurate model provenance and provider-specific thresholds.

Longer background inference also needs an ingestion design review, not just a larger detector timeout. Both connectors' delivery requests time out after ten seconds, while ingestion currently waits for semantic evaluation before storing the resulting items. A slow provider can therefore outlive a connector request and trigger retries. Bounded background jobs, quick durable acknowledgment, and idempotent result application would avoid tying connector delivery to a minute-long model call.

For SemIf, choose a date strategy before writing an HTTP adapter: retain deterministic date extraction, select among dates parsed from the message, or decompose larger choice sets. Replacing 61-way choices by an arbitrary truncated list would lose valid answers. For Laya, inspect reported truncation and validate complete email/context coverage; increasing a token budget does not establish long-input accuracy or acceptable CPU latency.

Before enabling any candidate for promotional routing, use a separate held-out set of actionable administrative messages mixed with marketing. Measure mistakenly suppressed obligations directly. Generic classification accuracy cannot establish that this policy is safe to reuse.
