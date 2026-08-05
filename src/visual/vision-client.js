import { HttpError } from '../lib/http.js';
import { fetchJson } from '../lib/media.js';

const CROP_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'request_image_crop',
    description: 'Request a higher-resolution crop only when a specific region is required to read labels or understand visual relationships.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        source_id: { type: 'string' },
        bbox: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 1000 }, minItems: 4, maxItems: 4 },
        purpose: { type: 'string', maxLength: 200 },
      },
      required: ['source_id', 'bbox', 'purpose'],
    },
  },
});

function dataUrl(asset) { return `data:${asset.mediaType};base64,${asset.buffer.toString('base64')}`; }
function contentForAssets(assets, prompt) {
  const content = [{ type: 'text', text: prompt }];
  for (const asset of assets) {
    content.push({ type: 'text', text: `source_id=${asset.sourceId}; label=${asset.label || asset.sourceId}; dimensions=${asset.width}x${asset.height}` });
    content.push({ type: 'image_url', image_url: { url: dataUrl(asset) } });
  }
  return content;
}
function parseArguments(call) {
  try { return JSON.parse(call?.function?.arguments || '{}'); }
  catch { throw new HttpError(422, 'Visual model returned invalid crop arguments.', { code: 'invalid_visual_crop' }); }
}

export async function analyzeVisualAssets(assets, {
  baseUrl, model, apiKey = '', registry, cropImage, signal, onProgress = () => {}, maxCropRounds = 2,
  prompt = 'Analyze observable content only. Preserve source identifiers. Extract visible text, tables, diagrams, arrows, relationships and uncertainty. Do not answer the user final task. Request a crop only when necessary.',
} = {}) {
  if (!baseUrl || !model) throw new HttpError(422, 'Visual vLLM endpoint is required for this media.', { code: 'vision_endpoint_required' });
  const endpointUrl = new URL(baseUrl);
  const cleanPath = endpointUrl.pathname.replace(/\/$/, '');
  if (cleanPath.endsWith('/v1/chat/completions')) endpointUrl.pathname = cleanPath;
  else if (cleanPath.endsWith('/v1')) endpointUrl.pathname = `${cleanPath}/chat/completions`;
  else endpointUrl.pathname = `${cleanPath}/v1/chat/completions`.replace(/\/{2,}/g, '/');
  const endpoint = endpointUrl.toString();
  const messages = [{ role: 'system', content: 'You are a bounded document and image analysis worker. Do not invent unreadable content. Use request_image_crop only for a precise region, then finish with structured Markdown.' }, { role: 'user', content: contentForAssets(assets, prompt) }];
  const warnings = [];
  let cropCount = 0;

  for (let round = 0; round <= maxCropRounds; round += 1) {
    const payload = await fetchJson(endpoint, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, stream: false, parallel_tool_calls: false, tools: [CROP_TOOL], tool_choice: 'auto', messages }),
    }, { errorCode: 'vision_service_error' });
    const message = payload?.choices?.[0]?.message;
    if (!message) throw new HttpError(502, 'Visual vLLM returned no message.', { code: 'vision_invalid_response', retryable: true });
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter((c) => c?.function?.name === 'request_image_crop') : [];
    if (calls.length === 0) return { markdown: String(message.content || ''), warnings, cropCount };
    if (calls.length > 4) throw new HttpError(422, 'Visual model requested too many crops in one round.', { code: 'visual_crop_limit' });
    if (round >= maxCropRounds) {
      warnings.push('visual_crop_limit_reached');
      return { markdown: String(message.content || '') || 'Visual analysis incomplete: crop limit reached.', warnings, cropCount };
    }
    messages.push({ role: 'assistant', content: message.content || '', tool_calls: message.tool_calls });
    const cropAssets = [];
    for (const call of calls) {
      const args = parseArguments(call);
      const authorization = registry.authorizeCrop(args.source_id, args.bbox, round + 1);
      authorization.purpose = String(args.purpose || '').slice(0, 200);
      const original = registry.get(args.source_id);
      const crop = await cropImage(original, authorization, { signal });
      cropCount += 1;
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, source_id: args.source_id, purpose: authorization.purpose, crop_index: cropCount }) });
      cropAssets.push({ ...crop, sourceId: `${args.source_id}-crop-${cropCount}`, label: `crop of ${args.source_id}: ${authorization.purpose}` });
    }
    await onProgress(`視覺模型要求檢視 ${cropAssets.length} 個局部區域…`, { phase: 'vision_crop', round: round + 1, count: cropAssets.length });
    messages.push({ role: 'user', content: contentForAssets(cropAssets, 'Here are the requested high-resolution crops. Continue the analysis and return final Markdown, or request another precise crop only if still essential.') });
  }
  return { markdown: '', warnings: ['visual_crop_limit_reached'], cropCount };
}
