## 0.29.14 - 2026-08-15

- Correct V0.29.13's over-broad sub-agent progress suppression by restoring semantic `目前處理進度：` output inside Claude Code sub-agent execution requests identified by `x-claude-code-agent-id` / `x-claude-code-parent-agent-id`.
- Protect native parent-screen sub-agent labels by suppressing assistant-text progress only for top-level streaming requests that declare an `Agent` or legacy `Task` dispatch tool; runtime telemetry, logs, pings, and native `statusLine` remain active.
- Preserve the native `Agent.input.description` / `Task` tool block at Anthropic content index 0 on parent dispatch requests.
- Keep the one-time startup banner parent-session-only even though sub-agent semantic progress is enabled again.
- Add safe `parent_agent_progress_isolated` and `subagent_progress_enabled` diagnostics without logging agent ids, prompts, descriptions, tool inputs, or response content.
- Add no new ENV and keep cache generations at `media-v8` / `visual-v18` / `evidence-v14`.

## 0.29.13 - 2026-08-15

- Detect Claude Code sub-agent API requests from the dedicated `x-claude-code-agent-id` / `x-claude-code-parent-agent-id` headers instead of guessing from tool declarations or prompts.
- Add silent semantic progress mode for sub-agent requests: transport ping, usage, telemetry, logs, and native statusLine remain active, while Proxy-generated `目前處理進度：` assistant text is suppressed.
- Preserve the first real sub-agent model/tool block at Anthropic content index 0 and keep the original Agent description untouched.
- Prevent silent sub-agent requests from consuming the parent session's one-time startup banner claim.
- Add safe `subagent_progress_isolated` diagnostics without logging agent ids, prompts, tool arguments, or response content.
- Keep main-agent visible SSE progress behavior unchanged; no new ENV is added.
- Keep cache generations at `media-v8` / `visual-v18` / `evidence-v14`.

## 0.29.12 - 2026-08-15

- Add idempotent `ProgressStream.dispose()` and guarantee request-finally cleanup so client disconnect, abort, timeout, and error paths cannot retain keepalive/heartbeat/pending timers.
- Preserve `ProgressStream.stop()` response compatibility while `dispose()` releases the final response/callback references.
- Add real client-abort and `WeakRef`/`--expose-gc` regressions for ProgressStream lifetime.
- Bound `MediaContinuationCache` by fixed 64 MiB global / 16 MiB per-session byte budgets in addition to the existing session, entry, and TTL limits.
- Add LRU byte eviction, replacement/reset/TTL byte accounting, and oversized-entry rejection.
- Expose continuation-cache byte telemetry under `GET /health` → `cache.continuation`.
- Keep persistent cache generations at `media-v8` / `visual-v18` / `evidence-v14`; no new ENV is added.

## 0.29.11 - 2026-08-15

- Added `VLLM_BASE_RESPONSE_MODE=auto|streaming|buffered` for Base response delivery semantics.
- `buffered` mode keeps `MANAGED_MODEL_ROUND_TIMEOUT_MS` as an absolute round completion deadline and disables post-first-byte stall classification.
- `streaming` mode preserves the existing first-byte deadline plus inactivity protection.
- `auto` maps SSE response Content-Type to streaming and non-SSE responses to buffered; operators can force buffered for coarse SSE-framed backends.
- Added configurable `MANAGED_MODEL_STALL_TIMEOUT_MS` with default `90000`; `0` disables streaming inactivity detection.
- Added safe `base_response_mode_selected` diagnostics and richer managed timeout fields (`response_mode`, `idle_ms`, `received_bytes`, `model_phase`, `timeout_ms`).
- Preserved V0.29.10 `VLLM_BASE_MODEL` routing and cache generations `media-v8` / `visual-v18` / `evidence-v14`.

## 0.29.10 - 2026-08-15

- Added optional authoritative `VLLM_BASE_MODEL` routing for the Base vLLM endpoint.
- When configured, rewrites only the upstream request copy; the Claude Code/client model value remains intact in the Proxy request lifecycle.
- Applied Base-model selection to both structured and transparent Base exits, covering managed rounds, count_tokens, Base language repair, ordinary bypass, and Context Compact fallback.
- WebFetch Processor now inherits `VLLM_BASE_MODEL` only when its endpoint is derived from Base and no explicit Processor model is configured.
- Explicit `WEB_FETCH_PROCESSOR_MODEL` remains highest priority; explicit independent Processor URLs do not implicitly inherit the Base model.
- Added safe `base_model_selected` diagnostics with client model, upstream model, selection source, and path.
- Vision remains separately configured through `VLLM_VISION_MODEL`.
- Kept cache generations at `media-v8` / `visual-v18` / `evidence-v14`.

## 0.29.9 - 2026-08-13

- Added same-session Historical Media Continuation Dedup for Claude Code tool-result continuations.
- Historical media already analyzed earlier in the same workflow can reuse normalized continuation evidence without rerunning Vision/PDF processing.
- Kept PARTIAL, unresolved, failed, and unavailable evidence out of the persistent Media Cache while allowing session-local continuation reuse.
- Added terminal-unavailable image evidence to the continuation store so repeated Bash/Grep rounds do not repeat exhausted Vision recovery.
- Reset continuation evidence on a new ordinary user turn and isolate it by Claude Code session id.
- Media newly returned by the latest `tool_result` bypasses historical continuation reuse so a fresh Read can still be analyzed.
- Added `media_continuation_cache_hit`, `media_continuation_cache_write`, and `media_continuation_cache_reset` diagnostics.
- Kept cache generations at `media-v8` / `visual-v18` / `evidence-v14`; no new ENV variable was added.

## 0.29.8 - 2026-08-13

- Converted `visual_crop_depth_limit` from a top-level fatal error into a controlled non-retryable Vision crop-tool result followed by bounded recovery.
- Kept `VisualAssetRegistry` maximum crop depth at 2; the release fixes terminal behavior rather than increasing recursive zoom depth.
- Limited every `recoveryContext=zoom_tile` analysis to one precise crop round, then removed `request_image_crop` from subsequent Vision requests.
- Made recovery prompts crop-budget aware so exhausted tiles salvage current evidence/uncertainty instead of asking for another crop.
- Applied the shared rule to generic IMAGE zoom tiles plus PDF DIAGRAM/DENSE_PAGE and SCHEMATIC tile workers.
- Added `vision_crop_budget_exhausted` diagnostics and regression coverage for depth exhaustion, one-round tile crops, and stubborn second crop calls.
- Advanced cache generations to `visual-v18` / `evidence-v14`; media pipeline remains `media-v8`.
- Added no ENV variables.

## 0.29.7 - 2026-08-13

- Added failure-aware Vision recovery: one original request plus up to three retries using `focused_recovery`, `structured_extraction`, and `last_chance_salvage`.
- Timeout retries reduce task scope and prioritize short factual extraction instead of repeating the same prompt.
- Added explicit `zoom_tile` recovery context for generic IMAGE zoom, PDF DIAGRAM/DENSE_PAGE zoom tiles, and PDF SCHEMATIC tiles; retries reuse the already-rendered tile and do not create another generic tiling layer.
- Bounded PDF visual tile requests to 30 seconds while preserving the configured root/overview Vision timeout.
- Added backward-compatible `VISUAL_COMPLETENESS: COMPLETE | PARTIAL`; explicit PARTIAL evidence is usable but non-cacheable.
- Generic zoom summaries now expose partial tile counts and keep any partial/unresolved/failed composite out of Media Cache.
- Added `vision_retry_started`, `vision_retry_exhausted`, `prompt_strategy`, and `visual_completeness` diagnostics.
- Advanced cache generations to `visual-v17` / `evidence-v13`; media pipeline remains `media-v8`.

## 0.29.6 - 2026-08-13

- Made deterministic generic zoom a terminal recovery layer: child tiles no longer return actionable whole-tile `NEEDS_ZOOM` through the generic fallback path.
- Added generic zoom resolution accounting (`resolved_count`, `unresolved_count`, `failed_count`, `terminal_status`) and safe `vision_zoom_summary` diagnostics.
- Fixed composite Media Cache correctness: partial/unresolved/failed zoom evidence emits `media_cache_skip` and is not persisted.
- Bounded generic zoom tile Vision requests to `min(VLLM_VISION_TIMEOUT_MS, 30000)` without adding ENV settings.
- Reject literal Vision control-protocol leakage (`tool_call`, `function_result`, `arg_key`, `arg_value`, etc.) from evidence with one strict recovery attempt.
- Advanced cache generations to `visual-v16` / `evidence-v12`; media pipeline remains `media-v8`.

# Changelog

## 0.29.5 - 2026-08-12

- Split evidence-mode Vision output into `VISUAL_STATUS` and `VISUAL_DETAIL`, so real content can be present while current scale still requires zoom.
- Required `VISUAL_DETAIL: SUFFICIENT|NEEDS_ZOOM` for `VISUAL_STATUS: CONTENT`; missing detail is contract-invalid and never inferred as sufficient.
- Routed `CONTENT + VISUAL_DETAIL: NEEDS_ZOOM` through the existing non-cacheable `needsZoom` dispatcher, preserving precise `request_image_crop`, 15% overlapping generic image tiles, and PDF DIAGRAM/DENSE_PAGE fallback tiling.
- Preserved legacy `VISUAL_STATUS: NEEDS_ZOOM` as an accepted actionable compatibility state.
- Restricted local CONTENT evidence-marker repair so it preserves an explicit detail state and never invents `VISUAL_DETAIL`.
- Added `visual_detail` to Vision quality/observation diagnostics and result propagation.
- Advanced cache generations to `visual-v15` / `evidence-v11`; media pipeline remains `media-v8`.
- Added regression coverage for sufficient-detail caching, detail-driven zoom, missing-detail recovery, generic overlapping zoom dispatch, and cache generation changes.

## 0.29.4 - 2026-08-12

- Made generic image `VISUAL_STATUS: NEEDS_ZOOM` deterministic: no-crop results now use aspect-aware 15% overlapping zoom tiles instead of resending the unchanged whole image.
- Limited generic automatic zoom to at most 6 tiles while preserving VisualAssetRegistry max depth 2 and precise nested `request_image_crop` support.
- Propagated safe media provenance (`origin`, `origin_tool`, `source_kind`, hashed `read_source_ref`, requested pages) into image diagnostics/evidence without exposing raw paths.
- Added local canonical repair for formatting-only CONTENT evidence defects, avoiding a second Vision inference when semantic evidence already exists.
- Added five-locale generic image zoom progress phases.
- Advanced Vision/evidence cache generations to `visual-v14` / `evidence-v10`; media pipeline remains `media-v8`.

## 0.29.3 - 2026-08-12

- Added `VISUAL_STATUS: NEEDS_ZOOM` as an actionable non-cacheable Vision state rather than treating dense whole-page content as WEAK/UNREADABLE.
- Reused the existing `request_image_crop` tool for precise ROI enlargement and added a 12% outer context margin to model-requested crops.
- Capped default recursive crop depth at 2 while preserving bounded crop-round/tool validation behavior.
- Added deterministic PDF `DIAGRAM`/`DENSE_PAGE` fallback tiling when NEEDS_ZOOM is returned without a usable crop call; tiles use 15% overlap, sequential Vision isolation, and page-evidence merge.
- Increased deterministic electronic `SCHEMATIC` tile overlap from 15% to 20% to preserve cross-boundary net/component continuity.
- Added localized `vision_needs_zoom` and `pdf_zoom_tile*` progress phases across all five supported locales.
- Advanced Vision/evidence cache generations to `visual-v13` / `evidence-v9`.
- Preserved V0.29.2 explicit BLANK/CONTENT contract, V0.29.1 Vision timeout/THINK/failure isolation, and V0.29.0 progressive PDF source cache behavior.

## 0.29.2 - 2026-08-12

- Replaced heuristic short-text Vision quality classification with the explicit `VISUAL_STATUS: CONTENT|BLANK|UNREADABLE` final-response contract.
- Required `VISUAL_EVIDENCE:` plus at least one Markdown evidence bullet for `CONTENT`; removed `too_short` from the evidence-quality decision.
- Treated explicit `BLANK` as GOOD/cacheable without retry, while `UNREADABLE`, missing/invalid status, and `CONTENT` without evidence remain bounded recovery cases.
- Added raw-output mode for the internal PDF page router so its `ROUTE:` protocol remains independent from the evidence contract.
- Added `output_contract`, `visual_status`, and `contract_valid` Vision quality diagnostics.
- Advanced cache generations to `visual-v12` / `evidence-v8` to isolate pre-contract Vision evidence.
- Preserved V0.29.1 strict THINK preservation, 120-second Vision deadline, per-image failure isolation, and V0.29.0 progressive PDF reading.

## 0.29.1 - 2026-08-12

- Preserved `VLLM_VISION_THINK` across the one bounded Vision quality-recovery retry instead of forcing `think=true` after a weak/empty first response.
- Added `VLLM_VISION_TIMEOUT_MS` with a 120-second default per Vision upstream request and a dedicated retryable `vision_service_timeout` deadline error.
- Converted retryable per-image Vision service/quality failures into explicit non-cacheable `evidence_available: false` image evidence so later images in the same request continue.
- Added visible `vision_quality_retry` and `image_vision_unavailable` progress phases for recovery and skip/continue behavior.
- Advanced the Vision cache generation to `visual-v11` so results created by the previous adaptive-thinking recovery cannot be reused under the new strict THINK contract.
- Preserved V0.29.0 progressive PDF Document Map / persistent source cache behavior and V0.2.28.20 large-media safety.

## 0.29.0 - 2026-08-12

- Added progressive PDF disclosure: unscoped PDFs above 20 pages return a bounded Document Map instead of full-document evidence.
- Added persistent original-PDF source cache keyed by opaque Read source reference and content SHA-256; focused `Read.pages` reuses the cached original when available.
- Added `kind=document_map` evidence semantics requiring a follow-up `Read.pages` before evidence-dependent claims beyond the map.
- Added a dedicated unscoped progressive PDF cache namespace; bumped media cache generation to `media-v8` and evidence generation to `evidence-v7`.
- Large scanned PDFs can build the initial map without Vision; detailed requested pages retain the existing text/diagram/schematic Vision routing.
- No new ENV variables. Embedding/BM25/vector retrieval and Office documents remain out of scope for this release.

## 0.2.28.20 - 2026-08-12

- Replaced the large whole-string Base64 regex with size-first iterative Base64 validation, preventing V8 `Maximum call stack size exceeded` failures on multi-MiB PDF and image payloads.
- Applied the hardened Base64 path to PDF, PNG, JPEG, GIF, and WebP and added an 8 MiB Claude Code `Read` PDF end-to-end regression proving raw Base64 is not forwarded to Base vLLM.
- Added shared request-structure depth/cycle guards across media classification, image observation, media progress, and media preflight, returning controlled 422 errors instead of call-stack exhaustion.
- Excluded raw Base64 from protocol inventory/neutralization scans and from Web Tool diagnostic trace files; diagnostics retain bounded metadata and SHA-256 only.
- Added normalized-image output-size enforcement so image conversion cannot silently expand beyond the configured decoded-media budget.
- Avoided cloning untouched user media history during Progress stripping and skipped full-message WebFetch enrichment clones when no fallback candidate exists.
- Added `request_stage`, `error_name`, and bounded `error_stack` fields to request-failure diagnostics.
- Preserved V0.2.28.19 unified round telemetry, 30-second SSE heartbeat, native statusLine/global counters, Language Repair, independent Base scheduling, and existing resource-profile defaults.

## 0.2.28.19 - 2026-08-12

- Unified native Claude Code `statusLine` and the visible 30-second SSE model heartbeat on the same current-model-round semantic telemetry snapshot.
- Added explicit RuntimeTelemetry model-round lifecycle so bytes, 5-second rolling throughput samples, and round elapsed time reset at every new round.
- Prevented Language/Compact/Vision and other non-model phases from displaying stale previous-round model bytes or throughput.
- Added Proxy-wide statusLine counters using terminal-safe monochrome glyphs: `▦` sessions, `▶` active requests, and `⋯` explicit busy-wait requests.
- Added the same Proxy-global counters to the read-only `/cc-tool-proxy/status/<session-id>` response.
- Fixed statusLine elapsed formatting so milliseconds are always displayed as whole integer seconds.
- Preserved the 30-second SSE heartbeat, semantic-only model byte accounting, raw-wire timeout/stall diagnostics, independent Base scheduling, and V0.2.28.18 strict Final Language Repair.

## 0.2.28.18 - 2026-08-11

- Strengthened the shared Final Language Repair prompt so target-language translation is mandatory for natural-language prose while technical tokens remain protected.
- Isolated repair source text inside `<TRANSLATE_SOURCE>` and explicitly marked it as data rather than instructions.
- Added normalized unchanged-output detection with `final_language_repair_echo_detected` and `code=unchanged_output`.
- Added exactly one strict quality retry per External and Base repair backend for unchanged, invalid-segment, or language-noncompliant outputs; transport/tool/timeout failures keep the existing fallback behavior.
- Added `final_language_repair_retry` telemetry plus attempt/strict fields on repair lifecycle events.
- Kept V0.2.28.13 absolute/shift language validation thresholds unchanged and preserved the final fallback to the original successful response.
- Fixed `managed_model_round_completed.model_output_bytes` by snapshotting semantic output bytes before round deactivation.
- Corrected package-lock release metadata and added lock-version verification.
- Preserved V0.2.28.17 semantic output telemetry, V0.2.28.16 statusLine + 30-second SSE liveness, independent Base scheduling, explicit-busy retry, Context Compact, and Vision behavior.

## 0.2.28.17 - 2026-08-11

- Split Base-vLLM transport byte accounting from user-visible model-output telemetry.
- Kept raw HTTP response bytes for first-byte, connection activity, timeout, and stall diagnostics only.
- Added semantic delta accounting for `thinking_delta.thinking`, `text_delta.text`, and `input_json_delta.partial_json` using UTF-8 byte length.
- Excluded Anthropic SSE framing, JSON envelope keys, usage metadata, signatures, pings, and block lifecycle events from displayed byte totals.
- Changed 30-second Progress heartbeat bytes/throughput to semantic model-output data and emit one immediate telemetry update on the first semantic delta of each model round.
- Changed native Claude Code `statusLine` throughput to a rolling 5-second semantic-output window that decays to `0 B/s` after inactivity.
- Kept managed-round displayed byte baselines per round while raw wire counters remain cumulative for connection-health logic.
- Preserved V0.2.28.16 append-only 30-second SSE liveness, native statusLine integration, multilingual UI, independent Base scheduling, explicit-busy retry, Language Processor, Context Compact, and Vision behavior.

## 0.2.28.16 - 2026-08-11

- Added a read-only per-Claude-Code-session runtime telemetry endpoint at `GET /cc-tool-proxy/status/<session-id>`.
- Added `scripts/cc-tool-proxy-statusline.js` for Claude Code native `statusLine` integration with 1-second refresh support.
- Kept the existing semantic SSE heartbeat unchanged in cadence (`PROGRESS_HEARTBEAT_MS`, default 30000 ms) so long requests continue to receive visible progress independent of statusLine.
- Retired V0.2.28.15 carriage-return live-line replacement and restored append-only heartbeat lines after real Claude Code TUI testing showed `\r` does not provide direct cursor control.
- Added content-free session telemetry for waiting/thinking/response/tool/busy/compact/language/vision/stalled states, elapsed time, received bytes, rolling throughput, and processor/tool labels.
- Added localized native status-line rendering for `zh-TW`, `zh-CN`, `en-US`, `ja-JP`, and `ko-KP`, with `en-US` fallback.
- Preserved independent Base connections, explicit-busy retry, Language Processor, Context Compact, Vision, and Final Language Gate behavior.

## 0.2.28.15 - 2026-08-11

- Added a carriage-return Progress Live-Line Renderer: semantic heartbeat telemetry now reuses one terminal line instead of appending one history line per heartbeat.
- Separated immutable milestone updates from replaceable live heartbeat updates; model phase changes and Claude Code tool handoffs remain visible.
- Added conservative trailing-space padding when a replacement line is shorter so stale terminal characters are cleared without ANSI erase sequences.
- Commit a live line with `\r\n` before appending the next milestone so the new phase starts from column zero.
- Kept the V0.2.28.14 low-frequency `◐ ◓ ◑ ◒` pulse and existing heartbeat cadence; no new animation timer or SSE refresh loop was added.
- Kept the renderer language-agnostic across `zh-TW`, `zh-CN`, `en-US`, `ja-JP`, and `ko-KP`, with `en-US` fallback for unknown locales.
- Preserved progress-history stripping for control-bearing progress blocks so live telemetry cannot become model conversation evidence.
- Preserved Base/Managed scheduling, explicit-busy retry, `LANG_PROCESSOR_*`, Final Language shift validation, Context Compact, and Vision behavior unchanged.

## 0.2.28.14 - 2026-08-11

- Replaced the dynamic `目前處理進度（已收到 ...）`-style header with a stable localized progress header so delayed visibility cannot contradict an earlier phase byte snapshot.
- Added phase-aware runtime telemetry for main-model `WAITING`, `THINKING`, `RESPONDING`, `TOOL`, and observational `STALLED` states.
- Added recent upstream throughput to semantic heartbeat lines using request-local heartbeat samples; no new timer or higher SSE cadence is introduced.
- Added low-frequency `◐ ◓ ◑ ◒` thinking pulse frames driven only by existing semantic heartbeats.
- Added post-first-byte stall visibility without retrying, cancelling, or resubmitting accepted vLLM requests; explicit upstream busy retry remains a separate state.
- Localized the new telemetry contract for `zh-TW`, `zh-CN`, `en-US`, `ja-JP`, and `ko-KP`, preserving `en-US` fallback for unknown locales.
- Preserved V0.2.28.13 language-shift validation, V0.2.28.12 `LANG_PROCESSOR_*` and session banner, and V0.2.28.11 independent Base connection behavior.

## 0.2.28.13 - 2026-08-11

- Added original-vs-repaired Final Language shift validation as a second layer after the V0.2.28.12 technical-prose absolute classifier.
- Added `accept_by_language_shift` when repaired output remains classified as the original source language but gains at least 12 target-language characters, removes at least 12 source-language characters, and reduces source-language natural prose by at least 30%.
- Added `final_language_repair_validation` diagnostics with original/repaired target/source counts, target gain, source reduction, and source-reduction ratio.
- Kept wrong target languages and Chinese variants as hard failures; zh-CN cannot be rescued for a zh-TW request.
- Kept short target-language prefaces from passing when the original source-language prose is not materially reduced.
- Preserved V0.2.28.12 `LANG_PROCESSOR_*`, Technical Token stripping, session banner, and V0.2.28.11 independent Base connection behavior.

## 0.2.28.12 - 2026-08-11

- Fixed Final Language Gate false positives for Traditional Chinese technical prose by excluding technical identifiers from natural-language Latin dominance checks and adding safe classifier telemetry.
- Added independent `LANG_PROCESSOR_ENABLED`, `LANG_PROCESSOR_PROVIDER`, `LANG_PROCESSOR_URL`, `LANG_PROCESSOR_MODEL`, `LANG_PROCESSOR_API_KEY`, and `LANG_PROCESSOR_THINK` settings; Final Language Repair no longer borrows WebFetch Processor configuration.
- Added provider-native language repair: Ollama uses `/api/chat` plus `think`, while vLLM uses `/v1/chat/completions` plus `chat_template_kwargs.enable_thinking`.
- Added a one-time per-Claude-Code-session startup banner with Proxy version, uptime, active session/request counts, explicit-busy wait count, and Compact/Language/Vision feature state.
- Kept startup telemetry transient: it is never sent upstream, token-counted, language-repaired, or retained as model conversation evidence.
- Preserved V0.2.28.11 independent Base connections and explicit-busy retry semantics without adding a Proxy-wide scheduler.

## 0.2.28.10 - 2026-08-10

- Added optional `CONTEXT_COMPACT_PROVIDER`, `CONTEXT_COMPACT_URL`, `CONTEXT_COMPACT_MODEL`, `CONTEXT_COMPACT_API_KEY`, and `CONTEXT_COMPACT_THINK` settings for Claude Code native Context Compact summarization.
- Added provider-specific compact clients: Ollama native `/api/chat` uses `think=true|false`; vLLM `/v1/chat/completions` uses `chat_template_kwargs.enable_thinking` with `preserve_thinking=false`.
- Routed detected compact requests to the external worker only after the V0.2.28.9 tool-removal guard; external workers never receive Claude Code tools or enter the Managed Loop.
- Preserved the original Claude model identity in Anthropic JSON/SSE responses and kept Qwen backend token usage diagnostic-only so it cannot contaminate Claude/Laguna context accounting.
- Discarded backend thinking/reasoning while preserving literal `<analysis>...</analysis>` summary text requested by Claude Code.
- Added deterministic fallback to the V0.2.28.9 Base Compact route on backend connection, timeout, HTTP, JSON, empty-output, or tool-call failure.

## 0.2.28.9 - 2026-08-10

- Added a dedicated Claude Code Context Compact request detector before managed-tool classification.
- Compact summarizer requests now bypass the Managed Loop even when Claude Code includes WebSearch/WebFetch or other tool definitions.
- Removed `tools` and `tool_choice` only from the outbound compact summarization request so the Base model cannot turn compaction into an agent/tool round.
- Compact responses are transparently returned without Managed Final contract inspection, `control_tag_leak` repair, continuation recovery, Final Language repair, or managed progress injection.
- Added regression coverage proving a compact summary containing literal `<analysis>...</analysis>` is returned in one upstream round and does not trigger managed recovery.
- Preserved the V0.2.28.8 cache-aware context-token accounting fix unchanged; no new ENV variables or external Context Compact model routing are included.

## 0.2.28.8 - 2026-08-10

- Fixed managed Anthropic context-token accounting when `/v1/messages/count_tokens` preflight totals are followed by vLLM cache-split usage.
- Replaced field-by-field `Math.max()` merging of input/cache counters with atomic input-side usage replacement.
- Preserved the last authoritative input tuple when an upstream usage delta contains only output counters.
- Added regression coverage for `197500 total -> 5000 uncached + 192500 cache_read`, ensuring the Claude-facing total remains `197500` instead of `390000`.
- Added no ENV variables and did not add Context Compact model routing in this release.

## 0.2.28.7 - 2026-08-10

- Added protocol-derived main-model generation phases for managed Anthropic SSE: `waiting`, `thinking`, `response`, and `tool`.
- Added compact one-line heartbeat text such as `主模型處理中 60 秒（思考，29.82 KB）…` using existing per-round upstream byte accounting.
- Added immediate compact phase-transition progress and safe `managed_model_stream_phase_changed` diagnostics without logging model content.
- Removed redundant user-visible transport first-byte progress while retaining `managed_model_first_byte_received` diagnostics.
- Reset phase state to `waiting` at every managed model round, including controlled continuation.
- Added no ENV variables and kept model behavior and cache generations unchanged at `media-v7` / `visual-v10` / `evidence-v6`.

## 0.2.28.6 - 2026-08-10

- Removed the `<<<VCC_LANG_SEGMENT_*>>>` model-visible protocol from Final Language Repair; Proxy now owns segment/block mapping.
- Changed external language repair to one tool-less, non-thinking plain-text translation request per final text block, preserving source order deterministically.
- Changed Base fallback to isolated one-segment requests with direct visible-text extraction instead of marker parsing.
- Added safe per-segment processor diagnostics (`segment_index`, `segment_count`, input/output character counts) without logging source or translated text.
- Preserved target-language post-validation and the external → Base → original-response failure chain.
- Added no ENV variables and kept media cache generations unchanged at `media-v7`, `visual-v10`, and `evidence-v6`.

## 0.2.28.5 - 2026-08-10

- Added recovery-only continuation state preparation after the existing Managed Loop continuation gate; normal rounds do not invoke compression.
- Restricted compressor input to the immediately preceding model-generated `thinking` and unfinished visible `text`; tool calls/results and authoritative evidence never enter the compressor.
- Added size-aware preservation: full state through 24K chars, deterministic HEAD+TAIL through 96K, and 24K windows with 4K overlap for larger state.
- Added strict tool-less external state compression using the existing `WEB_FETCH_PROCESSOR_*` auxiliary processor, with deterministic fallback on any processor failure or malformed/tool-call output.
- Preserved a recent raw model-state tail and added transparent progress/diagnostics for produced, compressed, and retained state sizes.
- Kept media cache generations unchanged at `media-v7`, `visual-v10`, and `evidence-v6`; no new ENV was added.

## 0.2.28.4 - 2026-08-09

- Isolated SCHEMATIC overlapping tiles so each tile is sent in one sequential Vision request instead of grouping up to four large tile images in one request.
- Added tile-level fault containment: expected `vision_*` failures produce `pdf_schematic_tile_failed`, a bounded evidence-gap marker, and a warning while later tiles continue; unexpected programming errors still propagate.
- Added safe transport-cause diagnostics (`transport_code`, `transport_phase`) for headers/body/connect/connection failures while retaining the public `vision_service_error` code.
- Tightened SCHEMATIC routing to require visible electronic circuit/wiring evidence and explicitly exclude flow charts, screenshots, UI procedures, architecture/block diagrams, and sequence diagrams.
- Advanced cache generations to `media-v7` / `visual-v10` / `evidence-v6`.
- Added no ENV variables and did not introduce Vision streaming or change the V0.2.28.3 Vision Evidence Quality Gate.
## 0.2.28.3 - 2026-08-09

- Added a Vision Evidence Quality Gate so non-empty refusal-like, metadata-only, and very short non-observable outputs are not treated as valid evidence.
- Added safe `vision_output_quality` diagnostics with `quality`, bounded reason codes, and `cacheable` without logging model content.
- Added one Adaptive Thinking Recovery attempt: weak/empty terminal output retries with `think=true` and a bounded evidence-recovery instruction, while response-side reasoning stripping remains authoritative.
- Persistent weak output now raises `vision_output_invalid`; persistent empty output continues to raise `vision_empty_output`. Neither failure path can write Media Cache.
- Preserved concise concrete visual descriptions without forcing an unnecessary retry.
- Advanced cache generations to `media-v7` / `visual-v9` / `evidence-v5` to invalidate V0.2.28.2 low-quality visual evidence.
- Added no ENV variables and did not change PDF/Image routing, Read.pages, recursive crop, Final Language Gate, or managed-loop behavior.

## 0.2.28.2 - 2026-08-09

- Removed V0.2.28.1 manual `/nothink` system-prefix injection from Ollama GLM Vision and external language-repair requests; provider-native thinking controls remain in place.
- Added `vision_output_observed` safe diagnostics for visible-content, thinking, tool-call, and control-tag counts without logging model content or reasoning.
- Added one controlled retry for empty Vision output. Persistent empty output now raises `vision_empty_output` and cannot be written to Media Cache.
- Preserved response-side Vision reasoning stripping (`message.thinking`, `<think>...</think>`, orphan think tags).
- Advanced cache generations to `media-v7` / `visual-v8` / `evidence-v4` to invalidate V0.2.28.1 synthetic empty visual evidence.
- Added distinct external-to-Base language-repair fallback progress text; no new ENV variables.

## 0.2.28.1 - 2026-08-09

- Added post-validation after every Final Language repair backend. Structurally valid output that still clearly classifies as the wrong language is rejected with `language_not_compliant`; external repair falls back to Base repair.
- Normalized GLM no-thinking controls: native Ollama keeps `think=false` and receives `/nothink` for GLM models; Ollama OpenAI-compatible repair keeps `reasoning_effort=none` plus `/nothink`; vLLM keeps `chat_template_kwargs.enable_thinking=false` / `preserve_thinking=false`.
- Stripped native Vision `message.thinking`, complete `<think>...</think>` regions, and orphan think tags before evidence production while retaining raw control-tag diagnostics and adding `visual_reasoning_stripped`.
- Advanced cache generations to `media-v7` / `visual-v7` / `evidence-v3` so V0.2.28 visual evidence containing reasoning material cannot be reused.
- Added no ENV variables and preserved PDF/Image routing, `Read.pages`, image payload observability, recursive crop, Managed Loop recovery, Final Language fallback semantics, and WebSearch/WebFetch behavior.

## 0.2.28 - 2026-08-09

- Added source-aware IMAGE wire-contract diagnostics for Claude Code `Read(image)`, direct images, and generic tool-result images.
- Added `image_payload_observed` structural logging without raw Base64, raw image bytes, or full paths.
- Added safe preservation of image dimension metadata through request-scoped media preflight.
- Added decoded-byte accounting to media entries/occurrences.
- Added `image_payload_normalized` diagnostics and cache metadata for received versus normalized image dimensions.
- Kept the existing Image Vision/recursive-crop path and `media-v7` / `visual-v6` / `evidence-v2` cache generations unchanged.
- Added regression coverage for nested Read images, direct images, generic tool-result images, metadata redaction, and dimension observability.

## 0.2.27.3 - 2026-08-09

- Reset Claude Code visible `modelWaiting` / `modelFirstByte` byte counts at each managed model-round boundary by using `round_received_bytes` instead of request-wide cumulative bytes.
- Preserved request-wide cumulative Base response bytes for throughput diagnostics and final request accounting.
- Added `round_received_bytes` to managed progress diagnostics while a model round is active.
- Added regression coverage for a large thinking-only round followed by controlled continuation: visible progress now restarts at `0 B` and then reports only the continuation round bytes.
- Added no ENV variables and preserved V0.2.27.2 PDF `Read.pages`, V0.2.27.1 live media progress, managed recovery policy, and cache/evidence generations `media-v7`, `visual-v6`, `evidence-v2`.

## 0.2.27.2 - 2026-08-09

- Added native Claude Code `Read.pages` correlation from `Read` tool-use history to returned PDF media without introducing a custom tool.
- Added canonical PDF page-scope parsing and page-scoped media cache identities so whole-document evidence cannot satisfy focused rereads.
- Added focused PDF parsing for both full-source PDF payloads and Claude Code subset-PDF payloads, preserving original logical page numbers in evidence.
- Allowed focused reads of a bounded page set from PDFs whose total page count exceeds the ordinary whole-document page limit.
- Made media cache preflight occurrence- and page-scope-aware so a cached whole PDF cannot suppress V0.2.27.1 live progress for a focused cache miss.
- Preserved V0.2.27 routing, schematic tiling, recursive crop, vLLM/Ollama Vision providers, existing ENV names, and cache/evidence generations `media-v7`, `visual-v6`, `evidence-v2`.
- Deliberately did not persist raw PDFs across turns; each focused reread uses the current Claude Code `Read.pages` result as its source of truth.

## 0.2.27.1 - 2026-08-09

- Opened managed SSE progress before PDF/Vision preprocessing completes by using a sanitized text-only usage bootstrap request for streamed media cache misses.
- Kept raw PDF/image payloads, Base64, proxy file handles, paths, and cache keys out of the bootstrap `/v1/messages/count_tokens` request.
- Added an exact cumulative `message_delta.usage` update after normalized media evidence is available, while keeping large-context admission based on the exact post-normalization token count.
- Added per-tile render and per-tile-batch Vision progress for the V0.2.27 schematic pipeline.
- Preserved client cancellation, recursive ROI, page merge, vLLM/Ollama Vision routing, and all existing ENV names.
- Kept cache/evidence contracts at `media-v7`, `visual-v6`, and `evidence-v2` because evidence semantics are unchanged.

## 0.2.27 - 2026-08-09

- Added low-resolution PDF page routing with the bounded `TEXT`, `DIAGRAM`, `SCHEMATIC`, and `DENSE_PAGE` classes so text-rich vector-only technical drawings can enter Vision processing.
- Added a schematic-specific 300–400 DPI overview plus deterministic 15% overlapping tiles rendered from the original PDF, with a default 360 DPI tile render and bounded maximum tile count.
- Added depth-0 deterministic visual regions so recursive model-requested crops from schematic tiles continue to resolve against the original PDF at the existing bounded 600–720 DPI policy.
- Added conservative page-level schematic evidence merge with exact overlap deduplication, source retention, and explicit uncertainty preservation.
- Routed scanned/image-only text through Vision transcription without adding a dedicated OCR dependency or new ENV settings.
- Added classification, tiling, region-lineage, schematic merge, scanned-page, and tool-suppression regression tests.
- Advanced cache contracts to `media-v7`, `visual-v6`, and `evidence-v2`.
- Preserved vLLM/Ollama Vision providers, WebSearch/WebFetch, managed-loop behavior, Final Language Gate, and existing ENV names.

## 0.2.26.5 - 2026-08-08

- Bypassed Final Language Gate for the exclusive `native_web_search` fast lane so Claude Code internal WebSearch child/results are never presentation-rewritten.
- Expanded common Simplified/Traditional Chinese variant markers and added short-text discrimination from four Han characters when at least two same-direction markers clearly dominate.
- Preserved conservative handling for mixed technical Chinese and all V0.2.26.4 External→Base→original fallback behavior.
- Added no ENV variables and changed no Laguna chat-template, WebFetch/Vision, timeout, scheduling, or tool-lifecycle contracts.


## 0.2.26.4 - 2026-08-08

- Replaced Base-model response-language prompting with a final-response language gate.
- Removed runtime injection of the V0.2.26.2 system language contract and V0.2.26.3 generation-adjacent user tail.
- Added conservative deterministic final-visible-prose language classification that ignores code, inline code, URLs and path-like literals.
- Added External Processor language-only rewrite using the existing `WEB_FETCH_PROCESSOR_*` backend configuration.
- Added isolated Base vLLM single-shot language-repair fallback when the External Processor is unavailable or fails.
- Preserved the original successful Laguna response when both repair backends fail.
- Kept thinking, tool-use blocks, tool results and intermediate managed rounds outside language repair.
- Buffered streaming Base responses until final language compliance is known while preserving Base request/header/first-event/usage/completion progress diagnostics.
- Added no new ENV variables; `MODEL_RESPONSE_LANGUAGE` now means Final Presentation Language.

## 0.2.26.3 - 2026-08-08

- Kept the V0.2.26.2 locale-native system language contract and added a compact locale-native generation-adjacent language tail to the latest user turn sent to Base vLLM.
- Re-anchored exactly one language tail before every managed Base-model round, including rounds after managed tool results, without persisting the tail into the Claude Code transcript.
- Re-applied the tail after native Web-tool normalization so `/v1/messages/count_tokens` preflight and first-round inference receive the same prompt content.
- Preserved the original Laguna chat template and avoided tool/protocol/JSON wording in the tail.
- Preserved V0.2.26 Media/Vision, V0.2.26.1 activity-aware timeout behavior, WebSearch/WebFetch lifecycle, scheduling, and all existing ENV names.

## 0.2.26.2 - 2026-08-08

- Replaced the Main/Base-model `Respond in ...` language instruction with a short locale-native visible-output contract for all five supported `MODEL_RESPONSE_LANGUAGE` values.
- Scoped the contract to user-visible natural-language content and explicitly prevents language drift unless the user requests another language.
- Referred to the `think` reasoning block without injecting literal `<think>` / `</think>` control-tag syntax, preventing the language policy itself from polluting protocol diagnostics.
- Kept the language instruction at the end of the transformed Anthropic system prompt with the existing blank-line boundary.
- Did not modify the official Laguna chat template and did not add tool/protocol wording to the language prompt.
- Preserved WebFetch Processor/Vision prompts, Proxy status localization, Media/Vision, WebSearch/WebFetch, activity-aware timeout policy, and scheduling. No new ENV variable was added.

## 0.2.26.1 - 2026-08-08

- Reinterpreted `MANAGED_MODEL_ROUND_TIMEOUT_MS` as a first-response-byte deadline when Base upstream activity telemetry is available.
- A managed model round that has started receiving upstream bytes is no longer terminated merely because total round wall time reaches 360 seconds.
- Preserved the 90-second sliding response-body inactivity detector after first byte; every new upstream chunk refreshes `lastByteAt`, and a true post-start stall still fails with `managed_model_stall_timeout`.
- Kept `managed_model_timeout` for rounds that do not produce any first response byte within the configured first-byte deadline.
- Disabled the whole-task absolute deadline by default. `MANAGED_TASK_TIMEOUT_MS` remains backward-compatible as an optional positive override; unset, blank, or `0` means disabled.
- Removed the forced `1800000` Compose/default-env task deadline while keeping `MANAGED_MODEL_ROUND_TIMEOUT_MS=360000`.
- Preserved V0.2.26 Media/Vision behavior, managed scheduling, WebSearch/WebFetch, response-language policy, and existing timeout error codes. No new ENV variable was added.

## 0.2.26 - 2026-08-08

- Moved managed media adaptation before Base `/v1/messages/count_tokens`, so raw PDF/image blocks no longer reach Base vLLM during usage preflight and large-context classification uses transformed evidence tokens.
- Added selective PDF Vision routing for low-native-text pages and pages with raster images reported by `pdfimages -list`.
- Replaced fixed 180-DPI PDF overview rendering with adaptive 220–320 DPI rendering targeting about 3500 pixels on the long edge.
- Added original-PDF high-resolution regional rerendering for Vision-requested crops, bounded to 600 DPI at the first crop level and 720 DPI for deeper recursive crops.
- Preserved original JPEG/PNG pixels as crop roots and bounded crop presentation interpolation to at most 4x.
- Made derived crops first-class registered visual assets with root/parent/depth lineage, enabling crop-of-crop and multiple-region recursive inspection.
- Increased the bounded internal Vision crop workflow to 3 rounds / depth 3 / 8 derived crops per root while retaining the per-round batch limit.
- Added safe `vision_upstream_request` / `vision_upstream_response` diagnostics with provider/backend/model/image-dimension/timing metadata.
- Advanced media cache generations to `media-v6` / `visual-v5`.
- Preserved V0.2.25.2 managed streaming/progress, multi-Agent scheduling, WebSearch/WebFetch, response-language behavior, and all existing Vision ENV names. No new ENV variable was added.

## 0.2.25.2 - 2026-08-08

- Kept the external hotfix label `V0.2.25.2` while using npm-valid package metadata `0.2.25+hotfix.2`.
- Added one immediate localized progress update when the first Base-vLLM upstream response chunk arrives during an already-visible managed progress block.
- Kept normal 30-second semantic heartbeat sampling for later chunks so token/SSE activity does not spam Claude Code UI.
- Preserved quiet behavior for fast managed requests that complete before a progress block is shown.
- Added `managed_model_first_byte_received` with first-byte timing and byte counters.
- Added `upstream_received_bytes` and `model_elapsed_ms` to `progress_sse_sent` diagnostics.
- Preserved V0.2.25.1 managed SSE collection, V0.2.25 scheduling, WebFetch/Ollama routing, stall timeout and hard deadline semantics.

## 0.2.25.1 - 2026-08-08

- Kept the external hotfix label `V0.2.25.1` while using npm-valid package metadata `0.2.25+hotfix.1`.
- Changed Managed Base-model rounds from forced `stream:false` JSON responses to `stream:true` Anthropic SSE requests.
- Added an internal Anthropic SSE-to-Message collector that reconstructs thinking, text, streamed tool JSON, usage and stop state without changing the Managed Loop response contract.
- Made V0.2.24 cumulative Base-vLLM bytes update while generation is still in progress when the upstream supports SSE streaming.
- Made V0.2.25 `receivedBytes` / `lastByteAt` stall detection observe live managed response-body activity instead of only a completed JSON body.
- Retained a JSON Message compatibility fallback for upstreams that ignore `stream:true`.
- Preserved the V0.2.25 native WebSearch fast lane, large-context gate, queue/model timers, WebFetch/Ollama Processor routing and response-language behavior.

## 0.2.25 - 2026-08-08

- Added a dedicated one-slot native WebSearch fast lane for exclusive `web_search_YYYYMMDD` child requests, independent of the general managed queue.
- Added an internal one-slot large-context gate for streamed managed requests with at least 100000 preflight input tokens.
- Added `native_web_search` and `large_context` admission state to `/health`, plus lane/classification diagnostics.
- Split queue-wait elapsed time from Base-model-round elapsed time in localized progress heartbeats; model time now starts when the model round actually starts.
- Preserved V0.2.24 cumulative Base-vLLM response-byte reporting.
- Added conservative 90-second response-body stall detection that arms only after the current model round receives its first upstream byte; the existing model-round timeout remains the hard deadline.
- Preserved V0.2.23.2 forced native WebSearch tool choice and the existing WebFetch/Ollama Processor lifecycle.

## 0.2.24 - 2026-08-08

- Added request-scoped cumulative counting of raw Base-vLLM response-body bytes for managed requests.
- Added binary byte formatting (`B / KB / MB / GB`) and localized received-byte wording for all five `MODEL_RESPONSE_LANGUAGE` profiles.
- Added the cumulative byte count to the first visible progress header and semantic heartbeat messages.
- Counted bytes at the Base-vLLM HTTP response boundary before JSON/SSE parsing; request bytes, Claude Code SSE bytes, SearXNG, WebFetch Processor and visual-model traffic are excluded.
- Preserved V0.2.23.2 native WebSearch forced-choice behavior and existing WebSearch/WebFetch lifecycle boundaries.

## 0.2.23.2 - 2026-08-08

- Kept the external hotfix label `V0.2.23.2` while using npm-valid package metadata `0.2.23+hotfix.2`.
- Forced exclusive Claude Code native `web_search_YYYYMMDD` child requests to expose only the normalized `web_search` tool and send `tool_choice={type:tool,name:web_search}` to the Base model.
- Released the forced managed tool choice to `auto` immediately after the first successful Search tool round so the continuation can summarize evidence instead of repeatedly searching.
- Added `forced_tool_choice` to native WebSearch normalization diagnostics and `managed_forced_tool_choice_satisfied` when the forced choice has been consumed.
- Preserved ordinary main-agent WebSearch/WebFetch handoff, native WebFetch behavior, SearXNG execution, and V0.2.23.1 response-language behavior.

## 0.2.23.1 - 2026-08-08

- Kept the external hotfix label `V0.2.23.1` while using npm-valid package metadata `0.2.23+hotfix.1`.
- Replaced the soft Main/Base-model language preference (`Default to ...`) with a direct locale-specific `Respond in ...` instruction.
- Added an explicit `\n\n` boundary to appended Anthropic system text blocks so direct vLLM system-block concatenation cannot glue the language policy to preceding Claude Code text.
- Added a regression test that simulates direct vLLM `system` text-block joining for all five supported locales.
- Preserved the V0.2.23 WebFetch Processor instruction, localized Proxy status text, `en-US` fallback, and the V0.2.22 Claude Code-owned WebSearch/WebFetch lifecycle.

## 0.2.23 - 2026-08-08

- Added `MODEL_RESPONSE_LANGUAGE` as the single response-language setting for main-model user-visible answers, WebFetch Processor output, and Proxy progress/status text.
- Added exact locale profiles for `zh-TW`, `zh-CN`, `en-US`, `ja-JP`, and `ko-KP`; missing, blank, case-variant, or unsupported values resolve deterministically to `en-US`.
- Injected one short locale-specific system instruction at the Base-model boundary while preserving technical literals verbatim.
- Added locale-specific WebFetch Processor output instructions without changing WebFetch 200-content child routing or redirect/error fallback behavior.
- Localized Proxy-generated Search, Fetch, queue, media/PDF/image, heartbeat, recovery, handoff, streaming, and final-return progress/status text from the same registry.
- Extended progress-history sanitation to recognize every supported localized progress header while retaining the historical Traditional Chinese headers for compatibility.
- Preserved V0.2.22 Claude Code-owned WebSearch/WebFetch lifecycle and diagnostic tracing behavior.

## 0.2.22 - 2026-08-08

- Replaced the V0.2.20/V0.2.21 main-agent synthetic Server Tool handoff with the Claude Code-owned built-in WebSearch/WebFetch lifecycle proven by diagnostic traces.
- Ordinary `WebSearch`, `web_search`, `WebFetch`, and `web_fetch` tool uses are now returned unchanged to Claude Code instead of being executed inside the same main-agent managed loop.
- Preserved Proxy-managed native `web_search_YYYYMMDD` child requests; those requests still execute through SearXNG and return Anthropic-compatible Web Search server-tool results to Claude Code.
- Added detection of Claude Code WebFetch 200-content processor child requests whose payload begins with `Web page content:` and routes them directly to the configured independent WebFetch Processor instead of the main Laguna model.
- Added bounded WebFetch lifecycle correlation by Claude Code session and `tool_use_id`.
- Added redirect/explicit-fetch-error enrichment: returned WebFetch `tool_result` blocks are resolved to their original URL/prompt, fetched once through awesome-web-fetch, processed through the configured WebFetch Processor, and replaced only in the Base-model view.
- Successful Claude Code WebFetch summaries are not re-fetched; enriched fallback results are cached to avoid duplicate work when history is replayed.
- Mixed ordinary Web tools and Claude Code client tools now return together unchanged, preserving the model's intended parallel tool choices.
- `MAX_TOOL_ROUNDS` / managed-round limits remain safety fuses for Proxy-owned child workflows and no longer define the normal research-depth limit across Claude Code turns.
- Retained diagnostic file tracing from `0.2.21-diagnostic.1`, disabled by default.
- Preserved WebFetch Processor `vllm|ollama` routing, automatic `/v1/chat/completions` URL normalization, three-slot Processor concurrency, protocol isolation, media adaptation, deterministic final promotion, and slow-model timeout controls.

## 0.2.21 - 2026-08-07

- Fixed Claude Code-facing Server Tool SSE shape by including `input: {}` in every streamed `server_tool_use` start block before `input_json_delta` events.
- Added explicit Web UI declaration detection for `WebSearch`, `web_search`, `web_search_YYYYMMDD`, `WebFetch`, `web_fetch`, and `web_fetch_YYYYMMDD`, while continuing to exclude MCP/substring/custom names.
- Added `server_web_ui_bridge_selected` diagnostics with `native_server_tool` vs `visible_progress` mode and declaration counts.
- Added strict response metadata for synthetic WebSearch results: nullable `page_age` plus a stable Proxy-local opaque `encrypted_content` identity token.
- Added guaranteed `title` and `retrieved_at` metadata for synthetic WebFetch result blocks.
- Preserved V0.2.20 mixed server/client continuation, SearXNG, awesome-web-fetch, vLLM/Ollama WebFetch Processor routing, three-slot Processor concurrency, usage counters, managed-loop stability gates and protocol isolation.

## 0.2.20 - 2026-08-07

- Added a unified Proxy-owned Web Server Tool Bridge for WebSearch and WebFetch.
- Canonicalized explicit aliases `WebSearch`, `web_search`, `web_search_YYYYMMDD`, `WebFetch`, `web_fetch`, and `web_fetch_YYYYMMDD` while deliberately excluding substring/MCP/custom names.
- Surfaced Proxy-owned web calls to Claude Code as `server_tool_use` blocks and returned `web_search_tool_result` / `web_fetch_tool_result` blocks after local execution.
- Added Anthropic-style `usage.server_tool_use.web_search_requests` and `web_fetch_requests` counters.
- Added streaming server-tool lifecycle emission so the frontend can observe a search/fetch without being responsible for executing it.
- Reworked mixed server + client tool handling: server web calls are deferred when emitted beside Read/Write/Bash or another client tool, then resumed after Claude Code returns the correlated client `tool_result`.
- Reconstructed deferred server-tool state from request history instead of adding Redis or process-session state.
- Added bounded sanitation of completed server-web lifecycle history before later Base-model turns, while keeping unresolved server calls intact.
- Preserved SearXNG, awesome-web-fetch, WebFetch Processor vLLM/Ollama routing, 3-slot Processor concurrency, managed stability gates, deterministic final promotion, and tool-description protocol isolation.

## 0.2.19.3 - 2026-08-07

- Kept external release label `V0.2.19.3` while using npm-valid package metadata `0.2.19+hotfix.3`.
- Added `WEB_FETCH_PROCESSOR_PROVIDER` with strict `vllm` / `ollama` values and default `vllm`.
- Added WebFetch Processor base-URL normalization so root endpoints such as `http://192.168.10.169:11434` automatically become `/v1/chat/completions`; `/v1` and `/v1/messages` are normalized to the same OpenAI-compatible chat endpoint, while already complete endpoints are preserved.
- Preserved explicit non-root custom Processor endpoints for backward compatibility.
- Kept vLLM thinking control on `chat_template_kwargs.enable_thinking`.
- Added Ollama OpenAI-compatible thinking control through `reasoning_effort=none` when `WEB_FETCH_PROCESSOR_THINK=false` and `reasoning_effort=high` when true.
- Preserved independent Processor URL/API key/model, global concurrency 1..3, per-call timeout, managed budgets, deterministic final promotion and tool-description isolation.
- Native Web Search result/citation/count emulation remains outside this hotfix.

## 0.2.19.2 - 2026-08-07

- Kept external release label `V0.2.19.2` while using npm-valid package metadata `0.2.19+hotfix.2`.
- Added deterministic promotion for a strict completed-answer case: `stop_reason=end_turn`, thinking-only content, no tool calls, no protocol tags, answer-like structure, and no continuation intent.
- Promoted eligible reasoning-channel final answers directly into one visible `text` block without a second Base-model recovery call.
- Preserved final-channel recovery for unsafe promotion cases such as `max_tokens`, protocol-tag contamination, ambiguous/unfinished reasoning, and continuation intent.
- Added recursive protocol-tag neutralization for tool `description` fields, including nested JSON-schema property descriptions, before tool definitions enter the Base vLLM prompt.
- Preserved schema-bearing values such as `enum`, `default`, tool names and non-description strings exactly; ordinary user text is not rewritten by tool-description isolation.
- Added `protocol_tool_descriptions_sanitized` and `managed_final_response_promoted` content-free diagnostics.
- Extended incoming protocol inventory with tool-definition tag counts.
- Preserved V0.2.19.1 WebFetch Processor concurrency, slow-model budgets, domain normalization and V0.2.20 Native Web Search scope boundary.

## 0.2.19.1 - 2026-08-07

- Kept external release label `V0.2.19.1` while using npm-valid package metadata `0.2.19+hotfix.1`.
- Added a proxy-wide WebFetch Processor semaphore with `WEB_FETCH_PROCESSOR_CONCURRENCY`, default 3 and bounded to 1..3.
- Managed tool batches now execute independent tool calls concurrently while preserving correlated result order.
- Added `WEB_FETCH_PROCESSOR_TIMEOUT_MS`, default 300000 ms, and preserved independent Processor `URL`, `API_KEY`, `MODEL`, and `THINK` routing.
- Increased slow-model defaults to `MANAGED_TASK_TIMEOUT_MS=1800000` and added `MANAGED_MODEL_ROUND_TIMEOUT_MS=360000`.
- Added final-round budget reservation: after managed evidence exists, WebSearch/WebFetch are removed from the next round when only one model-round budget remains; Claude Code client tools remain available.
- Normalized string `allowed_domains` / `blocked_domains` arguments into arrays before managed execution or mixed Claude Code handoff.
- Anthropic Native Web Search result/citation emulation remains out of scope for this hotfix.

## 0.2.19 - 2026-08-07

- Applied managed final-response validation to every Base-model response, including responses that already contain structured `tool_use` blocks.
- Prevented malformed thinking/text protocol markup from being bypassed merely because a valid tool call was also present.
- Changed continuation recovery to preserve tools while forcing `enable_thinking=false` and `preserve_thinking=false`.
- Added a bounded neutralized excerpt of the previous incomplete model state to continuation recovery so recovery continues instead of restarting blind.
- Added incoming Claude Code `tool_result` protocol quarantine for nested text and string payloads while preserving ordinary user text.
- Added exact consecutive managed-action detection with the terminal `managed_no_progress` code before duplicate execution.
- Added a 10-minute managed-task deadline via `MANAGED_TASK_TIMEOUT_MS` and an internal four-minute per-model-round cap with `managed_task_timeout` / `managed_model_timeout` errors.
- Added content-free `laguna_runtime_contract_violation` telemetry for Poolside parser/reasoning contract anomalies.
- Preserved V0.2.18 response-side Native Web containment; Anthropic-native Web Search result/citation/count emulation remains outside this release.
- Added regression coverage for mixed valid-tool/protocol-leak responses, recovery state continuity, tool-result isolation, duplicate-action blocking, and both timeout levels.

## 0.2.18 - 2026-08-07

- Added response-side normalization for Native `server_tool_use` blocks named `web_search` or `web_fetch`.
- Converted those blocks into proxy-owned `tool_use` calls before Managed Final inspection, recovery or dispatch.
- Removed Base-supplied `web_search_tool_result` and `web_fetch_tool_result` blocks before assistant history construction.
- Added local execution of response-side Native Web calls through the existing SearXNG and awesome-web-fetch Managed Tool paths.
- Deferred unrelated Claude Code tool calls when they are mixed with response-side Native Web calls, allowing the model to reissue them after receiving actual web evidence.
- Added final stream and non-stream containment so Native Web Server Tool blocks cannot reach Claude Code or trigger `Did 0 searches`.
- Added content-free `native_web_response_contained` and `native_web_mixed_tool_deferred` diagnostics.
- Added unit, Managed Loop, mixed-tool and end-to-end Claude Code SSE regression coverage.

## 0.2.17 - 2026-08-07

- Added prefix-based normalization for Anthropic native `web_search_*` and `web_fetch_*` server-tool definitions.
- Replaced native definitions with vLLM-compatible custom tool schemas before both `/v1/messages/count_tokens` and `/v1/messages` calls.
- Preserved existing custom WebSearch/WebFetch definitions and avoided duplicate aliases when native and custom definitions coexist.
- Added request-local enforcement for native `max_uses`, including failed-attempt accounting and recoverable `max_uses_exceeded` tool results.
- Added native `allowed_domains` and `blocked_domains` enforcement for WebSearch results and WebFetch targets.
- Added conservative `max_content_tokens` enforcement for WebFetch content while retaining global resource-profile bounds.
- Added metadata-only `native_web_tools_normalized` diagnostics without logging domain rules, URLs, prompts, results or content.
- Preserved V0.2.16 Usage Preservation, V0.2.15 Progress Semantics and V0.2.14 Recovery Routing without adding environment variables.
- Added end-to-end regression coverage for explicit Count Tokens normalization, Usage Preflight, SearXNG execution, WebFetch execution and native policy limits.

## 0.2.16 - 2026-08-07

- Added a managed-stream token preflight through the existing Anthropic-compatible `/v1/messages/count_tokens` endpoint before the proxy emits its synthetic SSE `message_start`.
- Replaced the fixed managed-stream `input_tokens: 0` with the preflight token count so Claude Code can observe realistic context usage and trigger automatic compaction.
- Added normalized forwarding for `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, and bounded `server_tool_use` counters.
- Added Direct Streaming observation of upstream `message_start` and `message_delta` usage without forwarding a duplicate `message_start` event.
- Added safe `managed_usage_preflight_succeeded`, `managed_usage_preflight_failed`, `managed_response_usage_observed`, and `managed_stream_usage_observed` diagnostics containing token counts only.
- Made token-count preflight failure non-fatal: the Claude Code turn continues with a zero-valued fallback usage object instead of aborting tool execution.
- Preserved V0.2.15 progress semantics, V0.2.14 Recovery Routing, Managed Tool Routing, WebFetch processing, and protocol diagnostic files without adding environment variables.
- Added regression coverage for non-zero initial usage, cache counters, direct-stream usage observation, auto-compact compatibility, and count-token endpoint failure fallback.

## 0.2.15 - 2026-08-06

- Replaced the ambiguous `處理完成；正在回傳模型結果…` managed-stream message with response-aware proxy-turn states.
- Added buffered response classification for Claude Code tool handoff, visible turn answers and conservative model-output fallback.
- Added structured phases `handoff_to_claude_code`, `returning_visible_response` and `returning_model_output` with separate proxy-turn and Claude-task terminal flags.
- Added first-block-aware direct streaming progress for text, thinking, tool-use and unknown output.
- Changed generic and file-aware semantic heartbeats to state that the base model is processing the current request turn.
- Preserved V0.2.14 Managed Tool Routing, Recovery Routing, WebFetch processing and protocol diagnostics without new environment variables.
- Added regression coverage for buffered and streaming response semantics, structured close phases and current-turn heartbeat wording.

## 0.2.14 - 2026-08-06

- Split invalid no-tool Base responses into conservative `final_channel` and agent-safe `continuation` recovery routes.
- Preserved the original tools and tool choice for unfinished reasoning, next-step planning, ambiguous thinking-only responses, missing visible output and non-final protocol recovery.
- Added a short isolated final-channel recovery that disables thinking with request-level chat-template kwargs and removes tools only for a substantial structured completed answer with no continuation intent.
- Routed recovered WebSearch/WebFetch calls back through the normal managed executor and returned recovered Read/Bash/Edit/Task calls unchanged to Claude Code.
- Prevented structured action plans and imperative research steps from being misclassified as completed final answers.
- Added bounded one-attempt recovery diagnostics with route, tool-preservation, classification signals and managed/unmanaged recovered-tool disposition.
- Replaced the terminal recovery error code with `response_recovery_exhausted` when the single recovery call also fails to produce a valid next action.
- Added regression coverage for completed answers, unfinished reasoning, recovered managed tools, recovered Claude Code tools and structured action plans.

## 0.2.13 - 2026-08-06

- Changed `LOG_PROTOCOL_SNIPPETS=true` from per-fragment main-log expansion to atomic timestamped JSON diagnostic files.
- Added one file per original or repaired malformed response with request ID, round, phase, response metadata, complete redacted anomalous fields, request provenance, positions and fingerprints.
- Added `managed_final_response_diagnostic_file` main-log events containing only path, size, SHA-256 and match counts.
- Added non-fatal `managed_final_response_diagnostic_file_failed` events; diagnostic storage failure does not alter Claude Code execution or final-response repair.
- Added private directory/file permissions and atomic temporary-file rename so diagnostic collectors never receive partially written JSON.
- Kept `LOG_PROTOCOL_SNIPPETS` as the only switch; the internal directory is `/tmp/vllm-cc-tools-proxy/protocol-snippets` and no new ENV variable is required.
- Added Docker retrieval instructions and complete file-based regression coverage.

## 0.2.12 - 2026-08-06

- Added opt-in `LOG_PROTOCOL_SNIPPETS=true` diagnostics for managed final-response anomalies.
- Added one structured log event per malformed control-tag location with response phase, block type, field, tag spelling, character offset, line/column, bounded context and content fingerprint.
- Added bounded head/tail excerpts for answers trapped in `thinking` and bounded block previews for missing visible output.
- Added request-side protocol provenance snippets across the System prompt, message history and tool definitions when repair begins.
- Added credential redaction for Bearer tokens, common key/token/password/secret assignments, known key prefixes and URL user information.
- Kept detailed snippets disabled by default; normal safe count-only diagnostics remain unchanged.
- Unified package, health and startup log version reporting through `src/version.js`.

## 0.2.11 - 2026-08-06

- Added an isolated prompt-directed WebFetch Content Processor using an OpenAI-compatible `/v1/chat/completions` request with no Claude Code history or tools.
- Added five simple Processor settings: `WEB_FETCH_PROCESSOR_ENABLED`, `URL`, `MODEL`, `API_KEY`, and `THINK`; the Base API key is inherited only when the Processor URL is derived from Base.
- Applied deterministic source cleanup, protocol and reserved-boundary neutralization, repeated-content removal, bounded input and a bounded cleaned-excerpt fallback.
- Changed successful WebSearch/WebFetch `tool_result` content from JSON-stringified objects to readable multiline VCC evidence blocks with source and processing metadata.
- Added one short idempotent Managed Web Results system supplement explaining `source`, `processing`, `result`, and `selected_evidence` without embedding tool-protocol tags.
- Added Processor output validation and safe fallback for timeout, HTTP failure, malformed JSON, empty output, tool calls, or protocol-tag leakage.
- Added safe Processor request/response/fallback diagnostics without logging API keys, source content, extraction prompts, or generated summaries.
- Added end-to-end regression coverage proving raw page noise is processed before the second Base-model round and the WebFetch `prompt`, current model, API key and THINK setting are honored.

## 0.2.10 - 2026-08-06

- Added protocol provenance inventories for incoming Claude Code system/history, managed tool results and managed final Base-model responses without logging source content.
- Expanded control-tag recognition to singular, plural and namespaced tool/function/result wrappers including `function_results`, `tool_results`, `function_calls` and `tool_calls`.
- Recursively neutralized every string in WebSearch/WebFetch output before Anthropic `tool_result` serialization, preventing fetched page markup from becoming active model protocol.
- Added managed final-response validation for control-tag leakage, missing visible text and answers trapped inside `thinking`.
- Added one tools-disabled final-response repair round; a second malformed response returns `final_response_protocol_mismatch` instead of leaking raw tags to Claude Code.
- Delayed Web-only progress activation until a real managed tool call, queue state, repair or the semantic-heartbeat threshold; short direct answers no longer show `目前處理進度：`.
- Forced the first actual managed tool call to become visible immediately even when `PROGRESS_VISIBLE_AFTER_MS` has not elapsed.
- Added end-to-end regression coverage for streamed `</function_results>` leakage, safe diagnostic content, recursive tool evidence neutralization and lazy progress.

## 0.2.9 - 2026-08-06

- Aligned the awesome-web-fetch integration with its HTTP contract: exact configured endpoint, `urls[]` request body, optional Bearer API key and `page_content` / `metadata` response normalization.
- Changed expected WebFetch HTTP, robots and backend rejections into correlated `tool_result` errors so the Base model can select another source without terminating the complete Claude Code request.
- Added safe WebFetch diagnostics for request, response and rejection boundaries without logging API keys or fetched page content.
- Replaced the implicit Node.js fetch timeout on Base vLLM requests with configurable connect, response-header and response-body-idle timeouts.
- Added stage-specific Base vLLM timeout and network error codes plus `base_upstream_request_failed` diagnostics.
- Changed managed progress to retain the latest pre-visibility state and immediately emit every state revision; the 30-second semantic heartbeat now represents only unchanged work.
- Added immediate Base vLLM lifecycle progress for request submission, response-header receipt and first model content.
- Added progress revision and delivery-latency diagnostics and regression coverage for WebFetch recovery, delayed Base headers and immediate Claude Code progress delivery.

## 0.2.8 - 2026-08-06

- Added request-scoped file-aware media progress with safe basename resolution from `source.filename`, block titles, and correlated Claude Code `Read` tool calls.
- Added page, batch, image and split-document-segment progress formatting without exposing full local paths.
- Added a visible semantic `content_block_delta` heartbeat, defaulting to 30 seconds, across media processing, Base vLLM header wait and first-model-event wait.
- Preserved the separate five-second invisible Anthropic `ping` keepalive and stopped semantic heartbeat before forwarding the first upstream content block.
- Added timeout-aware SSE backpressure handling through `SSE_DRAIN_TIMEOUT_MS`, defaulting to 10 seconds.
- Preserved `managed_task_progress` with `delivery_status=requested` and added `progress_sse_sent` / `progress_sse_backpressure` diagnostics for confirmed writes.
- Added Base vLLM lifecycle timing logs for request start, response headers, first content event and stream completion without logging prompt content.
- Added end-to-end regression coverage for delayed Base vLLM headers, delayed first events, filename display, path privacy and semantic idle-timeout prevention.

## 0.2.7 - 2026-08-05

- Replaced generic unescaped XML-like media wrappers with a non-XML `VCC_PROXY_EVIDENCE` envelope.
- Added HTML-entity escaping for all PDF-native-text and visual-model source content before it reaches the base vLLM.
- Added a neutral-evidence invariant that rejects any normalized block still containing active known reasoning, tool-call or ChatML control syntax.
- Added the idempotent `VCC_PROXY_EVIDENCE_CONTRACT_V1` system contract only to transformed media requests.
- Added safe sanitation of malformed control tags inside structured assistant thinking history while preserving user-visible text and byte-transparent clean bypass.
- Added Visual, normalized-source and base-generation tag diagnostics that log tag names/counts only and never rewrite base-model output.
- Strengthened the Visual worker prompt to prohibit reasoning delimiters, XML/HTML wrappers, function-result tags and chat-template tokens in Markdown evidence.
- Advanced media cache contracts to `media-v5`, `visual-v4` and `evidence-v1`, invalidating all V0.2.6 normalized media entries.
- Added regression coverage for `</function_result>`, `</thinking>`, `<tool_call>`, split SSE tags and poisoned PDF/Visual source text.

## 0.2.6 - 2026-08-05

- Renamed the visible managed progress heading to `目前處理進度：` while retaining cleanup compatibility for V0.2.2–V0.2.5 history.
- Added explicit `VLLM_VISION_PROVIDER=vllm|ollama` and strict `VLLM_VISION_THINK=true|false` settings.
- Added Ollama native `/api/chat` requests with boolean `think`, native image messages and `tool_name` tool results.
- Added vLLM OpenAI-compatible thinking control using both `reasoning_effort` and `chat_template_kwargs.enable_thinking`.
- Added visual provider, API protocol and thinking mode to media cache fingerprints; advanced the cache pipeline contract to `media-v4` / `visual-v3`.
- Added PDF received-page, processed-page and visual-batch observability; a received 20-page PDF is processed in five default four-page batches.
- Changed invalid model-requested crops from top-level `422` errors into bounded internal tool results returned to the visual model.
- Added mixed valid/invalid crop handling, two-round correction, final tools-disabled completion and protection against hiding unexpected proxy programming defects.
- Added end-to-end coverage proving an invalid crop does not become a Claude Code API error.

## 0.2.5 - 2026-08-05

- Added persistent normalized PDF/image analysis cache in the dedicated `proxy-data` volume.
- Added SHA-256 media fingerprints keyed by parser pipeline, visual prompt, visual model and resource profile.
- Added `cached_transform` routing so historical media remains available to the base vLLM without re-entering the managed queue.
- Added request-local media deduplication and process-local singleflight for concurrent identical media analyses.
- Added `MEDIA_CACHE_MAX_MB`: `0` uses filesystem capacity; positive values set the cache limit in MiB.
- Added TTL plus LRU eviction and atomic cache writes; `ENOSPC`/`EDQUOT` degrade cache health without failing the current request.
- Extended managed SSE keepalive through visual processing, base-vLLM TTFT and token-stream pauses using frame-safe event multiplexing.
- Added local `HEAD /api/hello` and `GET /api/hello` Claude Code compatibility probes.
- Added cache statistics and in-flight analysis count to `/health`.

## 0.2.4 - 2026-08-05

- Fixed completion-only progress blocks appearing on fast managed requests.
- Changed `closeProgress()` so a final transition message is appended only when progress is already visible.
- Preserved immediate SSE `message_start` and invisible `ping` keepalive events without creating Claude Code-visible text.
- Preserved visible queue status and long-running media/WebSearch/WebFetch progress.
- Added unit and end-to-end regression tests proving quick managed requests show only the model result.

## 0.2.3 - 2026-08-05

- Removed hidden request-scoped `VLLMCCP:v1:*` nonce sentinels from Claude Code-visible SSE.
- Added a readable dedicated `VLLM-CC-TOOLS-PROXY 進度：` text block for managed-task progress.
- Added structural removal of the dedicated progress block before later requests reach the base vLLM.
- Preserved cleanup of V0.2.2 invisible and normalized sentinel history for backward compatibility.
- Preserved managed SSE pings, progress updates, content-block index shifting and true base-vLLM final streaming.

## 0.2.2 - 2026-08-05

- Changed routing to local health/startup-probe handling plus transparent default bypass to `VLLM_BASE_URL`.
- Added raw request-body preservation for ordinary Anthropic Messages and arbitrary vLLM endpoints.
- Added bounded FIFO managed-task queue with `small`, `default` and `large` concurrency profiles.
- Added queue-full `429`, queue-timeout `503`, `Retry-After`, queue progress SSE and cancellation cleanup.
- Added a separate vision semaphore so Poppler work may overlap while visual-model calls stay bounded.
- Added request-scoped media spooling so queued jobs retain file handles instead of Base64 strings.
- Changed media-only final answers to true base-vLLM SSE after preprocessing; only proxy-owned tool loops remain buffered.
- Added `HEAD /` startup-probe support and queue state to `/health`.

## 0.2.1 - 2026-08-05

- Added persistent `proxy-source`, `proxy-npm-cache` and `proxy-apt-cache` volumes.
- Changed startup from a destructive fresh clone to initial clone plus `git pull --ff-only origin main`.
- Persisted `node_modules` in the source volume and added package manifest fingerprinting.
- Added conditional `npm ci --omit=dev`; unchanged dependencies are not reinstalled.
- Preserved the no-`bootstrap.sh`, single official Node.js container deployment.

## 0.2.0 - 2026-08-05

- Replaced four-container parser deployment with one official Node.js proxy container.
- Removed `bootstrap.sh`, Dockerfile requirement, `git pull`, parser sidecars and Tesseract OCR service.
- Added inline Compose startup using a fresh `git clone` of the fixed GitHub repository.
- Added `VLLM_BASE_API_KEY`, `VLLM_VISION_URL`, `VLLM_VISION_MODEL` and `VLLM_VISION_API_KEY`.
- Added local Poppler PDF extraction and ImageMagick normalization/cropping.
- Added OpenAI-compatible visual vLLM analysis for images and PDF page batches.
- Added bounded `request_image_crop` tool flow with normalized coordinates and two-round limit.
- Preserved Anthropic SSE progress, cancellation, managed SearXNG WebSearch and awesome-web-fetch WebFetch.

## 0.1.0 - 2026-08-04

- Added initial Anthropic Messages-compatible proxy, sidecar parsers, OCR, managed web tools and progress streaming.

## 0.2.21-diagnostic.1

- Adds a one-shot diagnostic passthrough for Claude Code built-in `WebSearch` and `WebFetch` tool calls.
- Search and Fetch use independent passthrough quotas so each built-in renderer/executor path can be observed once without disabling the other.
- Adds persistent, private, redacted file tracing for Claude Code → Proxy, Proxy → Base model, Base model → Proxy, passthrough responses, returned client `tool_result`, and unmanaged HTTP routes.
- Diagnostic traces default to `/var/lib/vllm-cc-tools-proxy/diagnostics/web-tool-trace/` under the existing persistent `proxy-data` volume.
- Console logs contain only trace-file summaries; complete payloads are written to trace files with secrets redacted.
- Normal v0.2.21 managed WebSearch/WebFetch behavior remains unchanged unless diagnostic passthrough is explicitly enabled.
