# VLLM-CC-TOOLS-PROXY

`VLLM-CC-TOOLS-PROXY` is a Claude Code compatibility proxy for local vLLM. V0.2 converts unsupported Anthropic PDF/image Base64 blocks into bounded text before the request reaches the main model, while an optional visual vLLM performs OCR and visual interpretation.

## V0.2 architecture

```text
Claude Code
  -> vllm-cc-tools-proxy:8080
       ├─ local Poppler: PDF metadata, native text, page rendering
       ├─ local ImageMagick: validation, normalization, bounded crops
       ├─ visual vLLM: OCR, tables, charts, diagrams, UI and photographs
       ├─ SearXNG / awesome-web-fetch: managed WebSearch and WebFetch
       └─ base vLLM: final reasoning and Claude Code tool calling
```

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

Long media work immediately opens Anthropic SSE and continues sending `ping` events. Verified visible phases include:

```text
正在解析 PDF…
已確認 18 頁；正在抽取原生文字…
正在使用視覺模型分析第 1/5 批頁面…
視覺模型要求檢視 1 個局部區域…
視覺模型已完成 18/18 頁…
文件與圖片內容已就緒；正在交給模型分析…
```

Proxy progress uses request-scoped markers and is stripped from subsequent conversation history before reaching vLLM.

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

The suite covers configuration, deployment contract, nested content blocks, PDF extraction, scanned-page visual routing, image normalization, crop authorization, bounded visual tool loops, API-key separation, managed web tools and Anthropic SSE.

## V0.2 limits

- DOCX, XLSX and PPTX still require a future host-side document bridge.
- Visual analysis depends on the selected multimodal model and its vLLM tool-call parser/template.
- No persistent document handles, request coalescing or distributed cache.
