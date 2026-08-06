#!/bin/sh
set -eu

node -e "const [major]=process.versions.node.split('.').map(Number); if(major<22) process.exit(1)"
npm test
npm run check

test ! -e deploy/bootstrap.sh
test -f package-lock.json
grep -Fq 'image: node:22-bookworm-slim' compose.yaml
grep -Fq 'git clone --depth 1 --branch main' compose.yaml
grep -Fq 'git -C "$$SOURCE_DIR" pull --ff-only origin main' compose.yaml
grep -Fq 'proxy-source:/workspace/vllm-cc-tools-proxy' compose.yaml
grep -Fq 'proxy-npm-cache:/root/.npm' compose.yaml
grep -Fq 'proxy-apt-cache:/var/cache/apt/archives' compose.yaml
grep -Fq 'proxy-data:/var/lib/vllm-cc-tools-proxy' compose.yaml
grep -Fq 'DEPENDENCY_FINGERPRINT' compose.yaml
grep -Fq 'npm ci --omit=dev --no-audit --no-fund' compose.yaml
grep -Fq 'node_modules/.dependency-fingerprint' compose.yaml
! grep -Eq 'bootstrap\.sh' compose.yaml
! grep -Eq '^  (document-parser|image-parser|ocr-service):' compose.yaml
for name in VLLM_BASE_URL VLLM_BASE_API_KEY VLLM_BASE_CONNECT_TIMEOUT_MS VLLM_BASE_HEADERS_TIMEOUT_MS VLLM_BASE_BODY_TIMEOUT_MS VLLM_VISION_URL VLLM_VISION_MODEL VLLM_VISION_API_KEY VLLM_VISION_PROVIDER VLLM_VISION_THINK WEB_FETCH_API_KEY; do
  grep -q "^${name}=" .env.example
done
grep -q '^CONCURRENCY_PROFILE=default$' .env.example
grep -Fq 'CONCURRENCY_PROFILE: ${CONCURRENCY_PROFILE:-default}' compose.yaml
grep -Fq 'MANAGED_MAX_CONCURRENCY: ${MANAGED_MAX_CONCURRENCY:-}' compose.yaml
grep -Fq 'MANAGED_MAX_QUEUE: ${MANAGED_MAX_QUEUE:-}' compose.yaml
grep -Fq 'MANAGED_QUEUE_TIMEOUT_MS: ${MANAGED_QUEUE_TIMEOUT_MS:-}' compose.yaml
grep -Fq 'VISION_MAX_CONCURRENCY: ${VISION_MAX_CONCURRENCY:-}' compose.yaml
grep -Fq 'MEDIA_CACHE_MAX_MB: ${MEDIA_CACHE_MAX_MB:-0}' compose.yaml
grep -q '^MEDIA_CACHE_MAX_MB=0$' .env.example
grep -Fq "'/api/hello'" src/services/proxy-server.js
test -f src/cache/cache-key.js
test -f src/cache/media-cache.js
test -f src/media/analysis-registry.js
test -f src/visual/crop-errors.js
grep -Fq 'VLLM_VISION_PROVIDER: ${VLLM_VISION_PROVIDER:-vllm}' compose.yaml
grep -Fq 'VLLM_VISION_THINK: ${VLLM_VISION_THINK:-false}' compose.yaml
grep -q '^VLLM_VISION_PROVIDER=vllm$' .env.example
grep -q '^VLLM_VISION_THINK=false$' .env.example
grep -q '^PROGRESS_HEARTBEAT_MS=30000$' .env.example
grep -q '^SSE_DRAIN_TIMEOUT_MS=10000$' .env.example
grep -Fq 'PROGRESS_HEARTBEAT_MS: ${PROGRESS_HEARTBEAT_MS:-30000}' compose.yaml
grep -Fq 'SSE_DRAIN_TIMEOUT_MS: ${SSE_DRAIN_TIMEOUT_MS:-10000}' compose.yaml
grep -q '^VLLM_BASE_CONNECT_TIMEOUT_MS=10000$' .env.example
grep -q '^VLLM_BASE_HEADERS_TIMEOUT_MS=900000$' .env.example
grep -q '^VLLM_BASE_BODY_TIMEOUT_MS=900000$' .env.example
grep -Fq 'VLLM_BASE_CONNECT_TIMEOUT_MS: ${VLLM_BASE_CONNECT_TIMEOUT_MS:-10000}' compose.yaml
grep -Fq 'VLLM_BASE_HEADERS_TIMEOUT_MS: ${VLLM_BASE_HEADERS_TIMEOUT_MS:-900000}' compose.yaml
grep -Fq 'VLLM_BASE_BODY_TIMEOUT_MS: ${VLLM_BASE_BODY_TIMEOUT_MS:-900000}' compose.yaml
grep -Fq 'WEB_FETCH_API_KEY: ${WEB_FETCH_API_KEY:-}' compose.yaml
test -f src/proxy/media-progress.js
test -f src/services/base-upstream.js
grep -Fq 'base_upstream_first_event' src/services/proxy-server.js
grep -Fq 'progress_sse_sent' src/services/proxy-server.js
grep -Fq 'base_upstream_request_failed' src/services/proxy-server.js
grep -Fq 'web_fetch_upstream_rejected' src/proxy/web-tools.js

grep -Fq "export const PROGRESS_BLOCK_HEADER = '目前處理進度：';" src/proxy/progress.js
node - <<'NODE'
const fs = require('node:fs');
const source = fs.readFileSync('src/proxy/progress.js', 'utf8');
const runtime = source.slice(source.indexOf('export class ProgressStream'));
if (runtime.includes('VLLMCCP:v1:') || runtime.includes('INVISIBLE_SEPARATOR')) process.exit(1);
NODE
test "$(node -p "require('./package.json').version")" = '0.2.10'

test -f src/proxy/evidence-contract.js
test -f src/proxy/protocol-sanitizer.js
test -f src/proxy/managed-final.js
grep -Fq 'VCC_PROXY_EVIDENCE_CONTRACT_V1' src/proxy/evidence-contract.js
grep -Fq "pipelineVersion: 'media-v5'" src/config.js
grep -Fq "visualPromptVersion: 'visual-v4'" src/config.js
grep -Fq "evidenceContractVersion: 'evidence-v1'" src/config.js
grep -Fq 'assertNeutralEvidence' src/proxy/evidence-contract.js
grep -Fq 'sanitizeProtocolHistory' src/services/proxy-server.js
grep -Fq 'incoming_protocol_inventory' src/services/proxy-server.js
grep -Fq 'managed_final_response_repair_start' src/proxy/managed-loop.js
grep -Fq 'neutralizeProtocolValue' src/proxy/managed-loop.js
! grep -Eq "<document|<visual_asset|<analysis>|<visual_batch" src/proxy/media-adapters.js
! grep -Eq "<page|<native_text|<visual_batch" src/parsers/pdf.js

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose --env-file .env.example config >/dev/null
else
  echo 'Docker Compose unavailable; static Compose checks passed.'
fi

echo 'Verification complete.'
