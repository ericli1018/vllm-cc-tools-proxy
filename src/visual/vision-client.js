import { HttpError } from '../lib/http.js';
import { fetchJson } from '../lib/media.js';
import { cropToolError, asCropHttpError, recoverableCropToolError } from './crop-errors.js';
import { scanControlTags } from '../proxy/protocol-sanitizer.js';

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

const SYSTEM_PROMPT = 'You are a bounded document and image analysis worker. Return Markdown only. Do not emit XML, HTML, reasoning delimiters, tool-call wrappers, function-result wrappers, chat-template tokens, or meta closing tags. Do not invent unreadable content. Use request_image_crop only for a precise region, then finish with evidence-focused Markdown.';

function dataUrl(asset) { return `data:${asset.mediaType};base64,${asset.buffer.toString('base64')}`; }

function assetDescription(assets, prompt) {
  return [
    prompt,
    ...assets.map((asset) => `source_id=${asset.sourceId}; label=${asset.label || asset.sourceId}; dimensions=${asset.width}x${asset.height}`),
  ].join('\n');
}

function userMessageForAssets(provider, assets, prompt) {
  if (provider === 'ollama') {
    return {
      role: 'user',
      content: assetDescription(assets, prompt),
      images: assets.map((asset) => asset.buffer.toString('base64')),
    };
  }
  const content = [{ type: 'text', text: prompt }];
  for (const asset of assets) {
    content.push({ type: 'text', text: `source_id=${asset.sourceId}; label=${asset.label || asset.sourceId}; dimensions=${asset.width}x${asset.height}` });
    content.push({ type: 'image_url', image_url: { url: dataUrl(asset) } });
  }
  return { role: 'user', content };
}

function endpointFor(baseUrl, provider) {
  const endpointUrl = new URL(baseUrl);
  const cleanPath = endpointUrl.pathname.replace(/\/$/, '');
  if (provider === 'ollama') {
    if (cleanPath.endsWith('/api/chat')) endpointUrl.pathname = cleanPath;
    else if (cleanPath.endsWith('/api')) endpointUrl.pathname = `${cleanPath}/chat`;
    else endpointUrl.pathname = `${cleanPath}/api/chat`.replace(/\/{2,}/g, '/');
  } else if (cleanPath.endsWith('/v1/chat/completions')) endpointUrl.pathname = cleanPath;
  else if (cleanPath.endsWith('/v1')) endpointUrl.pathname = `${cleanPath}/chat/completions`;
  else endpointUrl.pathname = `${cleanPath}/v1/chat/completions`.replace(/\/{2,}/g, '/');
  return endpointUrl.toString();
}

function parseArguments(call) {
  const value = call?.function?.arguments;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { return JSON.parse(value || '{}'); }
  catch { throw asCropHttpError('invalid_visual_crop_arguments', 'Visual model returned invalid crop arguments.'); }
}

function responseMessage(payload, provider) {
  return provider === 'ollama' ? payload?.message : payload?.choices?.[0]?.message;
}

function assistantMessage(message, provider) {
  return {
    role: 'assistant',
    content: String(message?.content || ''),
    ...(provider === 'ollama' && typeof message?.thinking === 'string' && message.thinking ? { thinking: message.thinking } : {}),
    ...(Array.isArray(message?.tool_calls) ? { tool_calls: message.tool_calls } : {}),
  };
}

function toolResultMessage(provider, call, result) {
  const content = JSON.stringify(result);
  if (provider === 'ollama') {
    return { role: 'tool', content, tool_name: call?.function?.name || 'request_image_crop' };
  }
  return { role: 'tool', tool_call_id: call?.id || `crop-${Date.now()}`, content };
}

function requestBody({ provider, model, messages, think, toolsEnabled }) {
  if (provider === 'ollama') {
    return {
      model,
      stream: false,
      think: Boolean(think),
      messages,
      ...(toolsEnabled ? { tools: [CROP_TOOL] } : {}),
    };
  }
  return {
    model,
    stream: false,
    parallel_tool_calls: false,
    reasoning_effort: think ? 'high' : 'none',
    chat_template_kwargs: { enable_thinking: Boolean(think) },
    messages,
    ...(toolsEnabled ? { tools: [CROP_TOOL], tool_choice: 'auto' } : {}),
  };
}

export async function analyzeVisualAssets(assets, {
  baseUrl,
  model,
  apiKey = '',
  provider = 'vllm',
  think = false,
  registry,
  cropImage,
  signal,
  onProgress = () => {},
  onDiagnostic = () => {},
  maxCropRounds = 2,
  prompt = 'Analyze observable content only. Preserve source identifiers. Extract visible text, tables, diagrams, arrows, relationships and uncertainty. Do not answer the user final task. Request a crop only when necessary.',
} = {}) {
  if (!baseUrl || !model) throw new HttpError(422, 'Visual endpoint is required for this media.', { code: 'vision_endpoint_required' });
  if (!['vllm', 'ollama'].includes(provider)) throw new HttpError(500, 'Unsupported visual provider.', { code: 'vision_provider_invalid' });
  const endpoint = endpointFor(baseUrl, provider);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    userMessageForAssets(provider, assets, prompt),
  ];
  let cropCount = 0;
  let cropRound = 0;
  let toolsEnabled = true;

  while (true) {
    const payload = await fetchJson(endpoint, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(requestBody({ provider, model, messages, think, toolsEnabled })),
    }, { errorCode: 'vision_service_error' });
    const message = responseMessage(payload, provider);
    if (!message) throw new HttpError(502, 'Visual service returned no message.', { code: 'vision_invalid_response', retryable: true });
    const controlTags = scanControlTags(message.content || '');
    if (controlTags.length > 0) {
      const tags = [...new Set(controlTags.map((tag) => tag.replace(/[<>/]/g, '').split(/[=\s]/)[0].toLowerCase()))];
      await onDiagnostic('visual_control_tags_detected', { tagCount: controlTags.length, tags });
    }
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (calls.length === 0 || !toolsEnabled) {
      return {
        markdown: String(message.content || '') || 'Visual analysis completed without additional readable detail.',
        warnings: [],
        cropCount,
      };
    }

    messages.push(assistantMessage(message, provider));
    cropRound += 1;
    const batchTooLarge = calls.length > 4;
    const cropAssets = [];
    let rejected = 0;

    for (const call of calls) {
      let result;
      if (call?.function?.name !== 'request_image_crop') {
        result = cropToolError(asCropHttpError('unsupported_visual_tool', 'Unsupported visual tool.'));
      } else if (batchTooLarge) {
        result = cropToolError(asCropHttpError('visual_crop_batch_limit', 'Too many crops requested.'));
      } else {
        let processing = false;
        try {
          const args = parseArguments(call);
          const authorization = registry.authorizeCrop(args.source_id, args.bbox, cropRound);
          authorization.purpose = String(args.purpose || '').slice(0, 200);
          const original = registry.get(args.source_id);
          processing = true;
          const crop = await cropImage(original, authorization, { signal });
          cropCount += 1;
          result = { ok: true, source_id: args.source_id, purpose: authorization.purpose, crop_index: cropCount };
          cropAssets.push({ ...crop, sourceId: `${args.source_id}-crop-${cropCount}`, label: `crop of ${args.source_id}: ${authorization.purpose}` });
        } catch (error) {
          const recovered = recoverableCropToolError(error, { processing });
          if (!recovered) throw error;
          result = recovered;
        }
      }
      if (!result.ok) {
        rejected += 1;
        await onProgress('視覺模型正在重新定位局部區域…', {
          phase: 'vision_crop_rejected',
          round: cropRound,
          code: result.error.code,
          retryable: result.error.retryable,
        });
      }
      messages.push(toolResultMessage(provider, call, result));
    }

    if (cropAssets.length > 0) {
      await onProgress(`視覺模型要求檢視 ${cropAssets.length} 個局部區域…`, { phase: 'vision_crop', round: cropRound, count: cropAssets.length });
      messages.push(userMessageForAssets(provider, cropAssets, 'Here are the requested high-resolution crops. Continue the analysis and return final Markdown, or request another precise crop only if still essential.'));
    } else if (rejected > 0) {
      messages.push({
        role: 'user',
        content: 'Review the crop tool error results. Correct the crop request only if a precise crop remains essential; otherwise finish the analysis from the existing evidence.',
      });
    }

    if (batchTooLarge || cropRound >= maxCropRounds) {
      toolsEnabled = false;
      messages.push({
        role: 'user',
        content: 'Crop tools are now unavailable. Complete the structured Markdown analysis using the original images, native text, successful crops, and available evidence. State uncertainty instead of requesting another crop.',
      });
    }
  }
}
