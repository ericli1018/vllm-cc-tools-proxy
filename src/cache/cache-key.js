import crypto from 'node:crypto';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function buildMediaCacheKey({
  buffer,
  mediaType,
  pipelineVersion,
  visualPromptVersion,
  visionModel = '',
  visionProvider = 'vllm',
  visionApiProtocol = 'openai-chat',
  visionThink = false,
  resourceProfile = 'default',
}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
  const mediaSha256 = sha256(buffer);
  const contract = JSON.stringify({
    mediaSha256,
    mediaType,
    pipelineVersion,
    visualPromptVersion,
    visionModel,
    visionProvider,
    visionApiProtocol,
    visionThink: Boolean(visionThink),
    resourceProfile,
  });
  return { key: sha256(contract), mediaSha256 };
}
