import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildPerceptionCacheKey, canonicalPerceptionRequest } from '../src/cache/perception-cache.js';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function legacyV1Key({ request, session, config }) {
  const payload = {
    kind: 'directed-perception',
    version: 1,
    sources: request.source_ids.map((sourceId) => ({ source_id: sourceId, image_sha256: session.get(sourceId)?.imageSha256 || '' })),
    request: canonicalPerceptionRequest(request),
    vision_model: config.vllmVisionModel || '',
    vision_provider: config.vllmVisionProvider || 'vllm',
    vision_api_protocol: config.vllmVisionApiProtocol || (config.vllmVisionProvider === 'ollama' ? 'ollama-native' : 'openai-chat'),
    vision_think: Boolean(config.vllmVisionThink),
    schema_version: 'visual-perception-v1',
    prompt_version: 'directed-visual-v1',
    normalization_version: 'image-normalize-v1',
    resource_profile: config.resourceProfile || 'default',
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');
}

test('V0.30.1 perception cache invalidates V0.30.0 directed-visual-v1 entries', () => {
  const request = {
    source_ids: ['img_01'],
    objective: 'Read the visible reset label.',
    questions: [{ id: 'q1', question: 'What reset net is visible?' }],
    requested_evidence: ['net labels'],
    detail_level: 'high',
  };
  const session = { get: (id) => id === 'img_01' ? { imageSha256: 'abc123' } : null };
  const config = {
    vllmVisionModel: 'vision-test',
    vllmVisionProvider: 'ollama',
    vllmVisionApiProtocol: 'ollama-native',
    vllmVisionThink: false,
    resourceProfile: 'default',
  };

  assert.notEqual(buildPerceptionCacheKey({ request, session, config }), legacyV1Key({ request, session, config }));
});
