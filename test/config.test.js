import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig exposes the five vLLM settings and one proxy mode', () => {
  const config = loadConfig({
    VLLM_BASE_URL: 'http://vllm-base:8000',
    VLLM_BASE_API_KEY: 'base-secret',
    VLLM_VISION_URL: 'http://vllm-vision:8000',
    VLLM_VISION_MODEL: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
    VLLM_VISION_API_KEY: 'vision-secret',
  });
  assert.equal(config.vllmBaseUrl, 'http://vllm-base:8000');
  assert.equal(config.vllmBaseApiKey, 'base-secret');
  assert.equal(config.vllmVisionUrl, 'http://vllm-vision:8000');
  assert.equal(config.vllmVisionModel, 'Qwen/Qwen3-VL-30B-A3B-Instruct');
  assert.equal(config.vllmVisionApiKey, 'vision-secret');
  assert.equal(config.vllmVisionProvider, 'vllm');
  assert.equal(config.vllmVisionThink, false);
  assert.equal(config.vllmVisionApiProtocol, 'openai-chat');
  assert.equal(config.cache.pipelineVersion, 'media-v6');
  assert.equal(config.cache.visualPromptVersion, 'visual-v5');
  assert.equal(config.cache.evidenceContractVersion, 'evidence-v1');
  assert.equal(config.port, 8080);
  assert.equal(config.usagePreflightEnabled, true);
});

test('vision URL and model must be configured together', () => {
  assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', VLLM_VISION_URL: 'http://vision:8000' }), /VLLM_VISION_MODEL/);
  assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', VLLM_VISION_MODEL: 'vision-model' }), /VLLM_VISION_URL/);
});

test('base URL remains required', () => {
  assert.throws(() => loadConfig({}), /VLLM_BASE_URL/);
});

test('default concurrency profile provides bounded managed and vision limits', () => {
  const config = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000' });
  assert.deepEqual(config.concurrency, {
    profile: 'default',
    managedLimit: 2,
    queueLimit: 12,
    queueTimeoutMs: 120000,
    visionLimit: 1,
  });
});

test('small and large concurrency profiles are supported', () => {
  const small = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', CONCURRENCY_PROFILE: 'small' });
  const large = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', CONCURRENCY_PROFILE: 'large' });
  assert.deepEqual(small.concurrency, {
    profile: 'small', managedLimit: 1, queueLimit: 4, queueTimeoutMs: 120000, visionLimit: 1,
  });
  assert.deepEqual(large.concurrency, {
    profile: 'large', managedLimit: 4, queueLimit: 32, queueTimeoutMs: 180000, visionLimit: 2,
  });
});

test('explicit concurrency values override the selected profile', () => {
  const config = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    CONCURRENCY_PROFILE: 'small',
    MANAGED_MAX_CONCURRENCY: '3',
    MANAGED_MAX_QUEUE: '9',
    MANAGED_QUEUE_TIMEOUT_MS: '45000',
    VISION_MAX_CONCURRENCY: '2',
  });
  assert.deepEqual(config.concurrency, {
    profile: 'small', managedLimit: 3, queueLimit: 9, queueTimeoutMs: 45000, visionLimit: 2,
  });
});

test('invalid concurrency profile and bounds are rejected', () => {
  assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', CONCURRENCY_PROFILE: 'huge' }), /CONCURRENCY_PROFILE/);
  assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', MANAGED_MAX_CONCURRENCY: '0' }), /MANAGED_MAX_CONCURRENCY/);
  assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', MANAGED_MAX_QUEUE: '-1' }), /MANAGED_MAX_QUEUE/);
  assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', VISION_MAX_CONCURRENCY: '0' }), /VISION_MAX_CONCURRENCY/);
});

test('media cache uses resource-profile defaults when no explicit capacity is set', () => {
  const small = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', RESOURCE_PROFILE: 'small' });
  const normal = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000' });
  const large = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', RESOURCE_PROFILE: 'large' });
  assert.equal(small.cache.maxBytes, 512 * 1024 * 1024);
  assert.equal(small.cache.retentionMs, 3 * 24 * 60 * 60 * 1000);
  assert.equal(normal.cache.maxBytes, 2048 * 1024 * 1024);
  assert.equal(normal.cache.retentionMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(large.cache.maxBytes, 10240 * 1024 * 1024);
  assert.equal(large.cache.retentionMs, 30 * 24 * 60 * 60 * 1000);
});

test('MEDIA_CACHE_MAX_MB zero selects filesystem-limited mode and positive values use MiB', () => {
  const unlimited = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', MEDIA_CACHE_MAX_MB: '0' });
  const bounded = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', MEDIA_CACHE_MAX_MB: '4096' });
  assert.equal(unlimited.cache.maxBytes, 0);
  assert.equal(unlimited.cache.limitMode, 'filesystem');
  assert.equal(bounded.cache.maxBytes, 4096 * 1024 * 1024);
  assert.equal(bounded.cache.limitMode, 'bounded');
});

test('invalid media cache capacity is rejected', () => {
  assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', MEDIA_CACHE_MAX_MB: '-1' }), /MEDIA_CACHE_MAX_MB/);
  assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', MEDIA_CACHE_MAX_MB: 'abc' }), /MEDIA_CACHE_MAX_MB/);
});


test('visual provider and thinking mode are explicit and strictly validated', () => {
  const ollama = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    VLLM_VISION_URL: 'http://ollama:11434',
    VLLM_VISION_MODEL: 'qwen3.6:27b',
    VLLM_VISION_PROVIDER: 'ollama',
    VLLM_VISION_THINK: 'true',
  });
  assert.equal(ollama.vllmVisionProvider, 'ollama');
  assert.equal(ollama.vllmVisionThink, true);
  assert.equal(ollama.vllmVisionApiProtocol, 'ollama-native');

  assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', VLLM_VISION_PROVIDER: 'unknown' }), /VLLM_VISION_PROVIDER/);
  for (const value of ['1', '0', 'yes', 'no', 'auto']) {
    assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', VLLM_VISION_THINK: value }), /VLLM_VISION_THINK/);
  }
});

test('semantic heartbeat and SSE drain timeout have bounded defaults and overrides', () => {
  const defaults = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000' });
  assert.equal(defaults.progressHeartbeatMs, 30000);
  assert.equal(defaults.sseDrainTimeoutMs, 10000);
  const custom = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    PROGRESS_HEARTBEAT_MS: '45000',
    SSE_DRAIN_TIMEOUT_MS: '20000',
  });
  assert.equal(custom.progressHeartbeatMs, 45000);
  assert.equal(custom.sseDrainTimeoutMs, 20000);
  assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', SSE_DRAIN_TIMEOUT_MS: '999' }), /SSE_DRAIN_TIMEOUT_MS/);
});

test('WebFetch API key is optional and preserved without logging transformation', () => {
  const defaults = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', WEB_FETCH_URL: 'http://fetch:3000/api' });
  assert.equal(defaults.webFetchApiKey, '');
  assert.equal(defaults.webFetchUrl, 'http://fetch:3000/api');

  const configured = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    WEB_FETCH_URL: 'http://fetch:3000/api',
    WEB_FETCH_API_KEY: 'fetch-secret',
  });
  assert.equal(configured.webFetchApiKey, 'fetch-secret');
});

test('Base upstream timeout defaults and overrides are explicit', () => {
  const defaults = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000' });
  assert.deepEqual(defaults.vllmBaseTimeouts, {
    connectTimeoutMs: 10000,
    headersTimeoutMs: 900000,
    bodyTimeoutMs: 900000,
  });

  const custom = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    VLLM_BASE_CONNECT_TIMEOUT_MS: '15000',
    VLLM_BASE_HEADERS_TIMEOUT_MS: '1200000',
    VLLM_BASE_BODY_TIMEOUT_MS: '600000',
  });
  assert.deepEqual(custom.vllmBaseTimeouts, {
    connectTimeoutMs: 15000,
    headersTimeoutMs: 1200000,
    bodyTimeoutMs: 600000,
  });
  assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', VLLM_BASE_CONNECT_TIMEOUT_MS: '999' }), /VLLM_BASE_CONNECT_TIMEOUT_MS/);
});

test('WebFetch Processor defaults inherit Base vLLM with slow-model-friendly controls', () => {
  const config = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000/v1/messages',
    VLLM_BASE_API_KEY: 'base-secret',
  });
  assert.deepEqual(config.webFetchProcessor, {
    enabled: true,
    provider: 'vllm',
    url: 'http://vllm:8000/v1/chat/completions',
    model: '',
    apiKey: 'base-secret',
    think: false,
    concurrency: 3,
    timeoutMs: 300000,
  });
});

test('WebFetch Processor supports explicit URL model key concurrency timeout and strict THINK', () => {
  const config = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    VLLM_BASE_API_KEY: 'base-secret',
    WEB_FETCH_PROCESSOR_ENABLED: 'false',
    WEB_FETCH_PROCESSOR_URL: 'http://processor:9000/custom/chat',
    WEB_FETCH_PROCESSOR_MODEL: 'processor-model',
    WEB_FETCH_PROCESSOR_API_KEY: 'processor-secret',
    WEB_FETCH_PROCESSOR_THINK: 'true',
    WEB_FETCH_PROCESSOR_CONCURRENCY: '2',
    WEB_FETCH_PROCESSOR_TIMEOUT_MS: '420000',
  });
  assert.deepEqual(config.webFetchProcessor, {
    enabled: false,
    provider: 'vllm',
    url: 'http://processor:9000/custom/chat',
    model: 'processor-model',
    apiKey: 'processor-secret',
    think: true,
    concurrency: 2,
    timeoutMs: 420000,
  });
  assert.throws(() => loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    WEB_FETCH_PROCESSOR_THINK: 'yes',
  }), /WEB_FETCH_PROCESSOR_THINK/);
  assert.throws(() => loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    WEB_FETCH_PROCESSOR_CONCURRENCY: '4',
  }), /WEB_FETCH_PROCESSOR_CONCURRENCY/);
  assert.throws(() => loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    WEB_FETCH_PROCESSOR_TIMEOUT_MS: '999',
  }), /WEB_FETCH_PROCESSOR_TIMEOUT_MS/);
});

test('explicit WebFetch Processor URL does not inherit the Base API key across hosts', () => {
  const config = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    VLLM_BASE_API_KEY: 'base-secret',
    WEB_FETCH_PROCESSOR_URL: 'http://processor:9000/v1/chat/completions',
  });
  assert.equal(config.webFetchProcessor.apiKey, '');
});

test('protocol anomaly snippets are opt-in and strictly validated', () => {
  const defaults = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000' });
  assert.equal(defaults.logProtocolSnippets, false);
  const enabled = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    LOG_PROTOCOL_SNIPPETS: 'true',
  });
  assert.equal(enabled.logProtocolSnippets, true);
  assert.throws(() => loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    LOG_PROTOCOL_SNIPPETS: 'yes',
  }), /LOG_PROTOCOL_SNIPPETS/);
});

test('protocol diagnostics use an internal timestamped temporary directory without another ENV setting', () => {
  const config = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000' });
  assert.match(config.protocolDiagnosticsDir, /vllm-cc-tools-proxy[\\/]protocol-snippets$/);
});

test('V0.2.26.1 managed task deadline is disabled by default with bounded opt-in override', () => {
  const defaults = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000' });
  assert.equal(defaults.managedTaskTimeoutMs, 0);
  assert.equal(defaults.managedModelRoundTimeoutMs, 360000);
  const custom = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    MANAGED_TASK_TIMEOUT_MS: '1200000',
    MANAGED_MODEL_ROUND_TIMEOUT_MS: '480000',
  });
  assert.equal(custom.managedTaskTimeoutMs, 1200000);
  assert.equal(loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', MANAGED_TASK_TIMEOUT_MS: '0' }).managedTaskTimeoutMs, 0);
  assert.equal(loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', MANAGED_TASK_TIMEOUT_MS: '' }).managedTaskTimeoutMs, 0);
  assert.equal(custom.managedModelRoundTimeoutMs, 480000);
  assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', MANAGED_TASK_TIMEOUT_MS: '1000' }), /MANAGED_TASK_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', MANAGED_MODEL_ROUND_TIMEOUT_MS: '1000' }), /MANAGED_MODEL_ROUND_TIMEOUT_MS/);
});

test('V0.2.19.3 WebFetch Processor provider defaults to vllm and auto-completes base URLs', () => {
  const defaults = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    WEB_FETCH_PROCESSOR_URL: 'http://processor:9000',
  });
  assert.equal(defaults.webFetchProcessor.provider, 'vllm');
  assert.equal(defaults.webFetchProcessor.url, 'http://processor:9000/v1/chat/completions');

  const ollama = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    WEB_FETCH_PROCESSOR_PROVIDER: 'ollama',
    WEB_FETCH_PROCESSOR_URL: 'http://192.168.10.169:11434/',
  });
  assert.equal(ollama.webFetchProcessor.provider, 'ollama');
  assert.equal(ollama.webFetchProcessor.url, 'http://192.168.10.169:11434/v1/chat/completions');

  const complete = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    WEB_FETCH_PROCESSOR_PROVIDER: 'ollama',
    WEB_FETCH_PROCESSOR_URL: 'http://192.168.10.169:11434/v1/chat/completions',
  });
  assert.equal(complete.webFetchProcessor.url, 'http://192.168.10.169:11434/v1/chat/completions');

  assert.throws(() => loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    WEB_FETCH_PROCESSOR_PROVIDER: 'other',
  }), /WEB_FETCH_PROCESSOR_PROVIDER/);
});

test('diagnostic web tool tracing is explicit, persistent, and separately bounded for Search and Fetch', () => {
  const defaults = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000' });
  assert.deepEqual(defaults.webToolDiagnostic, {
    enabled: false,
    trace: false,
    searchPassthroughCount: 1,
    fetchPassthroughCount: 1,
    traceDir: '/var/lib/vllm-cc-tools-proxy/diagnostics/web-tool-trace',
  });

  const configured = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8000',
    DIAGNOSTIC_WEB_TOOL_PASSTHROUGH: 'true',
    DIAGNOSTIC_WEB_TOOL_TRACE: 'true',
    DIAGNOSTIC_WEB_SEARCH_PASSTHROUGH_COUNT: '2',
    DIAGNOSTIC_WEB_FETCH_PASSTHROUGH_COUNT: '3',
    DIAGNOSTIC_WEB_TOOL_TRACE_DIR: '/data/trace',
  });
  assert.deepEqual(configured.webToolDiagnostic, {
    enabled: true,
    trace: true,
    searchPassthroughCount: 2,
    fetchPassthroughCount: 3,
    traceDir: '/data/trace',
  });
});

test('V0.2.23 response language defaults to en-US and canonicalizes supported locales', () => {
  assert.equal(loadConfig({ VLLM_BASE_URL: 'http://vllm:8000' }).responseLanguage, 'en-US');
  assert.equal(loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', MODEL_RESPONSE_LANGUAGE: '' }).responseLanguage, 'en-US');
  assert.equal(loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', MODEL_RESPONSE_LANGUAGE: 'unknown' }).responseLanguage, 'en-US');
  assert.equal(loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', MODEL_RESPONSE_LANGUAGE: 'zh-tw' }).responseLanguage, 'zh-TW');
  for (const locale of ['zh-TW', 'zh-CN', 'en-US', 'ja-JP', 'ko-KP']) {
    assert.equal(loadConfig({ VLLM_BASE_URL: 'http://vllm:8000', MODEL_RESPONSE_LANGUAGE: locale }).responseLanguage, locale);
  }
});

test('V0.2.26 bumps media and visual cache generations for recursive high-resolution evidence', () => {
  const config = loadConfig({ VLLM_BASE_URL: 'http://vllm:8000' });
  assert.equal(config.cache.pipelineVersion, 'media-v6');
  assert.equal(config.cache.visualPromptVersion, 'visual-v5');
});
