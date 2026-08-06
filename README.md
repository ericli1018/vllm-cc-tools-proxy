# VLLM-CC-TOOLS-PROXY

`VLLM-CC-TOOLS-PROXY` is a transparent Claude Code gateway for local vLLM. V0.2.11 bypasses ordinary traffic directly to the base vLLM, intercepts PDF/image content or proxy-owned WebSearch/WebFetch workflows, and persistently reuses normalized media analysis across later Claude Code turns.

## V0.2.11 architecture

```text
Claude Code
  -> vllm-cc-tools-proxy:8080
       ├─ local Poppler: PDF metadata, native text, page rendering
       ├─ local ImageMagick: validation, normalization, bounded crops
       ├─ visual provider: vLLM OpenAI-compatible or Ollama native multimodal analysis
       ├─ SearXNG / awesome-web-fetch: managed WebSearch and raw page retrieval
       ├─ WebFetch Processor: isolated prompt-directed page extraction
       └─ base vLLM: final reasoning and Claude Code tool calling
```

Routing is intentionally asymmetric:

```text
HEAD /, HEAD/GET /api/hello and GET /health
  -> handled locally

PDF/image cache miss, WebSearch or WebFetch Messages requests
  -> bounded managed workflow

PDF/image cache hit
  -> normalized cached transform without managed queue or visible progress

all other methods and endpoints
  -> transparent bypass to VLLM_BASE_URL
```

Transparent bypass preserves the original method, path, query string, request bytes, response status, response headers and streaming body. Ordinary Claude Code native tools therefore remain native vLLM streams and do not enter the proxy queue.

The deployment contains one official `node:22-bookworm-slim` service and does not use `bootstrap.sh` or a Dockerfile. The inline Compose command uses the fixed repository:

```text
https://github.com/ericli1018/vllm-cc-tools-proxy.git
```

Startup behavior:

1. The first start clones `main` into the persistent `proxy-source` volume.
2. Later starts run `git pull --ff-only origin main` in the same checkout.
3. `package.json` and `package-lock.json` are fingerprinted. `npm ci --omit=dev` runs only when that fingerprint changes.
4. `node_modules` and the dependency fingerprint remain inside `proxy-source`; npm downloads remain in `proxy-npm-cache`.
5. Debian package archives remain in `proxy-apt-cache`, reducing downloads after container recreation. Installed Poppler/ImageMagick binaries survive a normal container restart; a recreated container reinstalls them from the persistent package cache.
6. Normalized PDF/image analysis remains in `proxy-data`, independent of the Git checkout and dependency volumes.

A local source modification or non-fast-forward history intentionally stops startup instead of silently overwriting the persistent checkout. There are no parser sidecars, OCR sidecars, Redis or object storage.

## Quick start

```bash
cp .env.example .env
# Set VLLM_BASE_URL. Set all VLLM_VISION_* values for image/scanned-PDF support.
docker compose up -d
```

Point Claude Code at the proxy:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN=local-vllm
claude
```

Health check:

```bash
curl http://127.0.0.1:8080/health
```

## Persistent volumes

```text
proxy-source
  Git checkout
  node_modules
  dependency fingerprint

proxy-npm-cache
  npm package download cache

proxy-apt-cache
  downloaded Debian package archives

proxy-data
  normalized PDF/image analysis cache
  atomic cache entries and runtime cache metadata
```

Normal update:

```bash
docker compose restart vllm-cc-tools-proxy
```

The restart runs `git pull --ff-only`. When `package-lock.json` has not changed, npm installation is skipped. To discard all persisted source and package state explicitly:

```bash
docker compose down -v
```

This deletion is destructive and forces a new clone and dependency installation on the next start.
It also deletes the persistent media-analysis cache.

## Required vLLM settings

```env
VLLM_BASE_URL=http://host.docker.internal:8000
VLLM_BASE_API_KEY=
VLLM_BASE_CONNECT_TIMEOUT_MS=10000
VLLM_BASE_HEADERS_TIMEOUT_MS=900000
VLLM_BASE_BODY_TIMEOUT_MS=900000

VLLM_VISION_URL=http://host.docker.internal:8001
VLLM_VISION_MODEL=Qwen/Qwen3.6-27B
VLLM_VISION_API_KEY=
VLLM_VISION_PROVIDER=vllm
VLLM_VISION_THINK=false
```

`VLLM_BASE_URL` points to an Anthropic Messages-compatible vLLM endpoint. The proxy sends the base key only to this endpoint. The proxy uses explicit upstream timeouts instead of Node.js fetch defaults:

```text
VLLM_BASE_CONNECT_TIMEOUT_MS
  TCP/TLS connection establishment

VLLM_BASE_HEADERS_TIMEOUT_MS
  wait for Base vLLM HTTP response headers

VLLM_BASE_BODY_TIMEOUT_MS
  maximum idle interval between response-body chunks
```

The defaults are 10 seconds, 15 minutes and 15 minutes respectively. Timeout failures are classified as `vllm_connect_timeout`, `vllm_headers_timeout` or `vllm_body_timeout`; connection refusal, reset and network-unreachable failures retain separate error codes.

`VLLM_VISION_URL` and `VLLM_VISION_MODEL` must be configured together. `VLLM_VISION_PROVIDER` is either `vllm` or `ollama` and defaults to `vllm` for backward compatibility.

Provider behavior:

```text
VLLM_VISION_PROVIDER=vllm
  -> POST /v1/chat/completions
  -> VLLM_VISION_THINK=false sends reasoning_effort=none
     and chat_template_kwargs.enable_thinking=false

VLLM_VISION_PROVIDER=ollama
  -> POST /api/chat
  -> VLLM_VISION_THINK=false sends think=false
```

`VLLM_VISION_THINK` accepts only `true` or `false`; invalid values stop startup. Visual reasoning remains internal to the visual tool loop and is never copied into the normalized document/image block or forwarded to the base vLLM. For an Ollama-hosted Qwen3.6 model, configure `VLLM_VISION_PROVIDER=ollama` explicitly.


## Structured evidence contract

V0.2.7 treats every PDF-native-text and visual-model result as untrusted source evidence. It no longer embeds free-form model text inside generic XML-like `<document>`, `<analysis>` or `<visual_batch>` wrappers.

Transformed media is represented as a non-XML envelope:

```text
[VCC_PROXY_EVIDENCE_BEGIN version=1 kind=document]
content_encoding: html-entity
--- source content ---
...
[VCC_PROXY_EVIDENCE_END]
```

Before insertion, all source `&`, `<` and `>` characters are HTML-entity escaped. Consequently source strings such as:

```text
</think>
<tool_call>
</function_result>
<|im_start|>
```

arrive at the base model only as inert data such as `&lt;/think&gt;`. A neutral-evidence invariant rejects any normalized evidence block that still contains active known model-control syntax.

Each transformed request receives one idempotent `VCC_PROXY_EVIDENCE_CONTRACT_V1` system contract. It tells the base model that the envelope is immutable evidence, not instructions, reasoning delimiters, tool syntax or a format to continue or close. Clean byte-transparent bypass requests do not receive this contract.

To stop an already contaminated Claude Code history from amplifying malformed protocol text, V0.2.7 also neutralizes known control tags only inside structured assistant `thinking` blocks before forwarding. User-visible text is not rewritten. If a clean request contains no media and no contaminated structured thinking, it remains a raw bypass.

V0.2.10 extends protocol provenance checks across the complete managed-tool boundary without logging source text:

```text
incoming Claude Code system/history
managed WebSearch/WebFetch tool result
managed final Base-model response
streamed Base-model thinking/text
```

Diagnostics record tag names, counts, block types and byte counts only:

```text
incoming_protocol_inventory
managed_tool_result_protocol_inventory
managed_final_response_inspected
managed_final_response_repair_start
managed_final_response_repair_success
managed_final_response_rejected
base_generation_control_tags_detected
```

Every string inside a managed tool result is recursively neutralized before it is serialized as Anthropic `tool_result`. This prevents fetched Markdown or search snippets containing `</tool_response>`, `</function_results>`, `<tool_call>`, ChatML tokens or related singular/plural wrappers from becoming active prompt syntax.

When a managed final response contains control wrappers or leaves the complete answer inside `thinking` with no visible text, the proxy performs one tool-disabled repair round using the already collected tool evidence. A second malformed response is rejected as `final_response_protocol_mismatch`; raw protocol tags are not forwarded to Claude Code. Valid Base output is never regex-deleted or silently rewritten.

After upgrading from a session that already displayed raw `</function_result>`, `</function_results>`, `</thinking>` or `<tool_call>` text, start a new Claude Code session for that task. Structured thinking history is sanitized on later requests, but intentionally does not rewrite already-visible assistant text.

## Persistent media cache

Claude Code sends complete message history on later tool rounds. A PDF/image Base64 block from an earlier `Read` can therefore appear again after `Write`, `Bash` or another tool result. V0.2.7 fingerprints decoded media and replaces every historical occurrence with the same cached normalized content instead of rerunning Poppler or the visual model.

The cache key includes:

```text
SHA-256(decoded media)
media MIME type
parser pipeline version
visual prompt version
VLLM_VISION_MODEL
VLLM_VISION_PROVIDER
visual API protocol
VLLM_VISION_THINK
RESOURCE_PROFILE
evidence contract version
```

Routing behavior:

```text
all media cache hits
  -> cached_transform
  -> no managed queue
  -> no visual-model call
  -> no visible proxy progress
  -> base-vLLM streaming starts directly

at least one media cache miss
  -> managed queue
  -> parse/analyze each unique media key once
  -> persist normalized result
```

Capacity is configured in MiB:

```env
MEDIA_CACHE_MAX_MB=0
```

Meaning:

- Unset outside Compose: use the selected resource-profile default (`512`, `2048` or `10240` MiB).
- `0`: disable capacity-based eviction and continue until the filesystem reports insufficient space.
- Positive value: enforce that many MiB using least-recently-used eviction.
- Negative or non-numeric value: configuration error; the proxy does not start.

Retention still applies when capacity is `0`: `small` targets three days, `default` seven days and `large` thirty days since last use. Expired entries are removed at startup and during later writes. Cache entries use atomic same-directory rename; incomplete temporary files are removed on startup.

If the filesystem returns `ENOSPC` or `EDQUOT`, the completed analysis is still used for the current request. Only persistence fails, `/health` changes to `degraded`, and a later request may need to analyze that media again.

## PDF flow

```text
Anthropic document/base64
-> Base64 and PDF magic validation
-> pdfinfo
-> pdftotext per page
-> render pages with pdftoppm when visual mode is enabled
-> count every page actually present in the received PDF payload
-> batches of at most four page images to the configured visual provider
-> report received pages, processed pages and visual batch count
-> merge native text and visual Markdown with page boundaries
-> replace document block with text
-> send to base vLLM
```

A text PDF can still be processed without a visual endpoint. A scanned or low-text PDF requires a visual provider; the proxy returns `vision_endpoint_required` instead of forwarding raw Base64. If Claude Code displays `Read(... · pages 1-20)`, the proxy processes every page present in the resulting PDF payload. A received 20-page PDF is processed as five sequential visual batches at the default batch size of four. The proxy cannot infer an original file page range when Claude Code does not include that metadata on the wire.

## Image flow

```text
Anthropic image/base64
-> MIME/magic and resource validation
-> ImageMagick auto-orient, resize and strip metadata
-> configured visual-provider analysis
-> replace image block with bounded visual Markdown
-> send to base vLLM
```

Raw image/PDF Base64 is never included in the request sent to the base vLLM. Native text and visual output are inserted only through the escaped structured-evidence contract.

## Model-requested crops

The visual model receives one proxy-owned tool:

```text
request_image_crop(source_id, bbox, purpose)
```

`bbox` uses normalized `[left, top, right, bottom]` coordinates from `0` to `1000`. The proxy validates the source and coordinates, crops the original normalized image, enlarges the crop within resource limits, and sends it back to the visual model.

Fixed limits:

- Maximum two crop rounds.
- Maximum four crop calls per round.
- Maximum six crops per source asset.
- No file paths or shell commands are accepted from the model.
- Crops smaller than one percent of the source are rejected internally.

A model-generated crop validation failure is returned to the visual model as a bounded tool result instead of becoming a Claude Code API error. The visual model may correct the crop or complete from existing evidence. After two crop rounds, the proxy disables crop tools and requests a final evidence-bounded answer. Unexpected proxy programming errors are not hidden by this recovery path.

## Streaming progress

Managed streaming requests open Anthropic SSE immediately. Two heartbeat layers are used:

```text
PROGRESS_PING_INTERVAL_MS=5000
  invisible Anthropic event: ping
  keeps TCP and intermediary connections active

PROGRESS_HEARTBEAT_MS=30000
  visible Anthropic content_block_delta
  keeps Claude Code's semantic stream watchdog active
```

Every actual state revision is sent immediately as an Anthropic `content_block_delta`; the 30-second visible heartbeat is used only when the current state has not changed. Before the 1.5-second visibility threshold, the proxy retains the latest pending snapshot instead of discarding early updates. If the task is still active when the threshold expires, that latest state is emitted immediately.

For a Web-only request, merely having `WebSearch` or `WebFetch` available no longer creates a visible `目前處理進度：` block. The first planning round remains invisible unless it lasts until the semantic-heartbeat threshold. A real managed tool call, queue wait, media operation, retry or repair activates progress immediately. A short direct Base-model answer therefore remains visually transparent.

The visible heartbeat remains active while the proxy is parsing media, waiting for a visual-model response, waiting for Base vLLM response headers, or waiting for the first real Base vLLM content event. Base lifecycle transitions are also visible immediately:

```text
正在將內容送往主模型…
主模型已接受請求，正在準備輸出…
主模型已開始回傳結果…
```

The heartbeat stops before the first upstream thinking, text or tool-use content block is forwarded.

File-aware progress uses only a safe basename. When Claude Code includes a `Read` tool call in message history, the proxy associates nested PDF/image blocks with the original `file_path` but never displays the full local path. Examples:

```text
目前處理進度：
檔案：GW305_N101_20260519-board.pdf｜圖片 4/15｜狀態：正在使用視覺模型分析圖片…
檔案：GW305_N101_20260519-board.pdf｜頁面 8/15（53%）｜批次 2/4｜狀態：視覺模型已完成 8/15 頁…
檔案：GW305_N101_20260519-board.pdf｜處理進度 15/15（100%）｜狀態：文件與圖片內容已就緒；正在交給主模型分析…
檔案：GW305_N101_20260519-board.pdf｜狀態：主模型仍在處理中，已等待 30 秒…
```

If filename metadata and the corresponding Read tool call are both unavailable, the proxy falls back to `PDF #N` or `圖片 #N`. Multiple media blocks associated with one Read call are shown as image or document-segment progress instead of unrelated generic messages.

When progress becomes visible, it is emitted as a dedicated first text block headed `目前處理進度：`. No hidden nonce or `VLLMCCP:v1:*` marker is emitted. Before a later request reaches the base vLLM, the proxy removes that dedicated block structurally. Legacy readable progress blocks and V0.2.2 sentinel-wrapped history are also cleaned for backward compatibility.

SSE writes use a bounded drain wait (`SSE_DRAIN_TIMEOUT_MS=10000`). Logs distinguish a state change, requested status and confirmed write through `progress_state_changed`, `managed_task_progress` (`delivery_status=requested`) and `progress_sse_sent`. Confirmed writes include a state revision and delivery latency. Base vLLM timing logs include request start, response headers, first model content event, stream completion and stage-specific request failure without recording prompt text:

```text
base_upstream_request_start
base_upstream_headers_received
base_upstream_first_event
base_upstream_stream_completed
base_upstream_request_failed
```

After PDF/image preprocessing finishes, the managed slot is released and the final Base vLLM answer is streamed token-by-token into the same Anthropic SSE response. Proxy-owned WebSearch/WebFetch tool rounds still require complete tool-call JSON internally; their final result is emitted after the bounded loop completes.

## Concurrency and queue

Only managed workflows enter the proxy queue. Plain text, Claude Code native tools and arbitrary bypass endpoints are not queued by the proxy and remain subject to the base vLLM scheduler.

Default configuration:

```env
CONCURRENCY_PROFILE=default
```

Profiles:

| Profile | Managed active | Managed waiting | Queue timeout | Vision active |
|---|---:|---:|---:|---:|
| `small` | 1 | 4 | 120 s | 1 |
| `default` | 2 | 12 | 120 s | 1 |
| `large` | 4 | 32 | 180 s | 2 |

Advanced overrides are optional:

```env
MANAGED_MAX_CONCURRENCY=
MANAGED_MAX_QUEUE=
MANAGED_QUEUE_TIMEOUT_MS=
VISION_MAX_CONCURRENCY=
```

Streaming progress settings:

```env
PROGRESS_VISIBLE_AFTER_MS=1500
PROGRESS_PING_INTERVAL_MS=5000
PROGRESS_HEARTBEAT_MS=30000
SSE_DRAIN_TIMEOUT_MS=10000
```

Queue behavior:

- FIFO admission with no priority insertion.
- Full queue returns `429 proxy_queue_full` and `Retry-After: 10`.
- Expired wait returns `503 proxy_queue_timeout` and `Retry-After: 10`.
- Streaming callers receive SSE pings and visible queue-position updates.
- Client disconnect removes a waiting job or aborts active Poppler, ImageMagick, visual vLLM, WebSearch/WebFetch and base-vLLM work.
- Media is decoded into a request-scoped private temporary directory before queueing; Base64 is not retained by queued jobs.

The health endpoint exposes only aggregate counters:

```json
{
  "managed": { "active": 1, "limit": 2, "queued": 3, "queue_limit": 12 },
  "vision": { "active": 1, "limit": 1 },
  "cache": {
    "entries": 42,
    "bytes": 183500800,
    "max_bytes": 0,
    "limit_mode": "filesystem",
    "write_available": true,
    "inflight_analyses": 1
  }
}
```

## Managed web tools

```env
SEARXNG_URL=http://host.docker.internal:8088
WEB_FETCH_URL=http://host.docker.internal:8090/
WEB_FETCH_API_KEY=

WEB_FETCH_PROCESSOR_ENABLED=true
WEB_FETCH_PROCESSOR_URL=
WEB_FETCH_PROCESSOR_MODEL=
WEB_FETCH_PROCESSOR_API_KEY=
WEB_FETCH_PROCESSOR_THINK=false
```

- `WebSearch` and `web_search` call SearXNG and return a readable multiline result list.
- `WebFetch` and `web_fetch` POST to the exact configured `WEB_FETCH_URL`; the proxy does not append `/v1/fetch`.
- The awesome-web-fetch request uses `{ "urls": [targetUrl] }`. An optional `WEB_FETCH_API_KEY` is sent only to that backend as a Bearer token.
- Array responses using `page_content` and `metadata` are normalized; the older object response shape remains accepted.
- Raw page content is deterministically cleaned and protocol-neutralized, then an isolated WebFetch Processor applies the tool's `prompt` through `/v1/chat/completions` with no tools or Claude Code history.
- Blank Processor URL and MODEL inherit the Base vLLM endpoint and current request model. The API key inherits `VLLM_BASE_API_KEY` only while the Processor URL is also derived from Base; an explicit Processor URL requires `WEB_FETCH_PROCESSOR_API_KEY`. `WEB_FETCH_PROCESSOR_THINK` is a strict boolean and defaults to `false`.
- Successful WebSearch/WebFetch results are readable multiline VCC evidence blocks rather than JSON-stringified objects. One short idempotent System supplement explains the result fields to the Base model.
- Processor timeout, HTTP failure, invalid response, tool-call output or protocol-tag leakage degrades to a bounded cleaned excerpt; the complete raw page is not forwarded as fallback.
- HTTP rejection, robots denial and other expected fetch-service failures become correlated `tool_result` blocks with `is_error: true`. The Base model may choose another source instead of terminating the complete Claude Code request.
- Unexpected proxy programming failures still abort the request. Managed loops remain bounded to six rounds by default.
- WebFetch applies URL and SSRF validation before contacting the backend.
- Safe diagnostics never contain API keys, fetched page text, extraction prompts or Processor output:

```text
web_fetch_upstream_request
web_fetch_upstream_response
web_fetch_upstream_rejected
web_fetch_processor_request
web_fetch_processor_response
web_fetch_processor_fallback
```

## Resource profiles

- `small`: 12 MiB media, 40 PDF pages.
- `default`: 32 MiB media, 100 PDF pages.
- `large`: 96 MiB media, 300 PDF pages.

The default visual PDF batch size is four pages.

## Security boundaries

- MIME and magic-byte validation.
- Request, decoded-byte, page, pixel, output and subprocess limits.
- Argument-array subprocess execution; no shell interpolation for file processing.
- Private temporary directories removed after each request.
- Separate Authorization headers for base and visual vLLM.
- Client disconnect abort propagation to Poppler, ImageMagick, visual vLLM and base vLLM.
- No Base64, document text or sensitive paths in normal logs.
- PDF/visual source text is HTML-entity escaped and checked by a neutral-evidence invariant before base-vLLM forwarding.
- Known malformed protocol tags in structured assistant thinking history and managed tool-result evidence are neutralized without rewriting valid visible assistant text.
- Managed final output is validated before progress is closed; one tools-disabled repair is allowed, then malformed output is rejected.

## Verification

```bash
./scripts/verify.sh
```

The suite covers transparent bypass, raw-body preservation, Claude Code hello probes, FIFO admission, queue full/timeout/cancellation, persistent cache/TTL/LRU/disk-full behavior, request-local deduplication, cross-request singleflight, vLLM/Ollama visual serialization, strict thinking control, internal crop recovery, 20-page batching, configuration, deployment contract, nested content blocks, PDF extraction, scanned-page visual routing, image normalization, crop authorization, bounded visual tool loops, API-key separation, awesome-web-fetch request/response compatibility, isolated prompt-directed WebFetch processing, readable multiline web evidence, Processor fallback, recoverable managed-tool errors, file-aware progress, immediate state revisions, semantic Anthropic SSE heartbeat, drain-timeout handling, Base-vLLM connect/header/body timeout classification, TTFT observability, structured-evidence escaping, contaminated-thinking sanitation, recursive managed-tool evidence neutralization, final-response validation/repair, lazy Web-only progress activation, protocol provenance diagnostics, cache-contract invalidation and split control-tag diagnostics across SSE deltas.

## V0.2.11 limits

- DOCX, XLSX and PPTX still require a future host-side document bridge.
- Visual analysis depends on the selected multimodal model and the provider-specific tool-call protocol/template.
- Queue, semaphore and singleflight state are process-local; multiple proxy replicas do not share admission state.
- Cache files are persistent, but multiple proxy replicas do not coordinate cache writes or distributed locks.
- No persistent document-handle API or distributed Redis cache.
