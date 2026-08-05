# Changelog

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
