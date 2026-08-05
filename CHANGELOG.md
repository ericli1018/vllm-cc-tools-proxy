# Changelog

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
