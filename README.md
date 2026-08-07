# VLLM-CC-TOOLS-PROXY

`VLLM-CC-TOOLS-PROXY` is a transparent Claude Code gateway for local vLLM. V0.2.19.3 bypasses ordinary traffic directly to the base vLLM, intercepts PDF/image content or proxy-owned WebSearch/WebFetch workflows, and persistently reuses normalized media analysis across later Claude Code turns.

## V0.2.19.3 architecture

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

## V0.2.19.2 deterministic final promotion and tool-description isolation

## V0.2.19.3 WebFetch Processor provider routing

V0.2.19.3 adds explicit `WEB_FETCH_PROCESSOR_PROVIDER=vllm|ollama` routing while keeping the OpenAI-compatible `/v1/chat/completions` wire format. Root/base Processor URLs are expanded automatically, so `http://192.168.10.169:11434` becomes `http://192.168.10.169:11434/v1/chat/completions`. Complete endpoints and existing custom non-root paths are preserved.

For `vllm`, thinking control uses `chat_template_kwargs.enable_thinking`. For `ollama`, the OpenAI-compatible request uses `reasoning_effort=none` when `WEB_FETCH_PROCESSOR_THINK=false` and `reasoning_effort=high` when true. URL, API key, model, 3-slot concurrency and timeout remain independently configurable.

V0.2.19.2 adds a strict fast path for Laguna/Poolside responses where the model has already completed the user answer but `poolside_v1` returns it only as a `thinking` block. If the response is `end_turn`, thinking-only, has no tool calls, no active protocol tags, has answer-like structure, and contains no continuation intent, the proxy promotes that text directly into one visible Anthropic `text` block. No second Base-model recovery call is made. Unsafe cases keep the existing final-channel or continuation recovery path.

Claude Code tool documentation can itself contain literal protocol examples such as `<thinking>...</thinking>` and `<tool_call>`. Before tool definitions reach the Base vLLM, V0.2.19.2 recursively neutralizes active control tags only in fields named `description`, including nested JSON-schema descriptions. Tool names, enums, defaults, schema values and ordinary user text are preserved exactly.

New content-free diagnostics are `managed_final_response_promoted` and `protocol_tool_descriptions_sanitized`; `incoming_protocol_inventory` also reports tool-definition tag counts.

## V0.2.19.1 parallel WebFetch and slow-model budgets

V0.2.19.1 is a stability hotfix for local models that are correct but slow. It keeps the V0.2.19 protocol validation/recovery gates and changes managed research scheduling rather than simply shortening timeouts.

### Parallel WebFetch Processor

Independent managed tool calls from the same model round execute concurrently and preserve tool-result order. WebFetch Processor inference is protected by one proxy-wide semaphore, so the total number of Processor model requests across all Claude Code sessions never exceeds:

```env
WEB_FETCH_PROCESSOR_CONCURRENCY=3
```

The value is strictly bounded to `1..3` and defaults to `3`. A fourth Processor request waits for a global slot. Web page downloads may overlap; the semaphore is acquired only for the Processor model request.

Processor routing remains independently configurable:

```env
WEB_FETCH_PROCESSOR_PROVIDER=vllm
WEB_FETCH_PROCESSOR_URL=
WEB_FETCH_PROCESSOR_API_KEY=
WEB_FETCH_PROCESSOR_MODEL=
WEB_FETCH_PROCESSOR_THINK=false
WEB_FETCH_PROCESSOR_CONCURRENCY=3
WEB_FETCH_PROCESSOR_TIMEOUT_MS=300000
WEB_FETCH_PROCESSOR_TIMEOUT_MS=300000
```

`WEB_FETCH_PROCESSOR_PROVIDER` accepts `vllm` or `ollama` and defaults to `vllm`. A Processor base URL such as `http://192.168.10.169:11434` is normalized to `/v1/chat/completions`; an already complete `/v1/chat/completions` endpoint is preserved. A blank Processor URL derives `/v1/chat/completions` from `VLLM_BASE_URL`. A blank Processor MODEL uses the current Base request model. `VLLM_BASE_API_KEY` is inherited only when the Processor URL is also derived from Base; an explicitly configured Processor URL requires its own `WEB_FETCH_PROCESSOR_API_KEY` when authentication is needed.

### Slow-model managed budgets

Defaults are increased to:

```env
MANAGED_TASK_TIMEOUT_MS=1800000
MANAGED_MODEL_ROUND_TIMEOUT_MS=360000
```

This gives a managed workflow a 30-minute hard safety cap while allowing an individual Base-model round up to 6 minutes. Loop protection still comes from `MAX_TOOL_ROUNDS`, exact repeated-action detection, protocol validation and recovery, not from aggressively killing a slow but progressing model.

When completed managed evidence exists and the remaining hard-cap budget falls to one model-round budget or less, the proxy removes only WebSearch/WebFetch from the next Base request and emits `managed_final_round_reserved`. Claude Code client tools such as Read/Write/Bash remain available, so the model can continue implementation or return a final response instead of spending the final budget on more research.

### WebSearch argument normalization

Some local models emit a single domain as a string even when Claude Code's WebSearch schema requires an array. Before proxy execution or mixed-tool handoff, V0.2.19.1 normalizes:

```text
allowed_domains: "docs.openssl.org" -> ["docs.openssl.org"]
blocked_domains: "example.com"      -> ["example.com"]
```

Existing arrays are preserved. This prevents an otherwise valid WebSearch action from failing Claude Code input validation.

V0.2.19.1 still does not emulate Anthropic Native Web Search result/citation counters; that remains planned separately.

## V0.2.19 managed stability gates

V0.2.19 hardens the proxy-side managed execution loop used for WebSearch/WebFetch and media-assisted turns. It does **not** implement Anthropic-native Web Search result/citation emulation; that remains a separate compatibility layer.

### 1. Validate every managed Base response

V0.2.18 only entered final-response recovery when the Base response contained no structured `tool_use`. V0.2.19 runs the same protocol validation gate for **all** managed Base responses before any tool is dispatched.

A response containing a valid structured `tool_use` plus leaked raw protocol markup in `thinking`/visible output is therefore rejected and recovered before the tool can execute. Structured tool arguments themselves remain data and may legitimately contain strings such as parser examples.

### 2. Continuation recovery is non-thinking and state-aware

Continuation recovery keeps the original tools and `tool_choice`, but now forces:

```json
{"chat_template_kwargs":{"enable_thinking":false,"preserve_thinking":false}}
```

The previous incomplete model state is copied into the recovery request only as a bounded, control-tag-neutralized data excerpt. This prevents the recovery call from restarting blind while also preventing raw `<tool_call>`, `<arg_key>`, `<arg_value>`, `<think>` and related markup from becoming active prompt syntax.

For Laguna S 2.1 on vLLM, the expected runtime pair is:

```text
--tool-call-parser poolside_v1
--reasoning-parser poolside_v1
```

When a managed response shows control-tag leakage or a final answer trapped only in reasoning, the proxy emits the content-free diagnostic `laguna_runtime_contract_violation` with the expected parser names and observed anomaly counts. This is observational telemetry; the proxy does not claim to introspect vLLM command-line flags remotely.

### 3. Claude Code `tool_result` history is isolated

Incoming Claude Code tool results are untrusted evidence. V0.2.19 recursively neutralizes known model-control tags inside `tool_result.content` before forwarding history to the Base model, including nested text arrays and string payloads. Ordinary user text is not rewritten.

This extends the existing quarantine boundary beyond proxy-owned WebSearch/WebFetch results to Read/Bash/MCP and other Claude Code tool-result content.

### 4. Exact repeated managed actions stop as no progress

If two consecutive managed rounds request the exact same managed tool name and equivalent arguments, the second action is not executed. The request fails with:

```text
managed_no_progress
```

This prevents repeated WebSearch/WebFetch calls from consuming the remaining round budget without adding evidence. The normal `MAX_TOOL_ROUNDS` limit still applies to changing actions.

### 5. Bounded model rounds and bounded managed tasks

One additional simple override is available:

```env
MANAGED_TASK_TIMEOUT_MS=1800000
```

Defaults:

```text
entire managed task: 1800000 ms (30 minutes)
one Base-model managed round: 360000 ms (6 minutes)
```

The model-round cap is configurable with `MANAGED_MODEL_ROUND_TIMEOUT_MS`. The effective round budget is always the smaller of that value and the remaining task budget.

Timeout codes:

```text
managed_model_timeout
  one Base-model round exceeded its bounded generation window

managed_task_timeout
  the complete proxy-managed workflow exhausted its total deadline
```

The total deadline also bounds proxy-owned tool execution. These limits are independent of the more general `VLLM_BASE_HEADERS_TIMEOUT_MS` / `VLLM_BASE_BODY_TIMEOUT_MS` transport protections.

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

V0.2.19 applies the same control-tag quarantine to **incoming Claude Code `tool_result` history** before any transformed request is sent to the Base model. The rewrite is limited to tool-result payloads and malformed assistant reasoning; ordinary user-visible text remains byte-preserved.

V0.2.14 no longer treats every thinking-only response as a completed final answer. Invalid no-tool responses are routed conservatively: only a substantial structured answer with no continuation intent enters short final-channel recovery; unfinished reasoning, next-step planning, missing visible output and ambiguous content enter continuation recovery with the original tools preserved. A second invalid response is rejected as `response_recovery_exhausted`; raw protocol tags are not forwarded to Claude Code. Valid Base output is never regex-deleted or silently rewritten.

After upgrading from a session that already displayed raw `</function_result>`, `</function_results>`, `</thinking>` or `<tool_call>` text, start a new Claude Code session for that task. Structured thinking history is sanitized on later requests, but intentionally does not rewrite already-visible assistant text.





## V0.2.18 response-side native web containment

V0.2.17 normalized Anthropic native Web Search/Web Fetch definitions on the request path. V0.2.18 completes the reverse path so Base-model native server-tool blocks cannot escape into Claude Code's native Web Search UI.

For every buffered managed Base response, the proxy now applies this containment before final-response inspection or recovery:

```text
server_tool_use:name=web_search
  -> internal tool_use:name=web_search
  -> execute SearXNG locally
  -> correlated local tool_result
  -> next Base-model round

server_tool_use:name=web_fetch
  -> internal tool_use:name=web_fetch
  -> execute awesome-web-fetch locally
  -> correlated local tool_result
  -> next Base-model round

web_search_tool_result / web_fetch_tool_result
  -> removed from the Base response
  -> never forwarded to Claude Code
```

The normalized assistant history contains only the internal `tool_use` blocks actually executed by the proxy. Native result blocks supplied by the Base endpoint are discarded because they do not represent the local SearXNG or awesome-web-fetch execution result.

If one Base response contains a response-side Native Web call together with a Claude Code tool such as `Read`, `Write`, `Edit`, `Bash` or `Task`, the proxy executes the Native Web call first and defers the unrelated tool block. The next Base round receives the real web evidence and may emit the Claude Code tool again. This avoids returning a `web_search` block to Claude Code merely because the model attempted parallel tool calls. The safe diagnostic event is:

```text
native_web_mixed_tool_deferred
```

Every contained response emits a content-free diagnostic summary:

```text
native_web_response_contained
```

It records only the managed round, Native Server Tool count, removed Native Result count and original block-type names. It does not log query text, URLs, fetched content or credentials.

The final Anthropic SSE emitter and non-stream response path apply an additional containment filter. The following block types are therefore forbidden in the response returned to Claude Code:

```text
server_tool_use:web_search
server_tool_use:web_fetch
web_search_tool_result
web_fetch_tool_result
```

Consequently Claude Code should not render the native status line `Did 0 searches`. Search/fetch progress remains the proxy's own readable progress text, and the final user-visible response contains only normal text, thinking or Claude Code tool blocks.

## V0.2.17 native web tool normalization

Claude Code may send Anthropic server-tool definitions instead of ordinary custom tools:

```json
{"type":"web_search_20250305","name":"web_search","max_uses":8}
{"type":"web_fetch_20250910","name":"web_fetch","max_uses":5}
```

These definitions intentionally have no `input_schema`, because Anthropic executes them as server tools. A local vLLM Anthropic-compatible endpoint commonly validates every tool as a custom tool and rejects the request before model generation.

V0.2.17 detects any dated `web_search_*` or `web_fetch_*` type, extracts its local policy, and sends a vLLM-compatible custom definition to both:

```text
/v1/messages/count_tokens
/v1/messages
```

The normalized definitions contain:

```text
web_search → required query string
web_fetch  → required URL plus optional prompt
```

Native-only fields such as `type`, `max_uses`, `allowed_domains`, `blocked_domains`, `user_location`, `citations`, and `max_content_tokens` are never forwarded to vLLM. The proxy applies the supported local policies instead:

- `max_uses` counts every attempted managed invocation, including failed fetch/search attempts.
- `allowed_domains` and `blocked_domains` filter WebSearch results and validate WebFetch targets.
- Domain rules include subdomains; WebSearch rules may also include a path prefix.
- `max_content_tokens` becomes a conservative four-characters-per-token WebFetch output ceiling, further bounded by the configured resource profile.
- `citations` and `user_location` are retained as request metadata but are not emulated as Anthropic-native citations or localized search controls.
- Newer dynamic-filtering and `allowed_callers` fields are removed from the vLLM request and counted as unsupported policy metadata in diagnostics.

Existing custom `WebSearch`, `web_search`, `WebFetch`, `web_fetch`, and all non-web tools remain unchanged. If a native and custom alias coexist, the existing custom definition is retained and the native policy still applies locally.

A successful normalization emits only metadata:

```text
native_web_tools_normalized
```

The event records tool counts and policy presence, not domains, URLs, prompts, search results, fetched content, or credentials.

## V0.2.16 Anthropic usage preservation

Claude Code uses Anthropic `usage` metadata to estimate the current context and decide when automatic compaction should run. Earlier managed streams opened a synthetic Anthropic `message_start` immediately for progress reporting but set:

```json
{"usage":{"input_tokens":0,"output_tokens":0}}
```

Because Anthropic input usage belongs to the first `message_start`, a later Base-model response could not legally repair that value. V0.2.16 performs one lightweight token preflight before opening a streamed managed response:

```text
POST /v1/messages/count_tokens
  -> input_tokens
  -> synthetic message_start.usage.input_tokens
  -> normal managed model/tool workflow
```

The downstream initial usage preserves the Anthropic-compatible fields when supplied:

```text
input_tokens
cache_creation_input_tokens
cache_read_input_tokens
output_tokens
server_tool_use
```

For local vLLM deployments without Anthropic prompt caching, the cache fields remain zero. The final `message_delta` continues to carry the real `output_tokens` from the Base-model response.

Direct transformed streaming still emits exactly one downstream `message_start`. The proxy observes the upstream `message_start` and `message_delta` usage for diagnostics, compares the upstream input count with the preflight count, and forwards the upstream content events with their original indexes shifted only when a visible progress block exists.

Safe token-only diagnostics:

```text
managed_usage_preflight_succeeded
  input_tokens=...
  cache_creation_input_tokens=...
  cache_read_input_tokens=...
  total_input_tokens=...

managed_usage_preflight_failed
  code=...
  retryable=...

managed_response_usage_observed
managed_stream_usage_observed
  preflight_input_tokens=...
  upstream_input_tokens=...
  input_token_delta=...
  output_tokens=...
```

A missing or unsupported `/v1/messages/count_tokens` endpoint does not terminate the Claude Code turn. The proxy logs `managed_usage_preflight_failed`, emits a zero-valued fallback usage object, and continues the original model/tool workflow. For reliable Claude Code automatic compaction, the Base vLLM endpoint should implement the token-count route.

For a 224,000-token local context with `CLAUDE_CODE_MAX_OUTPUT_TOKENS=16384`, a 200,000-token compact threshold leaves only 7,616 tokens for one large tool result before the next request can overflow. The recommended operational value is:

```bash
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=180000
```

This leaves approximately 27,616 tokens of headroom for the requested output and a large Read/Bash/WebFetch result. V0.2.16 does not modify Claude Code history or invoke compaction itself; it restores the usage signal Claude Code needs to make that decision.

No additional ENV setting is introduced.

## V0.2.15 proxy-turn progress semantics

Progress text describes the current proxy/model turn. It does not claim that the complete Claude Code task has finished.

Buffered managed responses are classified before the progress block closes:

```text
response contains one non-managed tool call
  -> 主模型已產生下一步 Write；正在交還 Claude Code 執行…
  -> phase: handoff_to_claude_code

response contains multiple non-managed tool calls
  -> 主模型已產生下一步工具；正在交還 Claude Code 執行…
  -> phase: handoff_to_claude_code

response contains visible text and no tool call
  -> 主模型已完成本輪回答；正在回傳結果…
  -> phase: returning_visible_response

other valid model output
  -> 主模型已完成本輪輸出；正在回傳結果…
  -> phase: returning_model_output
```

Structured state distinguishes the two completion scopes:

```text
terminal_for_proxy=true
  the current proxy API turn can be returned

terminal_for_claude_task=false
  the proxy does not claim Claude Code's outer task is finished
```

For direct upstream streaming, the first model content block closes visible progress with a non-terminal streaming phase:

```text
text      -> streaming_visible_response
thinking  -> streaming_thinking
tool_use  -> streaming_tool_action
other     -> streaming_model_output
```

Generic semantic heartbeats use:

```text
主模型仍在處理本輪請求，已等待 30 秒…
```

File-aware heartbeats retain the safe filename while using the same current-turn wording. V0.2.15 changes only progress copy and structured progress phases; V0.2.14 Tool Routing and Recovery Routing remain unchanged.


## V0.2.14 recovery routing

The proxy remains subordinate to Claude Code's outer agent loop. It executes only proxy-owned WebSearch/WebFetch calls and must not decide that the complete Claude Code task is finished merely because one Base-model turn ended in `thinking`.

The no-tool recovery state machine is:

```text
invalid no-tool Base response
  ├─ completed structured answer, no continuation intent
  │    -> Final-channel recovery
  │    -> short context only
  │    -> chat_template_kwargs.enable_thinking=false
  │    -> tools and tool_choice removed
  │    -> visible final text only
  │
  └─ unfinished, planning, missing or ambiguous output
       -> Continuation recovery
       -> original conversation and evidence retained
       -> preserves the original tools and tool choice
       -> model must emit one valid next action
```

Continuation recovery may return:

```text
managed WebSearch/WebFetch tool call
  -> proxy executes it and continues the managed loop

Read/Bash/Edit/Task or another non-managed tool call
  -> response is returned unchanged to Claude Code

visible text
  -> returned as the completed response
```

A structured action plan is deliberately not considered a completed answer. Headings such as `Plan` or `Next steps`, imperative tool-oriented list items, explicit search/read/verification intent, or statements that evidence is still missing force the continuation route.

Final-channel recovery is intentionally conservative. It uses a short isolated request containing only the malformed candidate answer, replaces the original System prompt, disables thinking through request-level chat-template kwargs, and prohibits new facts or tool calls.

Recovery is bounded to one additional Base-model call for the invalid response. If that recovery still contains no valid visible answer or tool action, the proxy returns:

```text
response_recovery_exhausted
```

Recovery diagnostics retain the existing V0.2.13 file-based protocol bundles and add route metadata to the safe main-log events:

```text
managed_final_response_repair_start
  recovery_route=final_channel|continuation
  tools_preserved=true|false
  recovery_signals=...

managed_final_response_repair_success
  recovery_route=...
  tool_use_count=...

managed_final_response_recovery_tool_dispatch
  disposition=managed|unmanaged
  tool_names=[...]
```

No additional ENV setting is required.

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
主模型已開始回傳本輪回答…
```

The heartbeat stops before the first upstream thinking, text or tool-use content block is forwarded.

File-aware progress uses only a safe basename. When Claude Code includes a `Read` tool call in message history, the proxy associates nested PDF/image blocks with the original `file_path` but never displays the full local path. Examples:

```text
目前處理進度：
檔案：GW305_N101_20260519-board.pdf｜圖片 4/15｜狀態：正在使用視覺模型分析圖片…
檔案：GW305_N101_20260519-board.pdf｜頁面 8/15（53%）｜批次 2/4｜狀態：視覺模型已完成 8/15 頁…
檔案：GW305_N101_20260519-board.pdf｜處理進度 15/15（100%）｜狀態：文件與圖片內容已就緒；正在交給主模型分析…
檔案：GW305_N101_20260519-board.pdf｜狀態：主模型仍在處理本輪請求，已等待 30 秒…
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
WEB_FETCH_PROCESSOR_PROVIDER=vllm
WEB_FETCH_PROCESSOR_URL=
WEB_FETCH_PROCESSOR_MODEL=
WEB_FETCH_PROCESSOR_API_KEY=
WEB_FETCH_PROCESSOR_THINK=false
```

- `WebSearch` and `web_search` call SearXNG and return a readable multiline result list.
- Anthropic native `web_search_*` and `web_fetch_*` server-tool definitions are normalized into custom schemas before Count Tokens and model calls.
- Native `max_uses` and domain policies are enforced locally and are not forwarded to vLLM.
- `WebFetch` and `web_fetch` POST to the exact configured `WEB_FETCH_URL`; the proxy does not append `/v1/fetch`.
- The awesome-web-fetch request uses `{ "urls": [targetUrl] }`. An optional `WEB_FETCH_API_KEY` is sent only to that backend as a Bearer token.
- Array responses using `page_content` and `metadata` are normalized; the older object response shape remains accepted.
- Raw page content is deterministically cleaned and protocol-neutralized, then an isolated WebFetch Processor applies the tool's `prompt` through `/v1/chat/completions` with no tools or Claude Code history.
- `WEB_FETCH_PROCESSOR_PROVIDER` accepts `vllm` or `ollama`. A root/base Processor URL automatically receives `/v1/chat/completions`; `/v1` receives `/chat/completions`; an already complete endpoint is unchanged. Blank Processor URL and MODEL inherit the Base vLLM endpoint and current request model. The API key inherits `VLLM_BASE_API_KEY` only while the Processor URL is also derived from Base; an explicit Processor URL requires `WEB_FETCH_PROCESSOR_API_KEY`. For provider `vllm`, `WEB_FETCH_PROCESSOR_THINK` maps to `chat_template_kwargs.enable_thinking`. For provider `ollama`, it maps to OpenAI-compatible `reasoning_effort` (`none` when false, `high` when true). `WEB_FETCH_PROCESSOR_THINK` is a strict boolean and defaults to `false`. `WEB_FETCH_PROCESSOR_CONCURRENCY` defaults to 3 and is bounded to 1..3; `WEB_FETCH_PROCESSOR_TIMEOUT_MS` defaults to 300000 ms.
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


## Protocol anomaly diagnostics

Normal logs continue to record only counts, block metadata and repair state. To capture complete malformed fields when the managed final-response guard starts a repair, enable:

```env
LOG_LEVEL=info
LOG_PROTOCOL_SNIPPETS=true
```

`LOG_PROTOCOL_SNIPPETS` remains the only switch and accepts strictly `true` or `false`. V0.2.13 no longer expands anomaly fragments in the main log. Each original or repaired malformed response is written as one atomic JSON file under:

```text
/tmp/vllm-cc-tools-proxy/protocol-snippets
```

The filename is time ordered and includes the request ID, managed round and phase:

```text
20260806T074827.545Z__507e5d7e-121b-4c92-8283-8783bb594e3d__r02__original__a1b2c3d4.json
20260806T074900.120Z__507e5d7e-121b-4c92-8283-8783bb594e3d__r02__repair__e5f6a7b8.json
```

The main log contains only one retrievable reference event:

```text
managed_final_response_diagnostic_file
```

Its safe fields include:

```text
requestId
round
repair
reasons
output_snippet_count
input_snippet_count
file_path
file_bytes
file_sha256
created_at
```

It does not contain the malformed output, surrounding text, System prompt fragment, message-history fragment or Tool Description fragment. If the file cannot be created, the request continues normally and a content-free event is emitted:

```text
managed_final_response_diagnostic_file_failed
```

Each JSON file contains:

- response ID, model, stop reason and content-block types;
- every detected output location with tag, path, offset, line and column;
- the complete redacted anomalous output field in `full_text_redacted`;
- matching System, message-history and Tool Description fields in `full_text_redacted`;
- bounded nearby excerpts and SHA-256 content fingerprints;
- separate `original_response` or `repair_response` phase metadata.

Credentials are redacted before persistence. Bearer values, common API-key/token/password/secret assignments, known key prefixes and URL user information are replaced with `[REDACTED]`. Diagnostic files are created with private permissions and completed using atomic rename, so collectors do not read partially written JSON.

To list and retrieve files from the Compose container:

```bash
docker exec vllm-cc-tools-proxy \
  sh -lc 'ls -lt /tmp/vllm-cc-tools-proxy/protocol-snippets'

docker cp \
  vllm-cc-tools-proxy:/tmp/vllm-cc-tools-proxy/protocol-snippets \
  ./protocol-snippets
```

The directory is inside the container temporary filesystem. It survives a normal process restart in the same container but is not intended as a persistent archive and can disappear when the container is recreated. Copy the files out after reproducing the issue, then disable collection:

```env
LOG_PROTOCOL_SNIPPETS=false
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
- Private media-processing temporary directories are removed after each request.
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

The suite covers request-side and response-side native Web Search/Web Fetch normalization, Native Server Tool containment, mixed-tool deferral, native policy enforcement, explicit Count Tokens compatibility, Anthropic usage normalization, managed `/v1/messages/count_tokens` preflight, auto-compact usage compatibility, non-fatal preflight fallback, direct-stream usage observation, transparent bypass, raw-body preservation, Claude Code hello probes, FIFO admission, queue full/timeout/cancellation, persistent cache/TTL/LRU/disk-full behavior, request-local deduplication, cross-request singleflight, vLLM/Ollama visual serialization, strict thinking control, internal crop recovery, 20-page batching, configuration, deployment contract, nested content blocks, PDF extraction, scanned-page visual routing, image normalization, crop authorization, bounded visual tool loops, API-key separation, awesome-web-fetch request/response compatibility, isolated prompt-directed WebFetch processing, readable multiline web evidence, Processor fallback, recoverable managed-tool errors, file-aware progress, immediate state revisions, semantic Anthropic SSE heartbeat, drain-timeout handling, Base-vLLM connect/header/body timeout classification, TTFT observability, structured-evidence escaping, contaminated-thinking sanitation, recursive managed-tool evidence neutralization, final-response validation/repair, lazy Web-only progress activation, protocol provenance diagnostics, atomic file-based anomaly evidence, cache-contract invalidation and split control-tag diagnostics across SSE deltas.

## V0.2.18 limits

- DOCX, XLSX and PPTX still require a future host-side document bridge.
- Visual analysis depends on the selected multimodal model and the provider-specific tool-call protocol/template.
- Queue, semaphore and singleflight state are process-local; multiple proxy replicas do not share admission state.
- Cache files are persistent, but multiple proxy replicas do not coordinate cache writes or distributed locks.
- No persistent document-handle API or distributed Redis cache.
