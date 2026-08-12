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

import { scopeMediaCacheKey } from '../src/cache/cache-key.js';

test('V0.2.27.2 page-scoped cache key is isolated and canonical', () => {
  const baseKey = 'a'.repeat(64);
  const page42 = scopeMediaCacheKey(baseKey, { pages: [42], canonical: '42' });
  const equivalent = scopeMediaCacheKey(baseKey, { pages: [42], canonical: '42' });
  const page43 = scopeMediaCacheKey(baseKey, { pages: [43], canonical: '43' });
  assert.match(page42, /^[a-f0-9]{64}$/);
  assert.equal(page42, equivalent);
  assert.notEqual(page42, baseKey);
  assert.notEqual(page42, page43);
  assert.equal(scopeMediaCacheKey(baseKey, null), baseKey);
});

import { scopePdfDocumentCacheKey } from '../src/cache/cache-key.js';

test('V0.29.0 unscoped PDF cache uses a progressive-document namespace distinct from legacy whole-document cache', () => {
  const baseKey = 'b'.repeat(64);
  const progressive = scopePdfDocumentCacheKey(baseKey, null);
  const page42 = scopePdfDocumentCacheKey(baseKey, { pages: [42], canonical: '42' });
  assert.match(progressive, /^[a-f0-9]{64}$/);
  assert.notEqual(progressive, baseKey);
  assert.equal(page42, scopeMediaCacheKey(baseKey, { pages: [42], canonical: '42' }));
  assert.notEqual(progressive, page42);
});
