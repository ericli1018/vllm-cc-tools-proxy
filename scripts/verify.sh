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
for name in VLLM_BASE_URL VLLM_BASE_MODEL VLLM_BASE_API_KEY VLLM_BASE_CONNECT_TIMEOUT_MS VLLM_BASE_HEADERS_TIMEOUT_MS VLLM_BASE_BODY_TIMEOUT_MS VLLM_VISION_URL VLLM_VISION_MODEL VLLM_VISION_API_KEY VLLM_VISION_PROVIDER VLLM_VISION_THINK VLLM_VISION_TIMEOUT_MS WEB_FETCH_API_KEY WEB_FETCH_PROCESSOR_ENABLED WEB_FETCH_PROCESSOR_PROVIDER WEB_FETCH_PROCESSOR_URL WEB_FETCH_PROCESSOR_MODEL WEB_FETCH_PROCESSOR_API_KEY WEB_FETCH_PROCESSOR_THINK WEB_FETCH_PROCESSOR_CONCURRENCY WEB_FETCH_PROCESSOR_TIMEOUT_MS MODEL_RESPONSE_LANGUAGE LOG_PROTOCOL_SNIPPETS DIAGNOSTIC_WEB_TOOL_PASSTHROUGH DIAGNOSTIC_WEB_SEARCH_PASSTHROUGH_COUNT DIAGNOSTIC_WEB_FETCH_PASSTHROUGH_COUNT DIAGNOSTIC_WEB_TOOL_TRACE DIAGNOSTIC_WEB_TOOL_TRACE_DIR; do
  grep -q "^${name}=" .env.example
done
! grep -q '^CONCURRENCY_PROFILE=' .env.example
! grep -q '^MANAGED_MAX_CONCURRENCY=' .env.example
! grep -q '^MANAGED_MAX_QUEUE=' .env.example
! grep -q '^MANAGED_QUEUE_TIMEOUT_MS=' .env.example
! grep -Fq 'CONCURRENCY_PROFILE:' compose.yaml
! grep -Fq 'MANAGED_MAX_CONCURRENCY:' compose.yaml
! grep -Fq 'MANAGED_MAX_QUEUE:' compose.yaml
! grep -Fq 'MANAGED_QUEUE_TIMEOUT_MS:' compose.yaml
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
grep -Fq 'VLLM_VISION_TIMEOUT_MS: ${VLLM_VISION_TIMEOUT_MS:-120000}' compose.yaml
grep -q '^VLLM_VISION_PROVIDER=vllm$' .env.example
grep -q '^VLLM_VISION_THINK=false$' .env.example
grep -q '^VLLM_VISION_TIMEOUT_MS=120000$' .env.example
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
grep -Fq 'VLLM_BASE_MODEL: ${VLLM_BASE_MODEL:-}' compose.yaml
grep -q '^VLLM_BASE_MODEL=$' .env.example
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
test "$(node -p "require('./package.json').version")" = '0.29.14'
test "$(node --input-type=module -e "import('./src/version.js').then((m) => process.stdout.write(m.VERSION))")" = '0.29.14'


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
grep -Fq "pipelineVersion: 'media-v8'" src/config.js
grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js
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

# V0.2.28.1 historical GLM output-contract hardening documentation
grep -Fq 'V0.2.28.1 GLM output contract hardening' README.md
test -f V0.2.28.1-更新說明.md
grep -Fq 'language_not_compliant' src/proxy/final-language-gate.js
grep -Fq 'visual_reasoning_stripped' src/visual/vision-client.js

# V0.2.28.2 Vision empty-output contract hotfix
grep -Fq 'V0.2.28.2 Vision empty-output contract hotfix' README.md
test -f V0.2.28.2-更新說明.md
grep -Fq 'vision_output_observed' src/visual/vision-client.js
grep -Fq 'vision_empty_output_retry' src/visual/vision-client.js
grep -Fq "code: 'vision_empty_output'" src/visual/vision-client.js
! grep -Fq 'noThinkSystemPrompt' src/visual/vision-client.js
! grep -Fq 'noThinkSystemPrompt' src/services/final-language-repair.js
grep -Fq 'finalLanguageRepairFallbackBase' src/i18n/response-language.js
grep -Fq 'media-v7' README.md
grep -Fq 'visual-v8' README.md
grep -Fq 'evidence-v4' README.md

# V0.2.28.3 Vision evidence quality gate + adaptive thinking recovery
grep -Fq 'V0.2.28.3 Vision Evidence Quality Gate' README.md
test -f V0.2.28.3-更新說明.md
grep -Fq 'vision_output_quality' src/visual/vision-client.js
grep -Fq 'vision_quality_retry' src/visual/vision-client.js
grep -Fq "code: 'vision_output_invalid'" src/visual/vision-client.js
grep -Fq 'visual-v9' README.md
grep -Fq 'evidence-v5' README.md



# V0.2.28.8 cache-aware context token accounting
grep -Fq 'V0.2.28.8 cache-aware context token accounting' README.md
test -f V0.2.28.8-更新說明.md
grep -Fq 'hasInputUsage' src/proxy/progress.js
! grep -Fq 'Math.max(current.input_tokens' src/proxy/progress.js
grep -Fq 'replaces preflight total with cache-split input usage atomically' test/progress.test.js
grep -Fq 'does not double-count vLLM cache-split usage after preflight total' test/progress.test.js

# V0.2.28.7 compact main-model phase progress
grep -Fq 'V0.2.28.7 compact main-model phase progress' README.md
test -f V0.2.28.7-更新說明.md
grep -Fq 'onStreamPhase' src/proxy/anthropic-sse-collector.js
grep -Fq 'managed_model_stream_phase_changed' src/services/proxy-server.js
grep -Fq "'modelHeartbeat'" test/response-language.test.js
grep -Fq "modelRoundProgress.phase = 'waiting'" src/services/proxy-server.js
! grep -Eq '^CONTINUATION_[A-Z0-9_]+=' .env.example
grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js

# V0.2.28.6 Final Language direct-segment repair
grep -Fq 'V0.2.28.6 Final Language direct-segment repair' README.md
test -f V0.2.28.6-更新說明.md
grep -Fq 'extractLanguageRepairSegmentFromAnthropic' src/services/final-language-repair.js
grep -Fq 'segment_index' src/services/final-language-repair.js
grep -Fq 'segment_count' src/services/final-language-repair.js
! grep -Fq '<<<VCC_LANG_SEGMENT_' src/services/final-language-repair.js
! grep -Fq 'parseLanguageRepairSegments' src/services/final-language-repair.js
! grep -Fq 'encodeLanguageRepairSegments' src/services/final-language-repair.js
! grep -Eq '^CONTINUATION_[A-Z0-9_]+=' .env.example
grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js


# V0.2.28.5 recovery-only managed continuation state compression
grep -Fq 'V0.2.28.5 managed continuation state compression' README.md
test -f V0.2.28.5-更新說明.md
test -f src/proxy/continuation-state.js
test -f src/services/continuation-state-compressor.js
grep -Fq 'prepareContinuationState' src/proxy/managed-loop.js
grep -Fq 'compressContinuationWindow' src/services/proxy-server.js
grep -Fq 'WEB_FETCH_PROCESSOR_' README.md
grep -Fq 'managed_continuation_state_preserved' src/proxy/continuation-state.js
grep -Fq 'managed_continuation_compression_failed' src/proxy/continuation-state.js
grep -Fq 'CONTINUATION_WINDOW_CHARS = 24_000' src/proxy/continuation-state.js
grep -Fq 'CONTINUATION_OVERLAP_CHARS = 4_000' src/proxy/continuation-state.js
! grep -Eq '^CONTINUATION_[A-Z0-9_]+=' .env.example
! grep -Eq 'CONTINUATION_[A-Z0-9_]+:' compose.yaml
grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js


# V0.2.28.4 schematic tile isolation + Vision transport diagnostics
grep -Fq 'V0.2.28.4 PDF schematic tile isolation' README.md
test -f V0.2.28.4-更新說明.md
grep -Fq 'pdf_schematic_tile_failed' src/parsers/pdf.js
grep -Fq 'transport_code' src/lib/media.js
grep -Fq 'UND_ERR_HEADERS_TIMEOUT' src/lib/media.js
grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js
grep -Fq 'visual-v10' README.md
grep -Fq 'evidence-v6' README.md

# V0.2.28.9 Claude Code Context Compact routing guard
test -f src/proxy/context-compact-detector.js
test -f test/context-compact-detector.test.js
grep -Fq 'context_compact_request_detected' src/services/proxy-server.js
grep -Fq 'context_compact_bypass' src/services/proxy-server.js
grep -Fq 'prepareClaudeCodeCompactRequest' src/services/proxy-server.js
grep -Fq 'V0.2.28.9 Context Compact routing guard' README.md
test -f V0.2.28.9-更新說明.md

# V0.2.28.10 external Context Compact model
 test -f src/services/context-compact-client.js
 test -f test/context-compact-client.test.js
 test -f V0.2.28.10-更新說明.md
 grep -Fq 'V0.2.28.10 external Context Compact model' README.md
 grep -q '^CONTEXT_COMPACT_PROVIDER=ollama$' .env.example
 grep -q '^CONTEXT_COMPACT_URL=http://host.docker.internal:11434$' .env.example
 grep -q '^CONTEXT_COMPACT_MODEL=qwen3.6:27b-q4_K_M-cc$' .env.example
 grep -q '^CONTEXT_COMPACT_API_KEY=$' .env.example
 grep -q '^CONTEXT_COMPACT_THINK=false$' .env.example
 grep -Fq 'CONTEXT_COMPACT_PROVIDER: ${CONTEXT_COMPACT_PROVIDER:-vllm}' compose.yaml
 grep -Fq 'CONTEXT_COMPACT_URL: ${CONTEXT_COMPACT_URL:-}' compose.yaml
 grep -Fq 'CONTEXT_COMPACT_MODEL: ${CONTEXT_COMPACT_MODEL:-}' compose.yaml
 grep -Fq 'CONTEXT_COMPACT_API_KEY: ${CONTEXT_COMPACT_API_KEY:-}' compose.yaml
 grep -Fq 'CONTEXT_COMPACT_THINK: ${CONTEXT_COMPACT_THINK:-false}' compose.yaml
 grep -Fq "provider === 'ollama'" src/services/context-compact-client.js
 grep -Fq 'think: Boolean(think)' src/services/context-compact-client.js
 grep -Fq 'enable_thinking: Boolean(think)' src/services/context-compact-client.js
 grep -Fq 'context_compact_backend_fallback' src/services/proxy-server.js
 grep -Fq 'context_compact_external' src/services/proxy-server.js
 grep -Fq 'backend_prompt_tokens' src/services/context-compact-client.js


# V0.2.28.11 independent Base connections + explicit-busy retry
test -f src/services/base-busy-retry.js
test -f test/base-busy-retry.test.js
test -f test/vllm-busy-retry.test.js
test -f V0.2.28.11-更新說明.md
grep -Fq 'V0.2.28.11 independent Base connections' README.md
grep -Fq 'base_upstream_busy_${event}' src/services/proxy-server.js
grep -Fq "event === 'wait'" src/services/proxy-server.js
grep -Fq "event === 'accepted'" src/services/proxy-server.js
! test -e src/concurrency/managed-queue.js
! grep -Fq 'acquireManaged' src/services/proxy-server.js
! grep -Fq 'acquireLargeContext' src/services/proxy-server.js
! grep -Fq 'proxy_queue_timeout' src/services/proxy-server.js
! grep -Fq 'proxy_queue_full' src/services/proxy-server.js





# V0.29.0 progressive document read + persistent source cache
test -f V0.29.0-更新說明.md
grep -Fq 'V0.29.0 Progressive Document Read + Persistent Source Cache' README.md
test -f src/cache/document-source-cache.js
grep -Fq 'scopePdfDocumentCacheKey' src/cache/cache-key.js
grep -Fq 'documentMapPageThreshold' src/parsers/pdf.js
grep -Fq 'kind=document_map' src/proxy/evidence-contract.js
grep -Fq 'Read.pages' src/proxy/evidence-contract.js
grep -Fq 'DocumentSourceCache' src/services/proxy-server.js
grep -Fq 'media-v8' src/config.js
grep -Fq 'evidence-v14' src/config.js
grep -Fq 'V0.29.0 Read.pages reuses the persistent original PDF source cache' test/proxy-server.test.js
grep -Fq 'V0.29.0 unscoped large PDF returns a bounded document map' test/pdf-parser.test.js



# V0.29.3 Recursive Vision Zoom & Overlapping Tiles
test -f V0.29.3-更新說明.md
grep -Fq 'V0.29.3 Recursive Vision Zoom & Overlapping Tiles' README.md
grep -Fq 'VISUAL_STATUS: NEEDS_ZOOM' src/visual/vision-client.js
grep -Fq "allowNeedsZoomFallback = false" src/visual/vision-client.js
grep -Fq "marginRatio: 0.12" src/visual/vision-client.js
grep -Fq "maxDepth = 2" src/visual/asset-registry.js
grep -Fq "phase: 'vision_needs_zoom'" src/visual/vision-client.js
grep -Fq "phase: 'pdf_zoom_tile'" src/parsers/pdf.js
grep -Fq "phase: 'pdf_zoom_tile_analyze'" src/parsers/pdf.js
grep -Fq "overlap: 0.15" src/parsers/pdf.js
grep -Fq "overlap: 0.20" src/parsers/pdf.js
grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js
grep -Fq 'V0.29.3 returns actionable NEEDS_ZOOM' test/vision-client.test.js
grep -Fq 'V0.29.3 DIAGRAM NEEDS_ZOOM falls back' test/pdf-parser.test.js
grep -Fq 'README documents V0.29.3 Recursive Vision Zoom' test/deployment.test.js

# V0.29.2 Vision Output Contract
test -f V0.29.2-更新說明.md
grep -Fq 'V0.29.2 Vision Output Contract' README.md
grep -Fq 'VISUAL_STATUS: CONTENT' src/visual/vision-client.js
grep -Fq 'VISUAL_STATUS: BLANK' src/visual/vision-client.js
grep -Fq 'VISUAL_STATUS: UNREADABLE' src/visual/vision-client.js
grep -Fq 'VISUAL_EVIDENCE:' src/visual/vision-client.js
! grep -Fq "reasons.push('too_short')" src/visual/vision-client.js
grep -Fq "outputContract: 'raw'" src/visual/pdf-page-classifier.js
grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js
grep -Fq 'V0.29.2 accepts explicit BLANK Vision status' test/vision-client.test.js
grep -Fq 'V0.29.2 retries a final Vision response that omits VISUAL_STATUS' test/vision-client.test.js
grep -Fq 'README documents V0.29.2 Vision Output Contract' test/deployment.test.js

# V0.29.1 Vision Recovery Safety
test -f V0.29.1-更新說明.md
grep -Fq 'V0.29.1 Vision Recovery Safety' README.md
grep -Fq 'VLLM_VISION_TIMEOUT_MS=120000' README.md
grep -Fq "code: 'vision_service_timeout'" src/visual/vision-client.js
grep -Fq "phase: 'vision_quality_retry'" src/visual/vision-client.js
grep -Fq "phase: 'image_vision_unavailable'" src/proxy/media-adapters.js
grep -Fq 'evidence_available: false' src/proxy/evidence-contract.js
grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
grep -Fq 'V0.29.1 one recoverable image failure does not stop later images' test/media-adapters.test.js
grep -Fq 'V0.29.1 Vision timeout uses explicit deadline' test/vision-client.test.js

# V0.2.28.20 large payload + media safety
test -f V0.2.28.20-更新說明.md
grep -Fq 'V0.2.28.20 Large Payload & Media Safety' README.md
test -f src/lib/structure-guard.js
! grep -Fq 'BASE64_PATTERN' src/lib/media.js
grep -Fq 'hasValidBase64AlphabetAndPadding' src/lib/media.js
grep -Fq 'estimateDecodedBytes(data)' src/lib/media.js
grep -Fq 'MAX_REQUEST_STRUCTURE_DEPTH = 128' src/lib/structure-guard.js
grep -Fq '[OMITTED_BASE64]' src/proxy/web-tool-diagnostic-trace-store.js
grep -Fq 'base64_sha256' src/proxy/web-tool-diagnostic-trace-store.js
grep -Fq 'Normalized image exceeds the configured byte limit.' src/parsers/image.js
grep -Fq 'request_stage' src/services/proxy-server.js
grep -Fq 'error_stack' src/services/proxy-server.js
grep -Fq 'V0.2.28.20 large PDF Read request is fileized' test/proxy-server.test.js

# V0.2.28.19 unified round-scoped telemetry + Proxy-global status counters
test -f V0.2.28.19-更新說明.md
grep -Fq 'V0.2.28.19 Unified Round-Scoped Telemetry' README.md
grep -Fq 'beginModelRound' src/proxy/runtime-telemetry.js
grep -Fq 'endModelRound' src/proxy/runtime-telemetry.js
grep -Fq 'snapshotRequest' src/proxy/runtime-telemetry.js
grep -Fq '▦ ${Math.max' src/i18n/response-language.js
grep -Fq 'proxySessions: proxySnapshot.sessions' src/services/proxy-server.js
grep -Fq 'proxy: {' src/services/proxy-server.js
grep -Fq 'runtimeTelemetry.beginModelRound' src/services/proxy-server.js
grep -Fq 'runtimeTelemetry.endModelRound' src/services/proxy-server.js
grep -Fq "Math.floor((Number(elapsedMs) || 0) / 1000)" src/i18n/response-language.js

# V0.2.28.18 strict Final Language Repair + round semantic-byte completion
test -f V0.2.28.18-更新說明.md
grep -Fq 'V0.2.28.18 Strict Final Language Repair' README.md
grep -Fq 'final_language_repair_echo_detected' src/proxy/final-language-gate.js
grep -Fq 'final_language_repair_retry' src/proxy/final-language-gate.js
grep -Fq '<TRANSLATE_SOURCE>' src/services/final-language-repair.js
grep -Fq 'completedModelOutputBytes' src/services/proxy-server.js
test "$(node -p "require('./package-lock.json').version")" = '0.29.14'

# V0.2.28.17 semantic model output telemetry
 test -f V0.2.28.17-更新說明.md
 grep -Fq 'V0.2.28.17 Semantic Model Output Telemetry' README.md
 grep -Fq 'onSemanticDelta' src/proxy/anthropic-sse-collector.js
 grep -Fq 'observeModelDelta' src/proxy/runtime-telemetry.js
 grep -Fq 'wire_received_bytes' src/services/proxy-server.js
 grep -Fq 'model_output_bytes' src/services/proxy-server.js
 grep -Fq 'semantic model delta' test/anthropic-sse-collector.test.js

# V0.2.28.16 Claude Code native statusLine + append-only SSE liveness
test -f V0.2.28.16-更新說明.md
test -f scripts/cc-tool-proxy-statusline.js
test -f test/runtime-telemetry.test.js
test -f test/statusline-client.test.js
grep -Fq 'V0.2.28.16 Claude Code Native StatusLine + SSE Liveness' README.md
grep -Fq '/cc-tool-proxy/status/' src/services/proxy-server.js
grep -Fq 'formatRuntimeStatusLine' src/i18n/response-language.js
grep -Fq 'snapshotSession' src/proxy/runtime-telemetry.js
grep -Fq 'PROGRESS_HEARTBEAT_MS' README.md
grep -Fq 'refreshInterval' README.md
! grep -Fq '\r${message}${padding}' src/proxy/progress.js

# V0.2.28.14 multilingual runtime progress telemetry
test -f V0.2.28.14-更新說明.md
grep -Fq 'V0.2.28.14 Multilingual Runtime Progress Telemetry' README.md
grep -Fq 'formatByteRate' src/i18n/response-language.js
grep -Fq 'recentBytesPerSecond' src/services/proxy-server.js
grep -Fq 'stalled' src/services/proxy-server.js
grep -Fq 'progressBlockHeader(this.locale)' src/proxy/progress.js
! grep -Fq 'progressBlockHeader(this.locale, { receivedBytes:' src/proxy/progress.js

# V0.2.28.13 original-vs-repaired language-shift validation
test -f V0.2.28.13-更新說明.md
grep -Fq 'LANGUAGE_SHIFT_MIN_TARGET_GAIN = 12' src/proxy/final-language-gate.js
grep -Fq 'LANGUAGE_SHIFT_MIN_SOURCE_REDUCTION_RATIO = 0.30' src/proxy/final-language-gate.js
grep -Fq 'accept_by_language_shift' src/proxy/final-language-gate.js
grep -Fq 'final_language_repair_validation' src/proxy/final-language-gate.js
grep -Fq 'V0.2.28.13 Original-vs-Repaired Language Shift Validation' README.md

# V0.2.28.12 technical-prose language classification + dedicated Language Processor + session banner
test -f src/proxy/runtime-telemetry.js
test -f V0.2.28.12-更新說明.md
grep -Fq 'LANG_PROCESSOR_ENABLED=false' .env.example
grep -Fq 'LANG_PROCESSOR_PROVIDER: ${LANG_PROCESSOR_PROVIDER:-vllm}' compose.yaml
grep -Fq 'LANG_PROCESSOR_URL: ${LANG_PROCESSOR_URL:-}' compose.yaml
grep -Fq 'LANG_PROCESSOR_MODEL: ${LANG_PROCESSOR_MODEL:-}' compose.yaml
grep -Fq 'LANG_PROCESSOR_API_KEY: ${LANG_PROCESSOR_API_KEY:-}' compose.yaml
grep -Fq 'LANG_PROCESSOR_THINK: ${LANG_PROCESSOR_THINK:-false}' compose.yaml
grep -Fq 'V0.2.28.12 Technical-Prose Language Classification' README.md
grep -Fq 'CC TOOL PROXY' src/proxy/runtime-telemetry.js
grep -Fq 'showStartupBanner' src/proxy/progress.js
grep -Fq 'languageProcessorAvailable' src/services/proxy-server.js


# V0.29.5 Visual Detail Contract
 test -f V0.29.5-更新說明.md
 grep -Fq 'V0.29.5 Visual Detail Contract' README.md
 grep -Fq 'VISUAL_DETAIL: SUFFICIENT' src/visual/vision-client.js
 grep -Fq 'VISUAL_DETAIL: NEEDS_ZOOM' src/visual/vision-client.js
 grep -Fq "'visual_detail_missing'" src/visual/vision-client.js
 grep -Fq "visual_detail: quality.visualDetail" src/visual/vision-client.js
 grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
 grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js
 grep -Fq "visualPromptVersion: config.cache?.visualPromptVersion || 'visual-v18'" src/proxy/media-adapters.js
 grep -Fq "evidenceContractVersion: config.cache?.evidenceContractVersion || 'evidence-v14'" src/proxy/media-adapters.js
 grep -Fq 'V0.29.5 CONTENT with SUFFICIENT detail' test/vision-client.test.js
 grep -Fq 'V0.29.5 CONTENT with NEEDS_ZOOM detail' test/vision-client.test.js
 grep -Fq 'V0.29.5 CONTENT missing VISUAL_DETAIL' test/vision-client.test.js
 grep -Fq 'V0.29.5 CONTENT plus NEEDS_ZOOM detail' test/media-adapters.test.js
 grep -Fq 'README documents V0.29.5 two-dimensional Visual Detail contract' test/deployment.test.js

# V0.29.4 Generic Zoom Fallback & Vision Contract Repair
 test -f V0.29.4-更新說明.md
 grep -Fq 'V0.29.4 Generic Zoom Fallback & Vision Contract Repair' README.md
 grep -Fq 'analyzeGenericZoomFallback' src/visual/generic-zoom.js
 grep -Fq 'allowNeedsZoomFallback: true' src/proxy/media-adapters.js
 grep -Fq "overlap: 0.15" src/proxy/media-adapters.js
 grep -Fq 'vision_contract_repaired' src/visual/vision-client.js
 grep -Fq "originTool" src/proxy/media-progress.js
 grep -Fq "sourceKind" src/proxy/media-progress.js
 grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
 grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js
 grep -Fq 'V0.29.5 CONTENT plus NEEDS_ZOOM detail' test/media-adapters.test.js
 grep -Fq 'V0.29.4 locally repairs CONTENT evidence marker' test/vision-client.test.js
 grep -Fq 'V0.29.4 localizes generic image zoom-tile progress phases' test/response-language.test.js

# V0.29.6 Generic Zoom Terminal Convergence
 test -f V0.29.6-更新說明.md
 grep -Fq 'V0.29.6 Generic Zoom Terminal Convergence' README.md
 grep -Fq 'terminal_status: resolved | partial | unreadable' README.md
 grep -Fq 'media_cache_skip' README.md
 grep -Fq 'control_tag_leak' README.md
 grep -Fq "allowNeedsZoomFallback: false" src/proxy/media-adapters.js
 grep -Fq "timeoutMs: Math.min(config.vllmVisionTimeoutMs ?? 120000, 30000)" src/proxy/media-adapters.js
 grep -Fq "onCacheEvent('media_cache_skip'" src/proxy/media-adapters.js
 grep -Fq "onDiagnostic('vision_zoom_summary'" src/proxy/media-adapters.js
 grep -Fq "reasons: ['control_tag_leak']" src/visual/vision-client.js
 grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
 grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js
 grep -Fq 'V0.29.6 unresolved generic zoom evidence' test/media-adapters.test.js
 grep -Fq 'V0.29.6 recoverable zoom tile timeout' test/media-adapters.test.js
 grep -Fq 'V0.29.6 persistent literal Vision control tags' test/vision-client.test.js

# V0.29.7 Failure-Aware Vision Recovery
 test -f V0.29.7-更新說明.md
 grep -Fq 'V0.29.7 Failure-Aware Vision Recovery' README.md
 grep -Fq 'MAX_VISION_RECOVERY_RETRIES = 3' src/visual/vision-client.js
 grep -Fq 'focused_recovery' src/visual/vision-client.js
 grep -Fq 'structured_extraction' src/visual/vision-client.js
 grep -Fq 'last_chance_salvage' src/visual/vision-client.js
 grep -Fq 'VISUAL_COMPLETENESS: COMPLETE | PARTIAL' src/visual/vision-client.js
 grep -Fq "recoveryContext: 'zoom_tile'" src/proxy/media-adapters.js
 grep -Fq "recoveryContext: 'zoom_tile'" src/parsers/pdf.js
 grep -Fq 'partial_count' src/proxy/media-adapters.js
 grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
 grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js
 grep -Fq 'V0.29.7 timeout recovery uses three distinct overlays' test/vision-client.test.js
 grep -Fq 'V0.29.7 one PARTIAL recovered zoom tile' test/media-adapters.test.js
 grep -Fq 'README documents V0.29.7 failure-aware Vision recovery' test/deployment.test.js


# V0.29.8 Visual Crop Terminal Recovery
 test -f V0.29.8-更新說明.md
 test -f V0.29.8-實作與驗證報告.md
 grep -Fq 'V0.29.8 Visual Crop Terminal Recovery' README.md
 grep -Fq "'visual_crop_depth_limit'" src/visual/crop-errors.js
 grep -Fq "vision_crop_budget_exhausted" src/visual/vision-client.js
 grep -Fq "recoveryContext === 'zoom_tile' ? Math.min(maxCropRounds, 1) : maxCropRounds" src/visual/vision-client.js
 grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
 grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js
 grep -Fq 'V0.29.8 crop depth exhaustion becomes non-fatal recovery' test/vision-client.test.js
 grep -Fq 'V0.29.8 zoom tile allows one precise crop round' test/vision-client.test.js
 grep -Fq 'V0.29.8 stubborn zoom tile crop request after budget exhaustion' test/vision-client.test.js
 grep -Fq 'README documents V0.29.8 visual crop terminal recovery' test/deployment.test.js


# V0.29.9 Historical Media Continuation Dedup
 test -f V0.29.9-更新說明.md
 test -f V0.29.9-實作與驗證報告.md
 test -f src/cache/media-continuation-cache.js
 grep -Fq 'V0.29.9 Historical Media Continuation Dedup' README.md
 grep -Fq 'media_continuation_cache_hit' src/services/proxy-server.js
 grep -Fq 'media_continuation_cache_write' src/services/proxy-server.js
 grep -Fq 'media_continuation_cache_reset' src/services/proxy-server.js
 grep -Fq 'continuationCacheWriter' src/proxy/media-adapters.js
 grep -Fq 'continuationFreshMessageIndex' src/proxy/media-adapters.js
 grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
 grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js
 grep -Fq 'V0.29.9 same-session tool continuation reuses non-persistent historical image evidence' test/proxy-server.test.js
 grep -Fq 'V0.29.9 terminal unavailable image evidence is continuation-reusable' test/media-adapters.test.js
 grep -Fq 'README documents V0.29.9 historical media continuation dedup' test/deployment.test.js


# V0.29.10 Authoritative VLLM_BASE_MODEL Routing
 test -f V0.29.10-更新說明.md
 test -f V0.29.10-實作與驗證報告.md
 test -f src/proxy/base-model.js
 grep -Fq 'V0.29.10 Authoritative VLLM_BASE_MODEL Routing' README.md
 grep -Fq 'vllmBaseModel' src/config.js
 grep -Fq 'rewriteBaseRequest' src/services/proxy-server.js
 grep -Fq 'rewriteBaseJsonBody' src/proxy/bypass.js
 grep -Fq 'base_model_selected' src/services/proxy-server.js
 grep -Fq 'base_model_selected' src/proxy/bypass.js
 grep -Fq 'V0.29.10 VLLM_BASE_MODEL is optional authoritative Base model metadata' test/config.test.js
 grep -Fq 'V0.29.10 forwardTransparent overrides JSON model only for the Base upstream copy' test/bypass.test.js
 grep -Fq 'V0.29.10 managed Base upstream overrides client model and emits selection diagnostic' test/proxy-server.test.js
 grep -Fq 'README documents V0.29.10 authoritative VLLM_BASE_MODEL routing' test/deployment.test.js
 grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
 grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js

echo 'Verification complete.'


# V0.29.11 Base Response Mode-aware Timeout
 test -f V0.29.11-更新說明.md
 test -f V0.29.11-實作與驗證報告.md
 grep -Fq 'VLLM_BASE_RESPONSE_MODE=auto' .env.example
 grep -Fq 'MANAGED_MODEL_STALL_TIMEOUT_MS=90000' .env.example
 grep -Fq 'VLLM_BASE_RESPONSE_MODE: ${VLLM_BASE_RESPONSE_MODE:-auto}' compose.yaml
 grep -Fq 'MANAGED_MODEL_STALL_TIMEOUT_MS: ${MANAGED_MODEL_STALL_TIMEOUT_MS:-90000}' compose.yaml
 grep -Fq 'V0.29.11 Base Response Mode-aware Timeout' README.md
 grep -Fq 'VLLM_BASE_RESPONSE_MODE' src/config.js
 grep -Fq 'MANAGED_MODEL_STALL_TIMEOUT_MS' src/config.js
 grep -Fq 'base_response_mode_selected' src/services/proxy-server.js
 grep -Fq 'V0.29.11 Base response mode defaults to auto and validates explicit modes' test/config.test.js
 grep -Fq 'V0.29.11 buffered Base response may stay silent after first bytes until the round completes' test/managed-loop.test.js
 grep -Fq 'V0.29.11 forced buffered Base mode does not treat SSE-framed coarse silence as a stall' test/proxy-server.test.js
 grep -Fq "pipelineVersion: 'media-v8'" src/config.js
 grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
 grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js


# V0.29.12 Runtime Memory Lifecycle Hardening
 test -f V0.29.12-更新說明.md
 test -f V0.29.12-實作與驗證報告.md
 test -f test/progress-memory.test.js
 grep -Fq 'V0.29.12 Runtime Memory Lifecycle Hardening' README.md
 grep -Fq 'async dispose()' src/proxy/progress.js
 grep -Fq 'await progress?.dispose?.()' src/services/proxy-server.js
 grep -Fq 'progressStreamFactory' src/services/proxy-server.js
 grep -Fq 'DEFAULT_MAX_BYTES = 64 * 1024 * 1024' src/cache/media-continuation-cache.js
 grep -Fq 'DEFAULT_MAX_BYTES_PER_SESSION = 16 * 1024 * 1024' src/cache/media-continuation-cache.js
 grep -Fq 'continuation: mediaContinuationCache.health()' src/services/proxy-server.js
 grep -Fq 'V0.29.12 disposed ProgressStream is collectible' test/progress-memory.test.js
 grep -Fq 'V0.29.12 client disconnect disposes the active ProgressStream exactly once' test/proxy-server.test.js
 grep -Fq 'V0.29.12 continuation cache evicts LRU entries when a session exceeds its byte budget' test/media-continuation-cache.test.js
 grep -Fq "pipelineVersion: 'media-v8'" src/config.js
 grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
 grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js


# V0.29.13 Claude Code Sub-Agent UI Isolation foundation
 test -f V0.29.13-更新說明.md
 test -f V0.29.13-實作與驗證報告.md
 grep -Fq 'V0.29.13 Claude Code Sub-Agent UI Isolation' README.md
 grep -Fq "x-claude-code-agent-id" src/services/proxy-server.js
 grep -Fq "x-claude-code-parent-agent-id" src/services/proxy-server.js
 grep -Fq 'semanticProgressEnabled' src/proxy/progress.js
 grep -Fq 'V0.29.13 silent semantic progress keeps state and liveness without creating assistant text content' test/progress.test.js

# V0.29.14 Parent Agent Label Isolation and Sub-Agent Progress Restoration
 test -f V0.29.14-更新說明.md
 test -f V0.29.14-實作與驗證報告.md
 grep -Fq 'V0.29.14 Parent Agent Label Isolation' README.md
 grep -Fq 'parent_agent_progress_isolated' src/services/proxy-server.js
 grep -Fq 'subagent_progress_enabled' src/services/proxy-server.js
 grep -Fq "return name === 'agent' || name === 'task';" src/services/proxy-server.js
 grep -Fq 'V0.29.14 sub-agent headers restore semantic progress while ordinary requests remain enabled' test/proxy-server.test.js
 grep -Fq 'V0.29.14 parent request with Agent tool keeps Agent tool_use at index zero while sub-agent execution keeps progress visible' test/proxy-server.test.js
 grep -Fq 'V0.29.14 sub-agent progress does not consume the parent session startup banner claim' test/proxy-server.test.js
 grep -Fq 'V0.29.14 legacy Task dispatch tool also isolates parent semantic progress' test/proxy-server.test.js
 grep -Fq "pipelineVersion: 'media-v8'" src/config.js
 grep -Fq "visualPromptVersion: 'visual-v18'" src/config.js
 grep -Fq "evidenceContractVersion: 'evidence-v14'" src/config.js
