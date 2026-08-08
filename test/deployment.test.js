import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const compose = await fs.readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
const envExample = await fs.readFile(new URL('../.env.example', import.meta.url), 'utf8');
const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');

test('Compose uses one official Node container with persistent source clone and fast-forward pull', () => {
  assert.match(compose, /image:\s*node:22-bookworm-slim/);
  const servicesBlock = compose.split('\nvolumes:\n', 1)[0];
  assert.equal((servicesBlock.match(/^  [a-zA-Z0-9_-]+:\s*$/gm) || []).length, 1);
  assert.match(compose, /git clone --depth 1 --branch main/);
  assert.match(compose, /git -C \"\$\$SOURCE_DIR\" pull --ff-only origin main/);
  assert.match(compose, /proxy-source:\s*\/workspace\/vllm-cc-tools-proxy/);
  assert.match(compose, /proxy-npm-cache:\s*\/root\/.npm/);
  assert.match(compose, /proxy-apt-cache:\s*\/var\/cache\/apt\/archives/);
  assert.match(compose, /proxy-data:\s*\/var\/lib\/vllm-cc-tools-proxy/);
  assert.match(compose, /^volumes:\s*\n  proxy-source:\s*\n  proxy-npm-cache:\s*\n  proxy-apt-cache:\s*\n  proxy-data:/m);
  assert.match(compose, /DEPENDENCY_FINGERPRINT/);
  assert.doesNotMatch(compose, /(?<!\$)\$SOURCE_DIR/);
  assert.doesNotMatch(compose, /(?<!\$)\$DEPENDENCY_FINGERPRINT/);
  assert.match(compose, /npm ci --omit=dev/);
  assert.match(compose, /node_modules\/.dependency-fingerprint/);
  assert.doesNotMatch(compose, /rm -rf \/workspace\/vllm-cc-tools-proxy/);
  assert.doesNotMatch(compose, /bootstrap\.sh/);
  assert.doesNotMatch(compose, /document-parser:|image-parser:|ocr-service:/);
});

test('ENV example preserves base, timeout, vision and managed fetch variables', () => {
  for (const name of ['VLLM_BASE_URL','VLLM_BASE_API_KEY','VLLM_BASE_CONNECT_TIMEOUT_MS','VLLM_BASE_HEADERS_TIMEOUT_MS','VLLM_BASE_BODY_TIMEOUT_MS','VLLM_VISION_URL','VLLM_VISION_MODEL','VLLM_VISION_API_KEY','VLLM_VISION_PROVIDER','VLLM_VISION_THINK','WEB_FETCH_API_KEY','WEB_FETCH_PROCESSOR_ENABLED','WEB_FETCH_PROCESSOR_PROVIDER','WEB_FETCH_PROCESSOR_URL','WEB_FETCH_PROCESSOR_MODEL','WEB_FETCH_PROCESSOR_API_KEY','WEB_FETCH_PROCESSOR_THINK','WEB_FETCH_PROCESSOR_CONCURRENCY','WEB_FETCH_PROCESSOR_TIMEOUT_MS','MODEL_RESPONSE_LANGUAGE','LOG_PROTOCOL_SNIPPETS']) {
    assert.match(envExample, new RegExp(`^${name}=`, 'm'));
  }
  for (const removed of ['DOCUMENT_PARSER_URL','IMAGE_PARSER_URL','OCR_SERVICE_URL','VISION_SERVICE_URL','AUTO_UPDATE']) {
    assert.doesNotMatch(envExample, new RegExp(`^${removed}=`, 'm'));
  }
  assert.match(envExample, /^CONCURRENCY_PROFILE=default$/m);
  assert.match(envExample, /^MEDIA_CACHE_MAX_MB=0$/m);
  assert.match(envExample, /^VLLM_BASE_CONNECT_TIMEOUT_MS=10000$/m);
  assert.match(envExample, /^VLLM_BASE_HEADERS_TIMEOUT_MS=900000$/m);
  assert.match(envExample, /^VLLM_BASE_BODY_TIMEOUT_MS=900000$/m);
});

test('Compose exposes the simple concurrency profile without adding queue services', () => {
  assert.match(compose, /CONCURRENCY_PROFILE:\s*\$\{CONCURRENCY_PROFILE:-default\}/);
  assert.match(compose, /MANAGED_MAX_CONCURRENCY:\s*\$\{MANAGED_MAX_CONCURRENCY:-\}/);
  assert.match(compose, /MANAGED_MAX_QUEUE:\s*\$\{MANAGED_MAX_QUEUE:-\}/);
  assert.match(compose, /MANAGED_QUEUE_TIMEOUT_MS:\s*\$\{MANAGED_QUEUE_TIMEOUT_MS:-\}/);
  assert.match(compose, /MANAGED_TASK_TIMEOUT_MS:\s*\$\{MANAGED_TASK_TIMEOUT_MS:-1800000\}/);
  assert.match(compose, /MANAGED_MODEL_ROUND_TIMEOUT_MS:\s*\$\{MANAGED_MODEL_ROUND_TIMEOUT_MS:-360000\}/);
  assert.match(compose, /VISION_MAX_CONCURRENCY:\s*\$\{VISION_MAX_CONCURRENCY:-\}/);
  assert.match(compose, /MEDIA_CACHE_MAX_MB:\s*\$\{MEDIA_CACHE_MAX_MB:-0\}/);
  assert.match(compose, /VLLM_VISION_PROVIDER:\s*\$\{VLLM_VISION_PROVIDER:-vllm\}/);
  assert.match(compose, /VLLM_VISION_THINK:\s*\$\{VLLM_VISION_THINK:-false\}/);
  assert.match(compose, /PROGRESS_HEARTBEAT_MS:\s*\$\{PROGRESS_HEARTBEAT_MS:-30000\}/);
  assert.match(compose, /SSE_DRAIN_TIMEOUT_MS:\s*\$\{SSE_DRAIN_TIMEOUT_MS:-10000\}/);
  assert.match(compose, /WEB_FETCH_API_KEY:\s*\$\{WEB_FETCH_API_KEY:-\}/);
  assert.match(compose, /WEB_FETCH_PROCESSOR_ENABLED:\s*\$\{WEB_FETCH_PROCESSOR_ENABLED:-true\}/);
  assert.match(compose, /WEB_FETCH_PROCESSOR_PROVIDER:\s*\$\{WEB_FETCH_PROCESSOR_PROVIDER:-vllm\}/);
  assert.match(compose, /WEB_FETCH_PROCESSOR_URL:\s*\$\{WEB_FETCH_PROCESSOR_URL:-\}/);
  assert.match(compose, /WEB_FETCH_PROCESSOR_MODEL:\s*\$\{WEB_FETCH_PROCESSOR_MODEL:-\}/);
  assert.match(compose, /WEB_FETCH_PROCESSOR_API_KEY:\s*\$\{WEB_FETCH_PROCESSOR_API_KEY:-\}/);
  assert.match(compose, /WEB_FETCH_PROCESSOR_THINK:\s*\$\{WEB_FETCH_PROCESSOR_THINK:-false\}/);
  assert.match(compose, /WEB_FETCH_PROCESSOR_CONCURRENCY:\s*\$\{WEB_FETCH_PROCESSOR_CONCURRENCY:-3\}/);
  assert.match(compose, /WEB_FETCH_PROCESSOR_TIMEOUT_MS:\s*\$\{WEB_FETCH_PROCESSOR_TIMEOUT_MS:-300000\}/);
  assert.match(compose, /MODEL_RESPONSE_LANGUAGE:\s*\$\{MODEL_RESPONSE_LANGUAGE:-en-US\}/);
  assert.match(compose, /LOG_PROTOCOL_SNIPPETS:\s*\$\{LOG_PROTOCOL_SNIPPETS:-false\}/);
  assert.match(compose, /DIAGNOSTIC_WEB_TOOL_PASSTHROUGH:\s*\$\{DIAGNOSTIC_WEB_TOOL_PASSTHROUGH:-false\}/);
  assert.match(compose, /DIAGNOSTIC_WEB_SEARCH_PASSTHROUGH_COUNT:\s*\$\{DIAGNOSTIC_WEB_SEARCH_PASSTHROUGH_COUNT:-1\}/);
  assert.match(compose, /DIAGNOSTIC_WEB_FETCH_PASSTHROUGH_COUNT:\s*\$\{DIAGNOSTIC_WEB_FETCH_PASSTHROUGH_COUNT:-1\}/);
  assert.match(compose, /DIAGNOSTIC_WEB_TOOL_TRACE:\s*\$\{DIAGNOSTIC_WEB_TOOL_TRACE:-false\}/);
  assert.match(compose, /DIAGNOSTIC_WEB_TOOL_TRACE_DIR:\s*\$\{DIAGNOSTIC_WEB_TOOL_TRACE_DIR:-\/var\/lib\/vllm-cc-tools-proxy\/diagnostics\/web-tool-trace\}/);
  assert.match(compose, /VLLM_BASE_CONNECT_TIMEOUT_MS:\s*\$\{VLLM_BASE_CONNECT_TIMEOUT_MS:-10000\}/);
  assert.match(compose, /VLLM_BASE_HEADERS_TIMEOUT_MS:\s*\$\{VLLM_BASE_HEADERS_TIMEOUT_MS:-900000\}/);
  assert.match(compose, /VLLM_BASE_BODY_TIMEOUT_MS:\s*\$\{VLLM_BASE_BODY_TIMEOUT_MS:-900000\}/);
  assert.match(envExample, /^PROGRESS_HEARTBEAT_MS=30000$/m);
  assert.match(envExample, /^SSE_DRAIN_TIMEOUT_MS=10000$/m);
  assert.match(envExample, /^MANAGED_TASK_TIMEOUT_MS=1800000$/m);
  assert.match(envExample, /^MANAGED_MODEL_ROUND_TIMEOUT_MS=360000$/m);
  assert.match(envExample, /^WEB_FETCH_PROCESSOR_PROVIDER=vllm$/m);
  assert.match(envExample, /^WEB_FETCH_PROCESSOR_CONCURRENCY=3$/m);
  assert.match(envExample, /^WEB_FETCH_PROCESSOR_TIMEOUT_MS=300000$/m);
  assert.match(envExample, /^MODEL_RESPONSE_LANGUAGE=en-US$/m);
  assert.match(envExample, /^DIAGNOSTIC_WEB_TOOL_PASSTHROUGH=false$/m);
  assert.match(envExample, /^DIAGNOSTIC_WEB_SEARCH_PASSTHROUGH_COUNT=1$/m);
  assert.match(envExample, /^DIAGNOSTIC_WEB_FETCH_PASSTHROUGH_COUNT=1$/m);
  assert.match(envExample, /^DIAGNOSTIC_WEB_TOOL_TRACE=false$/m);
  assert.match(envExample, /^DIAGNOSTIC_WEB_TOOL_TRACE_DIR=\/var\/lib\/vllm-cc-tools-proxy\/diagnostics\/web-tool-trace$/m);
  assert.doesNotMatch(compose, /redis:|rabbitmq:|queue-service:/);
});

test('package version is V0.2.25.1 hotfix metadata', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.version, '0.2.25+hotfix.1');
  assert.equal(lock.version, '0.2.25+hotfix.1');
  assert.equal(lock.packages[''].version, '0.2.25+hotfix.1');
});


test('current progress protocol does not generate the V0.2.2 nonce sentinel', async () => {
  const source = await fs.readFile(new URL('../src/proxy/progress.js', import.meta.url), 'utf8');
  const generatorSection = source.slice(source.indexOf('export class ProgressStream'));
  assert.doesNotMatch(generatorSection, /VLLMCCP:v1:/);
  assert.match(source, /目前處理進度/);
  assert.doesNotMatch(source, /function createProgressMarkers/);
});


test('README documents file-based protocol diagnostics without adding another ENV switch', () => {
  assert.match(readme, /managed_final_response_diagnostic_file/);
  assert.match(readme, /docker cp/);
  assert.match(readme, /protocol-snippets/);
  const section = readme.slice(readme.indexOf('## Protocol anomaly diagnostics'), readme.indexOf('## Resource profiles'));
  assert.doesNotMatch(section, /managed_final_response_anomaly_snippet/);
  assert.doesNotMatch(section, /managed_final_response_input_protocol_snippet/);
  assert.doesNotMatch(envExample, /^LOG_PROTOCOL_SNIPPETS_DIR=/m);
});


test('README documents agent-safe recovery routing', () => {
  assert.match(readme, /V0\.2\.14 recovery routing/);
  assert.match(readme, /Final-channel recovery/);
  assert.match(readme, /Continuation recovery/);
  assert.match(readme, /preserves the original tools and tool choice/);
  assert.match(readme, /managed_final_response_recovery_tool_dispatch/);
  assert.match(readme, /response_recovery_exhausted/);
});


test('README documents V0.2.15 proxy-turn progress semantics', () => {
  assert.match(readme, /V0\.2\.15 proxy-turn progress semantics/);
  assert.match(readme, /handoff_to_claude_code/);
  assert.match(readme, /returning_visible_response/);
  assert.match(readme, /terminal_for_proxy/);
  assert.match(readme, /terminal_for_claude_task/);
  const section = readme.slice(readme.indexOf('## V0.2.15 proxy-turn progress semantics'), readme.indexOf('## V0.2.14 recovery routing'));
  assert.doesNotMatch(section, /處理完成；正在回傳模型結果/);
});


test('README documents V0.2.17 Anthropic usage preservation and auto-compact compatibility', () => {
  assert.match(readme, /V0\.2\.16 Anthropic usage preservation/);
  assert.match(readme, /\/v1\/messages\/count_tokens/);
  assert.match(readme, /managed_usage_preflight_succeeded/);
  assert.match(readme, /managed_usage_preflight_failed/);
  assert.match(readme, /CLAUDE_CODE_AUTO_COMPACT_WINDOW=180000/);
  assert.doesNotMatch(envExample, /^USAGE_PREFLIGHT_/m);
});

test('README documents V0.2.17 native web tool normalization and policy boundaries', () => {
  assert.match(readme, /V0\.2\.17 native web tool normalization/);
  assert.match(readme, /web_search_\*/);
  assert.match(readme, /web_fetch_\*/);
  assert.match(readme, /max_uses/);
  assert.match(readme, /allowed_domains/);
  assert.match(readme, /blocked_domains/);
  assert.match(readme, /native_web_tools_normalized/);
  assert.match(readme, /not emulated as Anthropic-native citations/);
});


test('README documents V0.2.18 response-side native web containment', () => {
  assert.match(readme, /V0\.2\.18 response-side native web containment/);
  assert.match(readme, /server_tool_use/);
  assert.match(readme, /web_search_tool_result/);
  assert.match(readme, /web_fetch_tool_result/);
  assert.match(readme, /native_web_response_contained/);
  assert.match(readme, /native_web_mixed_tool_deferred/);
  assert.match(readme, /Did 0 searches/);
});

test('README documents V0.2.19 managed stability gates', () => {
  assert.match(readme, /V0\.2\.19 managed stability gates/);
  assert.match(readme, /MANAGED_TASK_TIMEOUT_MS/);
  assert.match(readme, /managed_no_progress/);
  assert.match(readme, /managed_model_timeout/);
  assert.match(readme, /managed_task_timeout/);
  assert.match(readme, /laguna_runtime_contract_violation/);
  assert.match(readme, /poolside_v1/);
  assert.match(readme, /tool_result/);
});


test('README documents V0.2.19.1 parallel WebFetch and slow-model budgets', () => {
  assert.match(readme, /V0\.2\.19\.1/);
  assert.match(readme, /WEB_FETCH_PROCESSOR_PROVIDER/);
  assert.match(readme, /WEB_FETCH_PROCESSOR_CONCURRENCY/);
  assert.match(readme, /WEB_FETCH_PROCESSOR_TIMEOUT_MS/);
  assert.match(readme, /MANAGED_MODEL_ROUND_TIMEOUT_MS/);
  assert.match(readme, /1800000/);
  assert.match(readme, /managed_final_round_reserved/);
  assert.match(readme, /allowed_domains/);
});


test('README documents V0.2.19.2 deterministic promotion and tool-description isolation', () => {
  assert.match(readme, /V0\.2\.19\.2/);
  assert.match(readme, /deterministic final promotion/i);
  assert.match(readme, /managed_final_response_promoted/);
  assert.match(readme, /protocol_tool_descriptions_sanitized/);
  assert.match(readme, /fields named `description`/);
});


test('README documents V0.2.19.3 WebFetch Processor provider routing', () => {
  assert.match(readme, /V0\.2\.19\.3 WebFetch Processor provider routing/);
  assert.match(readme, /WEB_FETCH_PROCESSOR_PROVIDER/);
  assert.match(readme, /reasoning_effort/);
  assert.match(readme, /v1\/chat\/completions/);
});



test('README documents V0.2.23 response language localization and English fallback', () => {
  assert.match(readme, /V0\.2\.23 response language localization/);
  assert.match(readme, /MODEL_RESPONSE_LANGUAGE=zh-TW/);
  for (const locale of ['zh-TW', 'zh-CN', 'en-US', 'ja-JP', 'ko-KP']) assert.match(readme, new RegExp(locale));
  assert.match(readme, /missing, blank, or unsupported/i);
  assert.match(readme, /en-US/);
  assert.match(readme, /Proxy progress\/status/i);
  assert.match(readme, /WebFetch Processor/i);
  assert.match(readme, /technical literals/i);
});

test('README documents V0.2.22 Claude Code-owned Web lifecycle', () => {
  assert.match(readme, /V0\.2\.22 Claude Code-owned Web lifecycle/);
  assert.match(readme, /ordinary `WebSearch` \/ `WebFetch`/);
  assert.match(readme, /web_search_YYYYMMDD/);
  assert.match(readme, /Web page content:/);
  assert.match(readme, /awesome-web-fetch fallback/);
  assert.match(readme, /claude_code_client_tool/);
});

test('README documents V0.2.21 diagnostic built-in WebSearch/WebFetch trace', () => {
  assert.match(readme, /V0\.2\.21-diagnostic\.1/);
  assert.match(readme, /DIAGNOSTIC_WEB_TOOL_PASSTHROUGH/);
  assert.match(readme, /client_tool_result_returned/);
  assert.match(readme, /client_unmanaged_request/);
  assert.match(readme, /web-tool-trace/);
});

test('README documents V0.2.21 native Claude Code web-tool UI bridge', () => {
  assert.match(readme, /V0\.2\.21 Native Claude Code Web Tool UI Bridge/);
  assert.match(readme, /\"input\":\{\}/);
  assert.match(readme, /encrypted_content/);
  assert.match(readme, /server_web_ui_bridge_selected/);
  assert.match(readme, /native_server_tool/);
  assert.match(readme, /visible_progress/);
  assert.match(readme, /Web Search/);
  assert.match(readme, /Web Fetch/);
});

test('README documents V0.2.20 unified WebSearch and WebFetch server-tool bridge', () => {
  assert.match(readme, /V0\.2\.20 unified Web Server Tool Bridge/);
  assert.match(readme, /server_tool_use/);
  assert.match(readme, /web_search_tool_result/);
  assert.match(readme, /web_fetch_tool_result/);
  assert.match(readme, /web_search_requests/);
  assert.match(readme, /web_fetch_requests/);
  assert.match(readme, /web_search_YYYYMMDD/);
  assert.match(readme, /web_fetch_YYYYMMDD/);
  assert.match(readme, /mixed server \+ client tools/i);
  assert.match(readme, /mcp__searxng__web_search/);
});

test('README documents V0.2.23.1 language-policy boundary hotfix', () => {
  assert.match(readme, /V0\.2\.23\.1 response-language boundary hotfix/);
  assert.match(readme, /Respond in Traditional Chinese \(zh-TW\)\./);
  assert.match(readme, /0\.2\.23\+hotfix\.1/);
  assert.match(readme, /\\n\\n/);
});


test('README documents V0.2.23.2 native WebSearch forced-choice hotfix', () => {
  assert.match(readme, /V0\.2\.23\.2 native WebSearch forced-choice hotfix/);
  assert.match(readme, /tool_choice/);
  assert.match(readme, /forced_tool_choice=true/);
  assert.match(readme, /managed_forced_tool_choice_satisfied/);
  assert.match(readme, /0\.2\.23\+hotfix\.2/);
  assert.match(readme, /Mixed native Search plus any other tool/);
});


test('README documents V0.2.24 cumulative Base vLLM response byte progress', () => {
  assert.match(readme, /V0\.2\.24 cumulative Base vLLM response byte progress/);
  assert.match(readme, /B \/ KB \/ MB \/ GB/);
  assert.match(readme, /Base vLLM response body/);
  assert.match(readme, /目前處理進度（已收到 20 B）：/);
  assert.match(readme, /主模型仍在處理本輪請求，已等待 30 秒（已收到 1\.22 KB）/);
});


test('README documents V0.2.25 multi-Agent research scheduling', () => {
  assert.match(readme, /V0\.2\.25 multi-Agent research scheduling/);
  assert.match(readme, /native WebSearch fast lane/i);
  assert.match(readme, /100000/);
  assert.match(readme, /large-context gate/i);
  assert.match(readme, /managed_model_stall_timeout/);
  assert.match(readme, /not armed during TTFT/i);
  assert.match(readme, /native_web_search/);
  assert.match(readme, /large_context/);
});


test('README documents V0.2.25.1 managed SSE streaming hotfix', () => {
  assert.match(readme, /V0\.2\.25\.1 managed SSE streaming hotfix/);
  assert.match(readme, /stream:true/);
  assert.match(readme, /Anthropic SSE/);
  assert.match(readme, /receivedBytes/);
  assert.match(readme, /managed_model_stall_timeout/);
});
