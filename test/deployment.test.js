import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const compose = await fs.readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
const envExample = await fs.readFile(new URL('../.env.example', import.meta.url), 'utf8');
const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
const proxyServerSource = await fs.readFile(new URL('../src/services/proxy-server.js', import.meta.url), 'utf8');
const managedLoopSource = await fs.readFile(new URL('../src/proxy/managed-loop.js', import.meta.url), 'utf8');
const sseCollectorSource = await fs.readFile(new URL('../src/proxy/anthropic-sse-collector.js', import.meta.url), 'utf8');
const assetRegistrySource = await fs.readFile(new URL('../src/visual/asset-registry.js', import.meta.url), 'utf8');
const genericZoomSource = await fs.readFile(new URL('../src/visual/generic-zoom.js', import.meta.url), 'utf8');
const visionClientSource = await fs.readFile(new URL('../src/visual/vision-client.js', import.meta.url), 'utf8');
const serverCapabilitiesSource = await fs.readFile(new URL('../src/proxy/server-capabilities.js', import.meta.url), 'utf8');
const toolSearchSource = await fs.readFile(new URL('../src/proxy/tool-search.js', import.meta.url), 'utf8');
const mediaAdaptersSource = await fs.readFile(new URL('../src/proxy/media-adapters.js', import.meta.url), 'utf8');

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
  for (const name of ['VLLM_BASE_URL','VLLM_BASE_MODEL','VLLM_BASE_RESPONSE_MODE','VLLM_BASE_API_KEY','VLLM_BASE_CONNECT_TIMEOUT_MS','VLLM_BASE_HEADERS_TIMEOUT_MS','VLLM_BASE_BODY_TIMEOUT_MS','CONTEXT_COMPACT_PROVIDER','CONTEXT_COMPACT_URL','CONTEXT_COMPACT_MODEL','CONTEXT_COMPACT_API_KEY','CONTEXT_COMPACT_THINK','VLLM_VISION_URL','VLLM_VISION_MODEL','VLLM_VISION_API_KEY','VLLM_VISION_PROVIDER','VLLM_VISION_THINK','VLLM_VISION_TIMEOUT_MS','WEB_FETCH_API_KEY','WEB_FETCH_PROCESSOR_ENABLED','WEB_FETCH_PROCESSOR_PROVIDER','WEB_FETCH_PROCESSOR_URL','WEB_FETCH_PROCESSOR_MODEL','WEB_FETCH_PROCESSOR_API_KEY','WEB_FETCH_PROCESSOR_THINK','WEB_FETCH_PROCESSOR_CONCURRENCY','WEB_FETCH_PROCESSOR_TIMEOUT_MS','MODEL_RESPONSE_LANGUAGE','MANAGED_MODEL_STALL_TIMEOUT_MS','LOG_PROTOCOL_SNIPPETS']) {
    assert.match(envExample, new RegExp(`^${name}=`, 'm'));
  }
  for (const removed of ['DOCUMENT_PARSER_URL','IMAGE_PARSER_URL','OCR_SERVICE_URL','VISION_SERVICE_URL','AUTO_UPDATE']) {
    assert.doesNotMatch(envExample, new RegExp(`^${removed}=`, 'm'));
  }
  assert.doesNotMatch(envExample, /^CONCURRENCY_PROFILE=/m);
  assert.doesNotMatch(envExample, /^MANAGED_MAX_CONCURRENCY=/m);
  assert.doesNotMatch(envExample, /^MANAGED_MAX_QUEUE=/m);
  assert.doesNotMatch(envExample, /^MANAGED_QUEUE_TIMEOUT_MS=/m);
  assert.match(envExample, /^MEDIA_CACHE_MAX_MB=0$/m);
  assert.match(envExample, /^VLLM_BASE_MODEL=$/m);
  assert.match(envExample, /^VLLM_BASE_RESPONSE_MODE=auto$/m);
  assert.match(envExample, /^MANAGED_MODEL_STALL_TIMEOUT_MS=90000$/m);
  assert.match(envExample, /^VLLM_BASE_CONNECT_TIMEOUT_MS=10000$/m);
  assert.match(envExample, /^VLLM_BASE_HEADERS_TIMEOUT_MS=900000$/m);
  assert.match(envExample, /^VLLM_BASE_BODY_TIMEOUT_MS=900000$/m);
  assert.match(envExample, /^VLLM_VISION_TIMEOUT_MS=120000$/m);
});

test('Compose exposes no Base/Managed Proxy queue settings and keeps only auxiliary limits', () => {
  assert.doesNotMatch(compose, /CONCURRENCY_PROFILE:/);
  assert.doesNotMatch(compose, /MANAGED_MAX_CONCURRENCY:/);
  assert.doesNotMatch(compose, /MANAGED_MAX_QUEUE:/);
  assert.doesNotMatch(compose, /MANAGED_QUEUE_TIMEOUT_MS:/);
  assert.match(compose, /VLLM_BASE_MODEL:\s*\$\{VLLM_BASE_MODEL:-\}/);
  assert.match(compose, /VLLM_BASE_RESPONSE_MODE:\s*\$\{VLLM_BASE_RESPONSE_MODE:-auto\}/);
  assert.match(compose, /MANAGED_TASK_TIMEOUT_MS:\s*\$\{MANAGED_TASK_TIMEOUT_MS:-\}/);
  assert.match(compose, /MANAGED_MODEL_ROUND_TIMEOUT_MS:\s*\$\{MANAGED_MODEL_ROUND_TIMEOUT_MS:-360000\}/);
  assert.match(compose, /MANAGED_MODEL_STALL_TIMEOUT_MS:\s*\$\{MANAGED_MODEL_STALL_TIMEOUT_MS:-90000\}/);
  assert.match(compose, /VISION_MAX_CONCURRENCY:\s*\$\{VISION_MAX_CONCURRENCY:-\}/);
  assert.match(compose, /VLLM_VISION_TIMEOUT_MS:\s*\$\{VLLM_VISION_TIMEOUT_MS:-120000\}/);
  assert.match(compose, /MEDIA_CACHE_MAX_MB:\s*\$\{MEDIA_CACHE_MAX_MB:-0\}/);
  assert.match(compose, /CONTEXT_COMPACT_PROVIDER:\s*\$\{CONTEXT_COMPACT_PROVIDER:-vllm\}/);
  assert.match(compose, /CONTEXT_COMPACT_URL:\s*\$\{CONTEXT_COMPACT_URL:-\}/);
  assert.match(compose, /CONTEXT_COMPACT_MODEL:\s*\$\{CONTEXT_COMPACT_MODEL:-\}/);
  assert.match(compose, /CONTEXT_COMPACT_API_KEY:\s*\$\{CONTEXT_COMPACT_API_KEY:-\}/);
  assert.match(compose, /CONTEXT_COMPACT_THINK:\s*\$\{CONTEXT_COMPACT_THINK:-false\}/);
  assert.match(compose, /WEB_FETCH_PROCESSOR_CONCURRENCY:\s*\$\{WEB_FETCH_PROCESSOR_CONCURRENCY:-3\}/);
});



test('README documents V0.2.28.16 native statusLine while preserving 30-second SSE liveness', () => {
  assert.match(readme, /V0\.2\.28\.16 Claude Code Native StatusLine \+ SSE Liveness/);
  assert.match(readme, /PROGRESS_HEARTBEAT_MS.*30000/s);
  assert.match(readme, /GET \/cc-tool-proxy\/status\/<session-id>/);
  assert.match(readme, /refreshInterval.*1/s);
  assert.match(readme, /cc-tool-proxy-statusline\.js/);
  assert.match(readme, /append-only heartbeat/i);
  assert.match(readme, /zh-TW.*zh-CN.*en-US.*ja-JP.*ko-KP/s);
});
test('README documents V0.2.28.14 multilingual runtime progress telemetry', () => {
  assert.match(readme, /V0\.2\.28\.14 Multilingual Runtime Progress Telemetry/);
  assert.match(readme, /WAITING.*THINKING.*RESPONDING.*STALLED/s);
  assert.match(readme, /recent upstream throughput/i);
  assert.match(readme, /zh-TW.*zh-CN.*en-US.*ja-JP.*ko-KP/s);
  assert.match(readme, /no new timer/i);
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


test('README documents V0.2.25.2 first-byte progress hotfix', () => {
  assert.match(readme, /V0\.2\.25\.2 first-byte progress hotfix/);
  assert.match(readme, /managed_model_first_byte_received/);
  assert.match(readme, /upstream_received_bytes/);
  assert.match(readme, /model_elapsed_ms/);
  assert.match(readme, /first upstream chunk/i);
});


test('README documents V0.2.26 recursive Vision evidence pipeline', () => {
  assert.match(readme, /V0\.2\.26 recursive Vision evidence pipeline/i);
  assert.match(readme, /before Base .*count_tokens/i);
  assert.match(readme, /adaptive.*220.*320.*DPI/is);
  assert.match(readme, /original PDF/i);
  assert.match(readme, /original image pixels/i);
  assert.match(readme, /recursive.*crop/i);
  assert.match(readme, /vision_upstream_request/);
  assert.match(readme, /media-v6/);
  assert.match(readme, /visual-v5/);
});




test('README documents V0.2.27 routed schematic PDF pipeline', () => {
  assert.match(readme, /V0\.2\.27.*schematic/i);
  assert.match(readme, /TEXT.*DIAGRAM.*SCHEMATIC.*DENSE_PAGE/is);
  assert.match(readme, /overlapping tiles/i);
  assert.match(readme, /media-v7/);
  assert.match(readme, /visual-v6/);
  assert.match(readme, /evidence-v2/);
});





test('README documents V0.2.27.3 per-round continuation byte accounting hotfix', () => {
  assert.match(readme, /V0\.2\.27\.3.*per-round.*continuation.*byte/i);
  assert.match(readme, /round_received_bytes/);
  assert.match(readme, /request.*cumulative.*bytes/i);
  assert.match(readme, /0 B/);
  assert.match(readme, /no ENV/i);
});
test('README documents V0.2.27.2 native Read.pages focused PDF refinement', () => {
  assert.match(readme, /V0\.2\.27\.2.*Read\.pages.*focused PDF/i);
  assert.match(readme, /page-scoped cache/i);
  assert.match(readme, /whole-document cache/i);
  assert.match(readme, /recursive.*crop/i);
  assert.match(readme, /no custom Claude Code tool/i);
  assert.match(readme, /media-v7/);
  assert.match(readme, /visual-v6/);
  assert.match(readme, /evidence-v2/);
});

test('README documents V0.2.27.1 live PDF/media progress hotfix', () => {
  assert.match(readme, /V0\.2\.27\.1 live PDF\/media progress hotfix/i);
  assert.match(readme, /sanitized.*bootstrap.*count_tokens/is);
  assert.match(readme, /live.*progress.*Vision/is);
  assert.match(readme, /exact.*message_delta.*usage/is);
  assert.match(readme, /pdf_schematic_tile_render/);
  assert.match(readme, /pdf_schematic_tile_analyze/);
  assert.match(readme, /media-v7/);
  assert.match(readme, /visual-v6/);
  assert.match(readme, /evidence-v2/);
});


test('README documents V0.2.26.2 native-language visible-output contract', () => {
  assert.match(readme, /V0\.2\.26\.2 native-language visible-output contract/);
  assert.match(readme, /在 think 思考區塊之外，所有使用者可見的自然語言內容都必須使用繁體中文（zh-TW）。/);
  assert.match(readme, /除非使用者明確要求，否則不得切換為其他語言。/);
  assert.match(readme, /0\.2\.26\+hotfix\.2/);
});

test('README documents V0.2.26.1 activity-aware timeout policy', () => {
  assert.match(readme, /V0\.2\.26\.1/);
  assert.match(readme, /first-byte/i);
  assert.match(readme, /inactivity/i);
  assert.match(readme, /MANAGED_TASK_TIMEOUT_MS.*disabled/is);
});


test('README documents V0.2.26.4 Final Language Gate and repair fallback order', () => {
  assert.match(readme, /V0\.2\.26\.4 Final Language Gate/);
  assert.match(readme, /MODEL_RESPONSE_LANGUAGE.*Final Presentation Language/is);
  assert.match(readme, /External Processor.*Base.*original/is);
  assert.match(readme, /thinking.*tool_use.*intermediate/is);
  assert.match(readme, /0\.2\.26\+hotfix\.4/);
});


test('README documents V0.2.26.5 native WebSearch bypass and stricter Chinese variant detection', () => {
  assert.match(readme, /V0\.2\.26\.5/);
  assert.match(readme, /native_web_search/);
  assert.match(readme, /bypass Final Language Gate/);
  assert.match(readme, /zh-TW \/ zh-CN/);
});

test('README documents V0.2.28.1 GLM output-contract hardening', () => {
  assert.match(readme, /V0\.2\.28\.1.*GLM.*output.*contract/i);
  assert.match(readme, /post-validat/i);
  assert.match(readme, /language_not_compliant/);
  assert.match(readme, /\/nothink/);
  assert.match(readme, /visual_reasoning_stripped/);
  assert.match(readme, /media-v7/);
  assert.match(readme, /visual-v7/);
  assert.match(readme, /evidence-v3/);
  assert.match(readme, /no new ENV/i);
});


test('README documents V0.2.28.2 Vision empty-output contract hotfix', () => {
  assert.match(readme, /V0\.2\.28\.2.*Vision.*empty-output.*hotfix/i);
  assert.match(readme, /vision_output_observed/);
  assert.match(readme, /vision_empty_output_retry/);
  assert.match(readme, /vision_empty_output/);
  assert.match(readme, /visual-v8/);
  assert.match(readme, /evidence-v4/);
  assert.match(readme, /no new ENV/i);
});

test('README documents V0.2.28.3 Vision evidence quality gate and adaptive thinking recovery', async () => {
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
const proxyServerSource = await fs.readFile(new URL('../src/services/proxy-server.js', import.meta.url), 'utf8');
  assert.match(readme, /V0\.2\.28\.3 Vision Evidence Quality Gate/i);
  assert.match(readme, /vision_output_quality/);
  assert.match(readme, /vision_quality_retry/);
  assert.match(readme, /visual-v9/);
  assert.match(readme, /evidence-v5/);
});


test('README documents V0.2.28.4 schematic tile isolation and transport diagnostics', async () => {
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
const proxyServerSource = await fs.readFile(new URL('../src/services/proxy-server.js', import.meta.url), 'utf8');
  assert.match(readme, /V0\.2\.28\.4.*schematic tile isolation/i);
  assert.match(readme, /one tile.*one Vision request/is);
  assert.match(readme, /pdf_schematic_tile_failed/);
  assert.match(readme, /transport_code/);
  assert.match(readme, /UND_ERR_HEADERS_TIMEOUT/);
  assert.match(readme, /visual-v10/);
  assert.match(readme, /evidence-v6/);
  assert.match(readme, /no new ENV/i);
});


test('V0.2.28.5 continuation compressor reuses the existing auxiliary processor without new ENV', () => {
  assert.match(proxyServerSource, /compressContinuationWindow/);
  assert.match(proxyServerSource, /config\.webFetchProcessor/);
  assert.match(proxyServerSource, /acquireWebFetchProcessor/);
  assert.doesNotMatch(envExample, /^CONTINUATION_/m);
  assert.doesNotMatch(compose, /CONTINUATION_[A-Z0-9_]+:/);
});


test('README documents V0.2.28.5 recovery-only continuation state compression', () => {
  assert.match(readme, /V0\.2\.28\.5 managed continuation state compression/i);
  assert.match(readme, /only after.*continuation recovery/i);
  assert.match(readme, /thinking.*visible.*text/i);
  assert.match(readme, /24,?000/);
  assert.match(readme, /96,?000/);
  assert.match(readme, /24K.*4K.*overlap/i);
  assert.match(readme, /WEB_FETCH_PROCESSOR_/);
  assert.match(readme, /tool_use.*tool_result.*not.*compress/i);
  assert.match(readme, /managed_continuation_state_preserved/);
  assert.match(readme, /media-v7/);
  assert.match(readme, /visual-v10/);
  assert.match(readme, /evidence-v6/);
});

test('V0.2.28.10 deployment documents and exposes external Context Compact model settings', () => {
  for (const name of ['CONTEXT_COMPACT_PROVIDER','CONTEXT_COMPACT_URL','CONTEXT_COMPACT_MODEL','CONTEXT_COMPACT_API_KEY','CONTEXT_COMPACT_THINK']) {
    assert.match(envExample, new RegExp(`^${name}=`, 'm'));
    assert.match(compose, new RegExp(`${name}:\\s*\\$\\{${name}`));
    assert.match(readme, new RegExp(name));
  }
  assert.match(readme, /qwen3\.6:27b-q4_K_M-cc/);
  assert.match(readme, /\/api\/chat/);
  assert.match(readme, /chat_template_kwargs\.enable_thinking/);
});

test('V0.2.28.12 deployment exposes independent Language Processor settings and session banner documentation', () => {
  for (const name of ['LANG_PROCESSOR_ENABLED','LANG_PROCESSOR_PROVIDER','LANG_PROCESSOR_URL','LANG_PROCESSOR_MODEL','LANG_PROCESSOR_API_KEY','LANG_PROCESSOR_THINK']) {
    assert.match(envExample, new RegExp(`^${name}=`, 'm'));
    assert.match(compose, new RegExp(`${name}:\\s*\\$\\{${name}`));
    assert.match(readme, new RegExp(name));
  }
  assert.match(readme, /V0\.2\.28\.12.*Language Processor/i);
  assert.match(readme, /Technical-Prose Language Classification/i);
  assert.match(readme, /CC TOOL PROXY/);
  assert.match(readme, /SESSIONS.*ACTIVE.*WAIT/is);
  assert.match(readme, /session.*once/i);
});

test('README documents V0.29.2 Vision Output Contract', () => {
  assert.match(readme, /V0\.29\.2 Vision Output Contract/i);
  assert.match(readme, /VISUAL_STATUS:\s*CONTENT/i);
  assert.match(readme, /VISUAL_STATUS:\s*BLANK/i);
  assert.match(readme, /VISUAL_STATUS:\s*UNREADABLE/i);
  assert.match(readme, /VISUAL_EVIDENCE:/i);
  assert.match(readme, /BLANK.*GOOD.*cache/is);
  assert.match(readme, /missing.*VISUAL_STATUS.*retry/is);
  assert.match(readme, /too_short.*removed|removed.*too_short/is);
  assert.match(readme, /visual-v12/);
  assert.match(readme, /evidence-v8/);
});


test('README documents V0.29.3 Recursive Vision Zoom and overlapping PDF tiles', () => {
  assert.match(readme, /V0\.29\.3.*Recursive Vision Zoom/i);
  assert.match(readme, /VISUAL_STATUS:\s*NEEDS_ZOOM/i);
  assert.match(readme, /request_image_crop/i);
  assert.match(readme, /12%|12 percent/i);
  assert.match(readme, /15%.*DIAGRAM|DIAGRAM.*15%/is);
  assert.match(readme, /20%.*SCHEMATIC|SCHEMATIC.*20%/is);
  assert.match(readme, /zoom depth.*2|max.*zoom.*2/is);
  assert.match(readme, /visual-v13/);
  assert.match(readme, /evidence-v9/);
});

test('README documents V0.29.4 generic zoom fallback, provenance and local contract repair', () => {
  assert.match(readme, /V0\.29\.4 Generic Zoom Fallback/i);
  assert.match(readme, /15% overlap/i);
  assert.match(readme, /maximum of 6 automatic tiles/i);
  assert.match(readme, /read_pdf_image/i);
  assert.match(readme, /vision_contract_repaired/i);
  assert.match(readme, /visual-v14/);
  assert.match(readme, /evidence-v10/);
});


test('README documents V0.29.5 two-dimensional Visual Detail contract', () => {
  assert.match(readme, /V0\.29\.5.*Visual Detail/i);
  assert.match(readme, /VISUAL_STATUS:\s*CONTENT/i);
  assert.match(readme, /VISUAL_DETAIL:\s*SUFFICIENT/i);
  assert.match(readme, /VISUAL_DETAIL:\s*NEEDS_ZOOM/i);
  assert.match(readme, /missing.*VISUAL_DETAIL.*contract-invalid|VISUAL_DETAIL.*must not.*infer/is);
  assert.match(readme, /legacy.*VISUAL_STATUS:\s*NEEDS_ZOOM/is);
  assert.match(readme, /15% overlap/i);
  assert.match(readme, /visual-v15/);
  assert.match(readme, /evidence-v11/);
});


test('README documents V0.29.6 terminal generic zoom and cache correctness', () => {
  assert.match(readme, /V0\.29\.6.*Terminal|Terminal.*V0\.29\.6/is);
  assert.match(readme, /terminal_status:\s*(resolved|partial|unreadable)/i);
  assert.match(readme, /media_cache_skip/i);
  assert.match(readme, /30 second|30-second/i);
  assert.match(readme, /control_tag_leak/i);
  assert.match(readme, /visual-v16/);
  assert.match(readme, /evidence-v12/);
});


test('README documents V0.29.7 failure-aware Vision recovery', () => {
  assert.match(readme, /V0\.29\.7.*Failure-Aware|Failure-Aware.*V0\.29\.7/is);
  assert.match(readme, /original.*3 retr|1.*original.*3.*retr/is);
  assert.match(readme, /focused_recovery/i);
  assert.match(readme, /structured_extraction/i);
  assert.match(readme, /last_chance_salvage/i);
  assert.match(readme, /VISUAL_COMPLETENESS:\s*COMPLETE\s*\|\s*PARTIAL/i);
  assert.match(readme, /visual-v17/);
  assert.match(readme, /evidence-v13/);
});


test('README documents V0.29.8 visual crop terminal recovery', () => {
  assert.match(readme, /V0\.29\.8.*Visual Crop Terminal Recovery|Visual Crop Terminal Recovery.*V0\.29\.8/is);
  assert.match(readme, /visual_crop_depth_limit/i);
  assert.match(readme, /maximum crop depth at 2|max.*crop depth.*2/is);
  assert.match(readme, /one precise crop round/i);
  assert.match(readme, /vision_crop_budget_exhausted/i);
  assert.match(readme, /visual-v18/);
  assert.match(readme, /evidence-v14/);
});

test('README documents V0.29.9 historical media continuation dedup', () => {
  assert.match(readme, /V0\.29\.9 Historical Media Continuation Dedup/i);
  assert.match(readme, /media_continuation_cache_hit/i);
  assert.match(readme, /PARTIAL/i);
  assert.match(readme, /tool_result/i);
  assert.match(readme, /visual-v18/);
  assert.match(readme, /evidence-v14/);
});


test('README documents V0.29.10 authoritative VLLM_BASE_MODEL routing', () => {
  assert.match(readme, /V0\.29\.10.*VLLM_BASE_MODEL|VLLM_BASE_MODEL.*V0\.29\.10/is);
  assert.match(readme, /authoritative/i);
  assert.match(readme, /client.*model.*upstream.*model|upstream.*model.*client.*model/is);
  assert.match(readme, /base_model_selected/i);
  assert.match(readme, /WEB_FETCH_PROCESSOR_MODEL.*VLLM_BASE_MODEL|VLLM_BASE_MODEL.*WEB_FETCH_PROCESSOR_MODEL/is);
});


test('README documents V0.29.11 Base response mode-aware timeout policy', () => {
  assert.match(readme, /V0\.29\.11 Base Response Mode-aware Timeout/);
  assert.match(readme, /VLLM_BASE_RESPONSE_MODE=auto\|streaming\|buffered/);
  assert.match(readme, /MANAGED_MODEL_STALL_TIMEOUT_MS=90000/);
  assert.match(readme, /buffered.*absolute.*MANAGED_MODEL_ROUND_TIMEOUT_MS/is);
  assert.match(readme, /Ollama.*buffered/is);
  assert.match(readme, /base_response_mode_selected/);
});

test('README documents V0.29.12 runtime memory lifecycle hardening', () => {
  assert.match(readme, /V0\.29\.12 Runtime Memory Lifecycle Hardening/i);
  assert.match(readme, /ProgressStream.*dispose|dispose.*ProgressStream/is);
  assert.match(readme, /client disconnect/i);
  assert.match(readme, /64 MiB.*global|global.*64 MiB/is);
  assert.match(readme, /16 MiB.*session|session.*16 MiB/is);
  assert.match(readme, /cache\.continuation|continuation.*bytes/is);
  assert.match(readme, /media-v8/);
  assert.match(readme, /visual-v18/);
  assert.match(readme, /evidence-v14/);
});


test('README documents V0.29.16 diagnostic-first Agent UI tracing from the V0.29.12 baseline', () => {
  assert.match(readme, /V0\.29\.16 Diagnostic-First Claude Agent UI Tracing/);
  assert.match(readme, /V0\.29\.12 visible progress semantics are preserved/);
  assert.match(readme, /claude_agent_request_observed/);
  assert.match(readme, /proxy_progress_first_visible/);
  assert.match(readme, /claude_agent_handoff_observed/);
});

test('README documents V0.29.17 Sub Agent title-anchored progress without disabling visible progress', () => {
  assert.match(readme, /V0\.29\.17 Sub Agent Title-Anchored Progress/);
  assert.match(readme, /original Agent description/);
  assert.match(readme, /WebSearch\/tool-result continuations/);
  assert.match(readme, /Main Agent progress formatting is unchanged/);
});

test('V0.29.20 keeps Claude Code native Sub Agent task rows untouched and documents Main-owned global statusLine', async () => {
  assert.match(readme, /V0\.29\.20 Main-Owned Status Telemetry/);
  assert.match(readme, /Main.*Sub Agent.*same progress|Main.*Sub Agent.*相同.*progress/is);
  assert.match(readme, /statusLine.*Main|主線.*statusLine/is);
  assert.match(readme, /不.*subagentStatusLine|does not.*subagentStatusLine/is);
  await assert.rejects(fs.access(new URL('../scripts/cc-tool-proxy-subagent-statusline.js', import.meta.url)));
  assert.doesNotMatch(proxyServerSource, /SubagentDisplayRegistry|subagent_progress_title_bound|subagent_display_handoff_registered|progressTitle:/);
});


test('V0.29.22 restores one visible text progress carrier while leaving native Sub Agent rows untouched', async () => {
  assert.match(readme, /V0\.29\.22 Unified Visible Progress/);
  assert.match(readme, /Main.*Sub Agent.*text_delta|text_delta.*Main.*Sub Agent/is);
  assert.match(readme, /V0\.29\.21 Sub Agent `thinking_delta` experiment is retired|V0\.29\.21[^#]*thinking_delta[^#]*retired/is);
  assert.match(readme, /WebSearch.*continuation|tool-result continuation/is);
  assert.match(readme, /statusLine.*Main|主線.*statusLine/is);
  await assert.rejects(fs.access(new URL('../scripts/cc-tool-proxy-subagent-statusline.js', import.meta.url)));
  assert.doesNotMatch(proxyServerSource, /SubagentDisplayRegistry|subagent_progress_title_bound|subagent_display_handoff_registered|progressTitle:/);
  assert.doesNotMatch(proxyServerSource, /progressCarrier\s*=|carrier:\s*progressCarrier|carrier:\s*['\"]thinking['\"]/);
});


test('V0.29.23 keeps release change logs under change_log instead of project root', async () => {
  const rootUrl = new URL('../', import.meta.url);
  const rootEntries = await fs.readdir(rootUrl);
  assert.equal(rootEntries.includes('CHANGELOG.md'), false);
  assert.equal(rootEntries.some((name) => /^V\d.*(?:更新說明|實作與驗證報告|診斷說明)\.md$/.test(name)), false);

  const changeLogEntries = await fs.readdir(new URL('../change_log/', import.meta.url));
  assert.ok(changeLogEntries.includes('CHANGELOG.md'));
  assert.ok(changeLogEntries.includes('V0.29.22-更新說明.md'));
  assert.ok(changeLogEntries.includes('V0.29.22-實作與驗證報告.md'));
  assert.ok(changeLogEntries.includes('V0.29.23-更新說明.md'));
  assert.ok(changeLogEntries.includes('V0.29.23-實作與驗證報告.md'));
});


test('V0.29.23 makes Sub Agent progress liveness-only while Main keeps visible progress', async () => {
  assert.match(readme, /V0\.29\.23 Sub Agent Liveness-Only Progress/);
  assert.match(readme, /Sub Agent.*liveness-only|liveness-only.*Sub Agent/is);
  assert.match(proxyServerSource, /visibleProgressEnabled:\s*claudeAgentRequestContext\?\.context !== 'subagent'/);
  assert.match(proxyServerSource, /claude_agent_progress_policy/);
  assert.match(proxyServerSource, /transport_liveness:\s*'sse_ping'/);
  await assert.rejects(fs.access(new URL('../scripts/cc-tool-proxy-subagent-statusline.js', import.meta.url)));
  assert.doesNotMatch(proxyServerSource, /SubagentDisplayRegistry|subagent_progress_title_bound|subagent_display_handoff_registered|progressTitle:/);
});


test('V0.29.24 adds liveness-only SSE for external Context Compact without changing Main or Sub Agent progress policy', async () => {
  assert.match(readme, /V0\.29\.24 Context Compact Liveness-Only SSE/);
  assert.match(readme, /ping-only keepalive|ping-only SSE/is);
  assert.match(readme, /does not send `message_start` early|does \*\*not\*\* send `message_start` early/is);
  assert.match(proxyServerSource, /openContextCompactLiveness/);
  assert.match(proxyServerSource, /context_compact_client_stream_open/);
  assert.match(proxyServerSource, /context_compact_client_stream_stop/);
  assert.match(proxyServerSource, /formatSseEvent\('ping', \{ type: 'ping' \}\)/);
  assert.match(proxyServerSource, /visibleProgressEnabled:\s*claudeAgentRequestContext\?\.context !== 'subagent'/);
  const changeLogEntries = await fs.readdir(new URL('../change_log/', import.meta.url));
  assert.ok(changeLogEntries.includes('V0.29.24-更新說明.md'));
  assert.ok(changeLogEntries.includes('V0.29.24-實作與驗證報告.md'));
});


test('V0.29.25 adds phase-aware Managed Response Recovery without new ENV settings', async () => {
  assert.match(readme, /V0\.29\.25 Managed Response Recovery/);
  assert.match(readme, /max\(300000 ms, MANAGED_MODEL_STALL_TIMEOUT_MS × 3\)/);
  assert.match(managedLoopSource, /DEFAULT_MAX_STALL_RECOVERY_ROUNDS\s*=\s*2/);
  assert.match(managedLoopSource, /PROXY_MANAGED_RESPONSE_RECOVERY/);
  assert.match(managedLoopSource, /managed_model_stall_recovery_started/);
  assert.match(managedLoopSource, /managed_model_stall_recovery_completed/);
  assert.match(managedLoopSource, /toolStallTimeoutMs/);
  assert.match(sseCollectorSource, /onCheckpoint/);
  assert.match(sseCollectorSource, /completed_blocks/);
  assert.doesNotMatch(envExample, /^MANAGED_MODEL_TOOL_STALL_TIMEOUT_MS=/m);
  assert.doesNotMatch(envExample, /^MAX_STALL_RECOVERY_ROUNDS=/m);
  const changeLogEntries = await fs.readdir(new URL('../change_log/', import.meta.url));
  assert.ok(changeLogEntries.includes('V0.29.25-更新說明.md'));
  assert.ok(changeLogEntries.includes('V0.29.25-實作與驗證報告.md'));
});


test('V0.29.26 isolates deterministic zoom tiles from model crop quota and degrades budget exhaustion safely', async () => {
  assert.match(readme, /V0\.29\.26 Deterministic Zoom Budget Isolation/);
  assert.match(assetRegistrySource, /authorizeRegion\(sourceId, bbox/);
  assert.match(genericZoomSource, /registry\.authorizeRegion\(rootAsset\.sourceId, tile\.bbox\)/);
  assert.match(genericZoomSource, /registry\.registerRegion\(rootAsset\.sourceId/);
  assert.doesNotMatch(genericZoomSource, /authorizeCrop\(rootAsset\.sourceId, tile\.bbox, 1\)/);
  assert.match(genericZoomSource, /vision_zoom_budget_exhausted/);
  assert.match(visionClientSource, /visual_crop_count_limit.*visual_crop_depth_limit.*visual_crop_round_limit/s);
  assert.doesNotMatch(envExample, /^VISUAL_GENERIC_ZOOM_CROP_LIMIT=/m);
  assert.doesNotMatch(envExample, /^VISUAL_CROP_BUDGET=/m);
  const changeLogEntries = await fs.readdir(new URL('../change_log/', import.meta.url));
  assert.ok(changeLogEntries.includes('V0.29.26-更新說明.md'));
  assert.ok(changeLogEntries.includes('V0.29.26-實作與驗證報告.md'));
});


test('V0.29.27 adds diagnostic-only Anthropic server capability discovery without new ENV settings', async () => {
  assert.match(readme, /V0\.29\.27 Server Capability Discovery \/ ToolSearch Foundation/);
  assert.match(serverCapabilitiesSource, /tool_search_tool_\(regex\|bm25\)/);
  assert.match(serverCapabilitiesSource, /inspectAnthropicServerCapabilities/);
  assert.match(serverCapabilitiesSource, /inspectAnthropicServerResponse/);
  assert.match(proxyServerSource, /anthropic_server_capability_inventory/);
  assert.match(proxyServerSource, /tool_search_request_observed/);
  assert.match(proxyServerSource, /anthropic_server_tool_unsupported/);
  assert.match(proxyServerSource, /anthropic_server_response_inventory/);
  assert.match(proxyServerSource, /anthropic_server_tool_use_unknown/);
  assert.doesNotMatch(envExample, /^TOOL_SEARCH_/m);
  assert.doesNotMatch(envExample, /^SERVER_CAPABILITY_/m);
  const changeLogEntries = await fs.readdir(new URL('../change_log/', import.meta.url));
  assert.ok(changeLogEntries.includes('V0.29.27-更新說明.md'));
  assert.ok(changeLogEntries.includes('V0.29.27-實作與驗證報告.md'));
});


test('V0.29.28 locally bridges ToolSearch while keeping core WebSearch and WebFetch eager', async () => {
  assert.match(readme, /V0\.29\.28 Local ToolSearch \/ Deferred Tool Loading/);
  assert.match(readme, /ENABLE_TOOL_SEARCH=true/);
  assert.match(readme, /WebSearch.*WebFetch/s);
  assert.match(toolSearchSource, /prepareLocalToolSearchRequest/);
  assert.match(toolSearchSource, /executeLocalToolSearch/);
  assert.match(toolSearchSource, /MAX_LOCAL_TOOL_SEARCH_ROUNDS = 3/);
  assert.match(toolSearchSource, /MAX_LOCAL_RESULT_LIMIT = 16/);
  assert.match(proxyServerSource, /local_tool_search_catalog_prepared/);
  assert.match(managedLoopSource, /local_tool_search_executed/);
  assert.doesNotMatch(envExample, /^TOOL_SEARCH_/m);
  const changeLogEntries = await fs.readdir(new URL('../change_log/', import.meta.url));
  assert.ok(changeLogEntries.includes('V0.29.28-更新說明.md'));
  assert.ok(changeLogEntries.includes('V0.29.28-實作與驗證報告.md'));
});


test('V0.29.29 routes ordinary Read/direct images to Base Native Vision while preserving PDF and technical-image Proxy Vision', async () => {
  assert.match(readme, /V0\.29\.29 Native Vision Provenance Routing/);
  assert.match(readme, /VLLM_BASE_VISION_ENABLED=true/);
  assert.match(readme, /VISION_NATIVE_PASSTHROUGH=true/);
  assert.match(readme, /read_image.*direct_image.*Native Vision/s);
  assert.match(readme, /read_pdf_image.*Proxy Vision/s);
  assert.match(envExample, /^VLLM_BASE_VISION_ENABLED=false$/m);
  assert.match(envExample, /^VISION_NATIVE_PASSTHROUGH=false$/m);
  assert.match(compose, /VLLM_BASE_VISION_ENABLED:\s*\$\{VLLM_BASE_VISION_ENABLED:-false\}/);
  assert.match(compose, /VISION_NATIVE_PASSTHROUGH:\s*\$\{VISION_NATIVE_PASSTHROUGH:-false\}/);
  assert.match(mediaAdaptersSource, /\['direct_image', 'read_image'\]\.includes\(provenance\.sourceKind\)/);
  assert.match(proxyServerSource, /native_vision_route_selected/);
  assert.match(proxyServerSource, /native_vision_base_probe_succeeded/);
  assert.match(proxyServerSource, /native_vision_fallback_selected/);
  assert.match(proxyServerSource, /base_image_capability_rejected/);
  const changeLogEntries = await fs.readdir(new URL('../change_log/', import.meta.url));
  assert.ok(changeLogEntries.includes('V0.29.29-更新說明.md'));
  assert.ok(changeLogEntries.includes('V0.29.29-實作與驗證報告.md'));
});

test('V0.29.30 keeps Read/direct Native Vision image blocks raw instead of staging and rebuilding them', async () => {
  assert.match(readme, /V0\.29\.30 Native Vision Raw Passthrough/);
  assert.match(readme, /original.*tool_result.*image.*unchanged/s);
  assert.match(readme, /no.*proxy_file.*rehydration/s);
  assert.match(mediaAdaptersSource, /native_vision_raw_passthrough_selected/);
  assert.match(proxyServerSource, /passthroughPaths/);
  const changeLogEntries = await fs.readdir(new URL('../change_log/', import.meta.url));
  assert.ok(changeLogEntries.includes('V0.29.30-更新說明.md'));
  assert.ok(changeLogEntries.includes('V0.29.30-實作與驗證報告.md'));
});


test('V0.29.31 hardens empty end_turn recovery and keeps Native raw image probes off count_tokens', async () => {
  assert.match(readme, /V0\.29\.31 Empty End-Turn Recovery \/ Native Vision Probe Reduction/);
  assert.match(managedLoopSource, /upstream_empty_end_turn/);
  assert.match(managedLoopSource, /empty_end_turn_recovery_exhausted/);
  assert.match(managedLoopSource, /managed_empty_end_turn_regeneration_started/);
  assert.match(proxyServerSource, /native_vision_image_probe_skipped/);
  assert.match(proxyServerSource, /operator_declared_base_vision_capability/);
  assert.match(proxyServerSource, /base_image_capability_rejected_runtime/);
  assert.match(sseCollectorSource, /event_sequence/);
  assert.match(sseCollectorSource, /event_counts/);
  assert.doesNotMatch(envExample, /^EMPTY_END_TURN_/m);
  const changeLogEntries = await fs.readdir(new URL('../change_log/', import.meta.url));
  assert.ok(changeLogEntries.includes('V0.29.31-更新說明.md'));
  assert.ok(changeLogEntries.includes('V0.29.31-實作與驗證報告.md'));
});
