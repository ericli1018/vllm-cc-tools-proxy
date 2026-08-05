# VLLM-CC-TOOLS-PROXY

`VLLM-CC-TOOLS-PROXY` is a transparent Claude Code gateway for local vLLM. V0.2.5 bypasses ordinary traffic directly to the base vLLM, intercepts PDF/image content or proxy-owned WebSearch/WebFetch workflows, and persistently reuses normalized media analysis across later Claude Code turns.

## V0.2.5 architecture

```text
Claude Code
  -> vllm-cc-tools-proxy:8080
       ├─ local Poppler: PDF metadata, native text, page rendering
       ├─ local ImageMagick: validation, normalization, bounded crops
       ├─ visual vLLM: OCR, tables, charts, diagrams, UI and photographs
       ├─ SearXNG / awesome-web-fetch: managed WebSearch and WebFetch
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

VLLM_VISION_URL=http://host.docker.internal:8001
VLLM_VISION_MODEL=Qwen/Qwen3-VL-30B-A3B-Instruct
VLLM_VISION_API_KEY=
```

`VLLM_BASE_URL` points to an Anthropic Messages-compatible vLLM endpoint. The proxy sends the base key only to this endpoint.

`VLLM_VISION_URL` points to an OpenAI-compatible vLLM server. The proxy calls `/v1/chat/completions` and sends the vision key only to this endpoint. `VLLM_VISION_URL` and `VLLM_VISION_MODEL` must be configured together.

## Persistent media cache

Claude Code sends complete message history on later tool rounds. A PDF/image Base64 block from an earlier `Read` can therefore appear again after `Write`, `Bash` or another tool result. V0.2.5 fingerprints decoded media and replaces every historical occurrence with the same cached normalized content instead of rerunning Poppler or the visual model.

The cache key includes:

```text
SHA-256(decoded media)
media MIME type
parser pipeline version
visual prompt version
VLLM_VISION_MODEL
RESOURCE_PROFILE
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
-> batches of at most four page images to visual vLLM
-> merge native text and visual Markdown with page boundaries
-> replace document block with text
-> send to base vLLM
```

A text PDF can still be processed without a visual endpoint. A scanned or low-text PDF requires visual vLLM; the proxy returns `vision_endpoint_required` instead of forwarding raw Base64.

## Image flow

```text
Anthropic image/base64
-> MIME/magic and resource validation
-> ImageMagick auto-orient, resize and strip metadata
-> visual vLLM analysis
-> replace image block with bounded visual Markdown
-> send to base vLLM
```

Raw image/PDF Base64 is never included in the request sent to the base vLLM.

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
- Crops smaller than one percent of the source are rejected.

## Streaming progress

Managed streaming requests open Anthropic SSE immediately so the connection remains alive, but the proxy does not create a visible progress text block for every request. Invisible `ping` events continue through queueing, PDF/image processing, visual-model calls, base-vLLM time-to-first-token and pauses in the final token stream. A frame-safe multiplexer inserts pings only between complete SSE frames. A visible progress block is created only when the request is actually queued or a managed phase remains active beyond the configured visibility delay. Fast managed requests and cache hits proceed directly to the model result without showing a proxy progress heading or a completion-only message. Verified visible phases include:

```text
正在解析 PDF…
已確認 18 頁；正在抽取原生文字…
正在使用視覺模型分析第 1/5 批頁面…
視覺模型要求檢視 1 個局部區域…
視覺模型已完成 18/18 頁…
文件與圖片內容已就緒；正在交給模型分析…
```

When progress becomes visible, it is emitted as a dedicated first text block headed `VLLM-CC-TOOLS-PROXY 進度：`. The final transition message is appended only when that block already exists; it never creates a progress block by itself. No hidden nonce or `VLLMCCP:v1:*` marker is emitted. Before a later request reaches the base vLLM, the proxy removes that dedicated block structurally. Legacy V0.2.2 sentinel-wrapped history is also cleaned for backward compatibility.

After PDF/image preprocessing finishes, the managed slot is released and the final base-vLLM answer is streamed token-by-token into the same Anthropic SSE response. Proxy-owned WebSearch/WebFetch tool rounds still require complete tool-call JSON internally; their final result is emitted as Anthropic SSE after the bounded loop completes.

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

- `WebSearch` and `web_search` call SearXNG.
- `WebFetch` and `web_fetch` call the configured awesome-web-fetch service.
- Managed loops remain bounded to six rounds by default.
- WebFetch applies URL and SSRF validation.

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

## Verification

```bash
./scripts/verify.sh
```

The suite covers transparent bypass, raw-body preservation, Claude Code hello probes, FIFO admission, queue full/timeout/cancellation, persistent cache/TTL/LRU/disk-full behavior, request-local deduplication, cross-request singleflight, vision serialization, configuration, deployment contract, nested content blocks, PDF extraction, scanned-page visual routing, image normalization, crop authorization, bounded visual tool loops, API-key separation, managed web tools and frame-safe Anthropic SSE keepalive.

## V0.2.5 limits

- DOCX, XLSX and PPTX still require a future host-side document bridge.
- Visual analysis depends on the selected multimodal model and its vLLM tool-call parser/template.
- Queue, semaphore and singleflight state are process-local; multiple proxy replicas do not share admission state.
- Cache files are persistent, but multiple proxy replicas do not coordinate cache writes or distributed locks.
- No persistent document-handle API or distributed Redis cache.
