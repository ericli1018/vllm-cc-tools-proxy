# Changelog

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
