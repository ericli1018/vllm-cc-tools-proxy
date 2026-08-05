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
