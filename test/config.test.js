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
