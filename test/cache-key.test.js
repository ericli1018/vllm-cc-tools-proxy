import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaCacheKey } from '../src/cache/cache-key.js';

test('media cache key changes with bytes, model and pipeline contract', () => {
  const base = {
    buffer: Buffer.from('same-media'), mediaType: 'application/pdf', pipelineVersion: 'media-v3',
    visualPromptVersion: 'visual-v2', visionModel: 'vision-a', resourceProfile: 'default',
    visionProvider: 'vllm', visionApiProtocol: 'openai-chat', visionThink: false,
  };
  const first = buildMediaCacheKey(base);
  assert.match(first.key, /^[a-f0-9]{64}$/);
  assert.match(first.mediaSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.key, buildMediaCacheKey(base).key);
  assert.notEqual(first.key, buildMediaCacheKey({ ...base, visionModel: 'vision-b' }).key);
  assert.notEqual(first.key, buildMediaCacheKey({ ...base, buffer: Buffer.from('changed') }).key);
  assert.notEqual(first.key, buildMediaCacheKey({ ...base, pipelineVersion: 'media-v4' }).key);
  assert.notEqual(first.key, buildMediaCacheKey({ ...base, visionProvider: 'ollama', visionApiProtocol: 'ollama-native' }).key);
  assert.notEqual(first.key, buildMediaCacheKey({ ...base, visionThink: true }).key);
});

test('media cache key changes when the evidence contract changes', () => {
  const base = {
    buffer: Buffer.from('same-media'), mediaType: 'application/pdf', pipelineVersion: 'media-v5',
    visualPromptVersion: 'visual-v4', evidenceContractVersion: 'evidence-v1',
    visionModel: 'vision-a', resourceProfile: 'default',
    visionProvider: 'ollama', visionApiProtocol: 'ollama-native', visionThink: false,
  };
  assert.notEqual(
    buildMediaCacheKey(base).key,
    buildMediaCacheKey({ ...base, evidenceContractVersion: 'evidence-v2' }).key,
  );
});
