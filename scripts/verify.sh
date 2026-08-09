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
for name in VLLM_BASE_URL VLLM_BASE_API_KEY VLLM_BASE_CONNECT_TIMEOUT_MS VLLM_BASE_HEADERS_TIMEOUT_MS VLLM_BASE_BODY_TIMEOUT_MS VLLM_VISION_URL VLLM_VISION_MODEL VLLM_VISION_API_KEY VLLM_VISION_PROVIDER VLLM_VISION_THINK WEB_FETCH_API_KEY WEB_FETCH_PROCESSOR_ENABLED WEB_FETCH_PROCESSOR_PROVIDER WEB_FETCH_PROCESSOR_URL WEB_FETCH_PROCESSOR_MODEL WEB_FETCH_PROCESSOR_API_KEY WEB_FETCH_PROCESSOR_THINK WEB_FETCH_PROCESSOR_CONCURRENCY WEB_FETCH_PROCESSOR_TIMEOUT_MS MODEL_RESPONSE_LANGUAGE LOG_PROTOCOL_SNIPPETS DIAGNOSTIC_WEB_TOOL_PASSTHROUGH DIAGNOSTIC_WEB_SEARCH_PASSTHROUGH_COUNT DIAGNOSTIC_WEB_FETCH_PASSTHROUGH_COUNT DIAGNOSTIC_WEB_TOOL_TRACE DIAGNOSTIC_WEB_TOOL_TRACE_DIR; do
  grep -q "^${name}=" .env.example
done
grep -q '^CONCURRENCY_PROFILE=default$' .env.example
grep -Fq 'CONCURRENCY_PROFILE: ${CONCURRENCY_PROFILE:-default}' compose.yaml
grep -Fq 'MANAGED_MAX_CONCURRENCY: ${MANAGED_MAX_CONCURRENCY:-}' compose.yaml
grep -Fq 'MANAGED_MAX_QUEUE: ${MANAGED_MAX_QUEUE:-}' compose.yaml
grep -Fq 'MANAGED_QUEUE_TIMEOUT_MS: ${MANAGED_QUEUE_TIMEOUT_MS:-}' compose.yaml
grep -Fq 'MANAGED_TASK_TIMEOUT_MS: ${MANAGED_TASK_TIMEOUT_MS:-}' compose.yaml
! grep -q '^MANAGED_TASK_TIMEOUT_MS=' .env.example
grep -Fq 'MANAGED_MODEL_ROUND_TIMEOUT_MS: ${MANAGED_MODEL_ROUND_TIMEOUT_MS:-360000}' compose.yaml
grep -q '^MANAGED_MODEL_ROUND_TIMEOUT_MS=360000$' .env.example
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
grep -Fq 'WEB_FETCH_PROCESSOR_ENABLED: ${WEB_FETCH_PROCESSOR_ENABLED:-true}' compose.yaml
grep -Fq 'WEB_FETCH_PROCESSOR_PROVIDER: ${WEB_FETCH_PROCESSOR_PROVIDER:-vllm}' compose.yaml
grep -Fq 'WEB_FETCH_PROCESSOR_URL: ${WEB_FETCH_PROCESSOR_URL:-}' compose.yaml
grep -Fq 'WEB_FETCH_PROCESSOR_MODEL: ${WEB_FETCH_PROCESSOR_MODEL:-}' compose.yaml
grep -Fq 'WEB_FETCH_PROCESSOR_API_KEY: ${WEB_FETCH_PROCESSOR_API_KEY:-}' compose.yaml
grep -Fq 'WEB_FETCH_PROCESSOR_THINK: ${WEB_FETCH_PROCESSOR_THINK:-false}' compose.yaml
grep -Fq 'WEB_FETCH_PROCESSOR_CONCURRENCY: ${WEB_FETCH_PROCESSOR_CONCURRENCY:-3}' compose.yaml
grep -Fq 'WEB_FETCH_PROCESSOR_TIMEOUT_MS: ${WEB_FETCH_PROCESSOR_TIMEOUT_MS:-300000}' compose.yaml
grep -Fq 'MODEL_RESPONSE_LANGUAGE: ${MODEL_RESPONSE_LANGUAGE:-en-US}' compose.yaml
grep -q '^MODEL_RESPONSE_LANGUAGE=en-US$' .env.example
grep -Fq 'LOG_PROTOCOL_SNIPPETS: ${LOG_PROTOCOL_SNIPPETS:-false}' compose.yaml
grep -Fq 'DIAGNOSTIC_WEB_TOOL_PASSTHROUGH: ${DIAGNOSTIC_WEB_TOOL_PASSTHROUGH:-false}' compose.yaml
grep -Fq 'DIAGNOSTIC_WEB_SEARCH_PASSTHROUGH_COUNT: ${DIAGNOSTIC_WEB_SEARCH_PASSTHROUGH_COUNT:-1}' compose.yaml
grep -Fq 'DIAGNOSTIC_WEB_FETCH_PASSTHROUGH_COUNT: ${DIAGNOSTIC_WEB_FETCH_PASSTHROUGH_COUNT:-1}' compose.yaml
grep -Fq 'DIAGNOSTIC_WEB_TOOL_TRACE: ${DIAGNOSTIC_WEB_TOOL_TRACE:-false}' compose.yaml
grep -Fq 'DIAGNOSTIC_WEB_TOOL_TRACE_DIR: ${DIAGNOSTIC_WEB_TOOL_TRACE_DIR:-/var/lib/vllm-cc-tools-proxy/diagnostics/web-tool-trace}' compose.yaml
grep -q '^DIAGNOSTIC_WEB_TOOL_PASSTHROUGH=false$' .env.example
grep -q '^DIAGNOSTIC_WEB_SEARCH_PASSTHROUGH_COUNT=1$' .env.example
grep -q '^DIAGNOSTIC_WEB_FETCH_PASSTHROUGH_COUNT=1$' .env.example
grep -q '^DIAGNOSTIC_WEB_TOOL_TRACE=false$' .env.example
grep -q '^DIAGNOSTIC_WEB_TOOL_TRACE_DIR=/var/lib/vllm-cc-tools-proxy/diagnostics/web-tool-trace$' .env.example
test -f src/proxy/web-tool-diagnostic.js
test -f src/proxy/web-tool-diagnostic-trace-store.js
grep -Fq 'diagnostic_web_tool_passthrough' src/proxy/managed-loop.js
grep -Fq 'client_unmanaged_request' src/services/proxy-server.js
grep -Fq 'client_tool_result_returned' src/services/proxy-server.js
grep -q '^WEB_FETCH_PROCESSOR_ENABLED=true$' .env.example
grep -q '^WEB_FETCH_PROCESSOR_PROVIDER=vllm$' .env.example
grep -q '^WEB_FETCH_PROCESSOR_THINK=false$' .env.example
grep -q '^WEB_FETCH_PROCESSOR_CONCURRENCY=3$' .env.example
grep -q '^WEB_FETCH_PROCESSOR_TIMEOUT_MS=300000$' .env.example
test -f src/proxy/media-progress.js
test -f src/services/base-upstream.js
grep -Fq 'base_upstream_first_event' src/services/proxy-server.js
grep -Fq 'progress_sse_sent' src/services/proxy-server.js
grep -Fq 'base_upstream_request_failed' src/services/proxy-server.js
grep -Fq 'web_fetch_upstream_rejected' src/proxy/web-tools.js

grep -Fq "export const PROGRESS_BLOCK_HEADER = '目前處理進度：';" src/proxy/progress.js
grep -Fq "export function describeFinalAnthropicProgress" src/proxy/anthropic-sse.js
grep -Fq "handoff_to_claude_code" src/proxy/anthropic-sse.js
grep -Fq "returning_visible_response" src/proxy/anthropic-sse.js
node - <<'NODE'
const fs = require('node:fs');
const source = fs.readFileSync('src/proxy/progress.js', 'utf8');
const runtime = source.slice(source.indexOf('export class ProgressStream'));
if (runtime.includes('VLLMCCP:v1:') || runtime.includes('INVISIBLE_SEPARATOR')) process.exit(1);
NODE
test "$(node -p "require('./package.json').version")" = '0.2.28'
test "$(node --input-type=module -e "import('./src/version.js').then((m) => process.stdout.write(m.VERSION))")" = '0.2.28'


test -f src/i18n/response-language.js
test -f src/proxy/response-language-policy.js
grep -Fq 'MODEL_RESPONSE_LANGUAGE=zh-TW' README.md
grep -Fq 'V0.2.23 response language localization' README.md
grep -Fq 'V0.2.23.1 response-language boundary hotfix' README.md
grep -Fq 'Respond in Traditional Chinese (zh-TW).' README.md
grep -Fq 'V0.2.23.2 native WebSearch forced-choice hotfix' README.md
grep -Fq 'forced_tool_choice' src/services/proxy-server.js
grep -Fq 'managed_forced_tool_choice_satisfied' src/proxy/managed-loop.js
test -f src/proxy/client-web-tool-lifecycle.js
grep -Fq 'parseClaudeCodeWebFetchProcessorChild' src/services/proxy-server.js
grep -Fq 'web_fetch_processor_child_completed' src/services/proxy-server.js
grep -Fq 'web_fetch_tool_result_enriched' src/services/proxy-server.js
grep -Fq 'passthroughManagedWebTools' src/proxy/managed-loop.js
grep -Fq 'claude_code_client_tool' src/services/proxy-server.js
test -f src/proxy/native-web-tools.js
grep -Fq 'normalizeNativeWebToolsRequest' src/services/proxy-server.js
grep -Fq 'native_web_tools_normalized' src/services/proxy-server.js
grep -Fq 'web_search_' src/proxy/native-web-tools.js
grep -Fq 'web_fetch_' src/proxy/native-web-tools.js
grep -Fq 'max_uses_exceeded' src/proxy/native-web-tools.js

grep -Fq 'normalizeNativeWebToolResponse' src/proxy/managed-loop.js
grep -Fq 'createServerToolStreamBridge' src/proxy/anthropic-sse.js
grep -Fq 'native_web_response_contained' src/proxy/managed-loop.js
grep -Fq 'server_web_mixed_tool_deferred' src/proxy/managed-loop.js
grep -Fq 'sanitizeCompletedServerWebHistory' src/proxy/managed-loop.js
grep -Fq 'web_search_requests' src/proxy/managed-loop.js
grep -Fq 'web_fetch_requests' src/proxy/managed-loop.js

test -f src/proxy/anthropic-usage.js
grep -Fq 'managed_usage_preflight_succeeded' src/services/proxy-server.js
grep -Fq 'managed_usage_preflight_failed' src/services/proxy-server.js
grep -Fq "'/v1/messages/count_tokens'" src/services/proxy-server.js
grep -Fq 'initialUsage' src/proxy/progress.js

test -f src/proxy/evidence-contract.js
test -f src/proxy/protocol-sanitizer.js
test -f src/proxy/managed-final.js
test -f src/proxy/web-result-contract.js
test -f src/services/web-fetch-processor.js
test -f src/proxy/protocol-diagnostics.js
test -f src/proxy/protocol-diagnostic-store.js
test -f src/version.js
grep -Fq 'VCC_PROXY_EVIDENCE_CONTRACT_V1' src/proxy/evidence-contract.js
grep -Fq "pipelineVersion: 'media-v7'" src/config.js
grep -Fq "visualPromptVersion: 'visual-v6'" src/config.js
grep -Fq "evidenceContractVersion: 'evidence-v2'" src/config.js
grep -Fq 'assertNeutralEvidence' src/proxy/evidence-contract.js
grep -Fq 'sanitizeProtocolHistory' src/services/proxy-server.js
grep -Fq 'incoming_protocol_inventory' src/services/proxy-server.js
grep -Fq 'managed_final_response_repair_start' src/proxy/managed-loop.js
grep -Fq 'managed_final_response_recovery_tool_dispatch' src/proxy/managed-loop.js
grep -Fq 'buildManagedContinuationRecoveryRequest' src/proxy/managed-final.js
grep -Fq 'buildManagedFinalChannelRecoveryRequest' src/proxy/managed-final.js
grep -Fq 'enable_thinking: false' src/proxy/managed-final.js
grep -Fq 'managed_final_response_diagnostic_file' src/proxy/managed-loop.js
grep -Fq 'managed_final_response_diagnostic_file_failed' src/proxy/managed-loop.js
! grep -Fq "onDiagnostic('managed_final_response_anomaly_snippet'" src/proxy/managed-loop.js
! grep -Fq "onDiagnostic('managed_final_response_input_protocol_snippet'" src/proxy/managed-loop.js
grep -Fq 'neutralizeProtocolValue' src/proxy/managed-loop.js
grep -Fq 'renderManagedToolResult' src/proxy/managed-loop.js
grep -Fq 'WEB_SOURCE_CONTENT_BEGIN' src/services/web-fetch-processor.js
grep -Fq 'chat_template_kwargs' src/services/web-fetch-processor.js
! grep -Eq "<document|<visual_asset|<analysis>|<visual_batch" src/proxy/media-adapters.js
! grep -Eq "<page|<native_text|<visual_batch" src/parsers/pdf.js

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose --env-file .env.example config >/dev/null
else
  echo 'Docker Compose unavailable; static Compose checks passed.'
fi


grep -Fq 'promoteManagedFinalAnswer' src/proxy/managed-final.js
grep -Fq 'managed_final_response_promoted' src/proxy/managed-loop.js
grep -Fq 'sanitizeProtocolToolDefinitions' src/proxy/protocol-sanitizer.js
grep -Fq 'protocol_tool_descriptions_sanitized' src/services/proxy-server.js


grep -Fq 'managed_model_first_byte_received' src/services/proxy-server.js
grep -Fq 'upstream_received_bytes' src/services/proxy-server.js
grep -Fq 'model_elapsed_ms' src/services/proxy-server.js
grep -Fq 'modelFirstByte' src/i18n/response-language.js
grep -Fq 'V0.2.25.2 first-byte progress hotfix' README.md

# V0.2.26 recursive Vision evidence release contract
grep -Fq 'V0.2.26 recursive Vision evidence pipeline' README.md
grep -Fq 'vision_upstream_request' README.md
grep -Fq 'media-v6' README.md
grep -Fq 'visual-v5' README.md

# V0.2.26.1 activity-aware timeout release contract
grep -Fq 'V0.2.26.1 activity-aware managed timeout hotfix' README.md
grep -Fq 'first-byte deadline' README.md
grep -Fq 'streaming inactivity' README.md
grep -Fq 'whole-task hard deadline is now **disabled by default**' README.md


# V0.2.26.2 / V0.2.26.3 historical language-prompt contracts are documented but retired from runtime
 grep -Fq 'V0.2.26.2 native-language visible-output contract' README.md
 grep -Fq 'V0.2.26.3 generation-adjacent language tail' README.md
 ! grep -Fq 'modelInstruction:' src/i18n/response-language.js
 ! grep -Fq 'modelTailInstruction:' src/i18n/response-language.js
 ! grep -Fq 'injectResponseLanguagePolicy(' src/services/proxy-server.js
 ! grep -Fq 'injectResponseLanguageTail(' src/services/proxy-server.js

# V0.2.26.4 Final Language Gate release contract
 grep -Fq 'V0.2.26.4 Final Language Gate' README.md
 grep -Fq 'Final Presentation Language' README.md
 grep -Fq 'External Processor' README.md
 grep -Fq 'isolated Base vLLM language repair' README.md
 grep -Fq 'original Laguna final response' README.md
 grep -Fq '0.2.26+hotfix.4' README.md
 grep -Fq 'applyFinalLanguageGate' src/services/proxy-server.js
 grep -Fq 'rewriteFinalSegmentsWithExternalProcessor' src/services/proxy-server.js
 grep -Fq 'buildBaseLanguageRepairRequest' src/services/proxy-server.js
 test -f src/proxy/final-language-gate.js
 test -f src/services/final-language-repair.js
 test -f V0.2.26.4-更新說明.md

# V0.2.26.5 Final Language Gate boundary hotfix contract
 grep -Fq 'V0.2.26.5 Final Language Gate boundary hotfix' README.md
 grep -Fq 'native_web_search' README.md
 grep -Fq 'bypass Final Language Gate' README.md
 grep -Fq 'zh-TW / zh-CN' README.md
 grep -Fq '0.2.26+hotfix.5' README.md
 grep -Fq 'if (!nativeWebSearchFastLane)' src/services/proxy-server.js
 grep -Fq 'variantDominates' src/proxy/final-language-gate.js
 test -f V0.2.26.5-更新說明.md
# V0.2.27 routed schematic PDF release contract
grep -Fq 'V0.2.27 routed schematic PDF pipeline' README.md
grep -Fq 'media-v7' README.md
grep -Fq 'visual-v6' README.md
grep -Fq 'evidence-v2' README.md
test -f src/visual/pdf-page-classifier.js
test -f src/visual/pdf-tiler.js
test -f src/visual/pdf-evidence-merger.js
test -f V0.2.27-更新說明.md
grep -Fq 'pdf_schematic_tile' src/parsers/pdf.js
grep -Fq 'registerRegion' src/visual/asset-registry.js

# V0.2.27.1 live PDF/media progress hotfix contract
grep -Fq 'V0.2.27.1 live PDF/media progress hotfix' README.md
grep -Fq 'sanitized bootstrap' README.md
grep -Fq 'exact cumulative `message_delta.usage`' README.md
test -f src/proxy/media-usage-bootstrap.js
test -f V0.2.27.1-更新說明.md
grep -Fq 'managed_usage_bootstrap_succeeded' src/services/proxy-server.js
grep -Fq 'media_usage_exact' src/services/proxy-server.js
grep -Fq 'pdf_schematic_tile_render' src/parsers/pdf.js
grep -Fq 'pdf_schematic_tile_analyze' src/parsers/pdf.js


# V0.2.27.2 native Read.pages focused PDF refinement contract
grep -Fq 'V0.2.27.2 native Read.pages focused PDF refinement' README.md
grep -Fq 'page-scoped cache' README.md
grep -Fiq 'no custom Claude Code tool' README.md
test -f src/proxy/pdf-page-scope.js
test -f V0.2.27.2-更新說明.md
grep -Fq 'scopeMediaCacheKey' src/cache/cache-key.js
grep -Fq 'mediaOccurrences' src/proxy/media-preflight.js
grep -Fq 'pageScope' src/proxy/media-progress.js
grep -Fq 'requested_pages' src/parsers/pdf.js
grep -Fq 'page_scope_mode' src/parsers/pdf.js


# V0.2.27.3 per-round continuation byte accounting hotfix contract
grep -Fq 'V0.2.27.3 per-round continuation byte accounting hotfix' README.md
grep -Fq 'round_received_bytes' README.md
test -f V0.2.27.3-更新說明.md
grep -Fq 'getCurrentRoundResponseBytes' src/services/proxy-server.js
grep -Fq 'round_received_bytes: receivedThisRound' src/services/proxy-server.js


# V0.2.28 IMAGE wire-contract observability release contract
grep -Fq 'V0.2.28 IMAGE wire-contract observability' README.md
test -f src/proxy/image-payload-observer.js
test -f V0.2.28-更新說明.md
grep -Fq 'image_payload_observed' src/services/proxy-server.js
grep -Fq 'image_payload_normalized' src/proxy/media-adapters.js
grep -Fq 'wire_dimensions' src/proxy/media-preflight.js
grep -Fq 'decodedBytes' src/proxy/media-preflight.js
grep -Fq 'media-v7' README.md
grep -Fq 'visual-v6' README.md
grep -Fq 'evidence-v2' README.md

echo 'Verification complete.'
