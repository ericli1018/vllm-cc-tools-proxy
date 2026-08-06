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
  assert.equal(config.cache.pipelineVersion, 'media-v5');
  assert.equal(config.cache.visualPromptVersion, 'visual-v4');
  assert.equal(config.cache.evidenceContractVersion, 'evidence-v1');
  assert.equal(config.port, 8080);
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
