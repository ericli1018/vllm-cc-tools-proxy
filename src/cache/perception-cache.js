import crypto from 'node:crypto';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function canonicalPerceptionRequest(request) {
  return {
    source_ids: [...request.source_ids],
    objective: String(request.objective || '').trim().replace(/\r\n/g, '\n'),
    questions: request.questions.map((q) => ({ id: String(q.id).trim(), question: String(q.question).trim().replace(/\r\n/g, '\n') })),
    requested_evidence: [...new Set(request.requested_evidence || [])].map((v) => String(v).trim()).filter(Boolean).sort(),
    detail_level: request.detail_level || 'normal',
  };
}

export function buildPerceptionCacheKey({ request, session, config }) {
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
