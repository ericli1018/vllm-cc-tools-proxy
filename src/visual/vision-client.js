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



const VISION_RECOVERY_PROMPT = 'The previous visual response did not contain sufficient observable evidence. Inspect the supplied image directly and return concrete visible objects, text, colors, layout, spatial relationships, diagram elements, and uncertainty. Do not discuss image access limitations, file metadata, resolution, or inability to view the image. Use request_image_crop only if a precise region is genuinely required.';

const REFUSAL_LIKE_PATTERNS = [
  /\b(?:unable|cannot|can't|could not|couldn't|do not have access|don't have access|cannot access|can't access|unable to access|cannot view|can't view|unable to view|cannot see|can't see|unable to see|no image|image unavailable|image is unavailable|image was not provided|image not provided)\b/i,
  /(?:無法|不能|看不到|未提供|沒有提供|無法存取|無法查看|無法辨識).{0,18}(?:圖片|圖像|影像|視覺|內容|檔案|畫面)?/u,
];

const OBSERVABLE_SIGNAL_PATTERN = /\b(?:shows?|contains?|depicts?|features?|visible|appears?|see|left|right|background|foreground|upper|lower|center|red|blue|green|black|white|yellow|purple|orange|person|people|character|woman|man|girl|boy|cat|dog|chair|table|diagram|chart|schematic|text|logo|button|screen|building|car|tree|line|arrow|label)\b/i;
const OBSERVABLE_CJK_PATTERN = /(?:顯示|可見|畫面|人物|角色|女性|男性|女孩|男孩|左側|右側|上方|下方|中央|背景|前景|紅色|藍色|綠色|黑色|白色|黃色|紫色|橘色|文字|標籤|圖表|示意圖|電路|箭頭|線條|按鈕|螢幕|建築|車輛|樹木)/u;
const METADATA_SIGNAL_PATTERN = /\b(?:resolution|dimensions?|pixels?|px|file(?:name| size)?|image size|display size|aspect ratio)\b/i;

function classifyVisionOutputQuality(content, { toolCallCount = 0 } = {}) {
  const text = String(content || '').trim();
  if (toolCallCount > 0) return { quality: 'tool_call', reasons: [], cacheable: false };
  if (!text) return { quality: 'empty', reasons: ['empty'], cacheable: false };

  const reasons = [];
  if (REFUSAL_LIKE_PATTERNS.some((pattern) => pattern.test(text))) reasons.push('refusal_like');
  const observableSignal = OBSERVABLE_SIGNAL_PATTERN.test(text) || OBSERVABLE_CJK_PATTERN.test(text);
  if (METADATA_SIGNAL_PATTERN.test(text) && !observableSignal && text.length < 180) reasons.push('metadata_only');
  if (text.length < 24 && !observableSignal) reasons.push('too_short');

  return reasons.length > 0
    ? { quality: 'weak', reasons, cacheable: false }
    : { quality: 'good', reasons: [], cacheable: true };
}


function dataUrl(asset) { return `data:${asset.mediaType};base64,${asset.buffer.toString('base64')}`; }

function assetDescription(assets, prompt) {
  return [
    prompt,
    ...assets.map((asset) => `source_id=${asset.sourceId}; root_source_id=${asset.rootSourceId || asset.sourceId}; parent_source_id=${asset.parentSourceId || 'none'}; depth=${asset.depth || 0}; label=${asset.label || asset.sourceId}; dimensions=${asset.width}x${asset.height}`),
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
    content.push({ type: 'text', text: `source_id=${asset.sourceId}; root_source_id=${asset.rootSourceId || asset.sourceId}; parent_source_id=${asset.parentSourceId || 'none'}; depth=${asset.depth || 0}; label=${asset.label || asset.sourceId}; dimensions=${asset.width}x${asset.height}` });
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

function sanitizeVisionContent(message) {
  const raw = String(message?.content || '');
  let inlineThinkRegions = 0;
  let orphanThinkTags = 0;
  let content = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, () => {
    inlineThinkRegions += 1;
    return '';
  });
  content = content.replace(/<\/?think\b[^>]*>/gi, () => {
    orphanThinkTags += 1;
    return '';
  });
  content = content.trim();
  return {
    content,
    nativeThinking: typeof message?.thinking === 'string' && message.thinking.trim().length > 0,
    inlineThinkRegions,
    orphanThinkTags,
  };
}

function assistantMessage(message, provider, visibleContent = String(message?.content || '')) {
  return {
    role: 'assistant',
    content: visibleContent,
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


function visionRequestSummary(endpoint, provider, model, assets) {
  const url = new URL(endpoint);
  return {
    provider,
    backend_host: url.host,
    endpoint_path: url.pathname,
    model,
    image_count: assets.length,
    dimensions: assets.map((asset) => `${asset.width}x${asset.height}`),
  };
}

async function emitEvent(callback, event, fields) {
  try { await callback(event, fields); } catch {}
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
  onEvent = () => {},
  maxCropRounds = 3,
  allowCrops = true,
  timeoutMs = 120000,
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
  let toolsEnabled = Boolean(allowCrops);
  let qualityRecoveryRetries = 0;
  let currentThink = Boolean(think);
  const transmittedAssets = [...assets];

  while (true) {
    const summary = visionRequestSummary(endpoint, provider, model, transmittedAssets);
    const requestStartedAt = Date.now();
    await emitEvent(onEvent, 'vision_upstream_request', summary);
    let payload;
    const requestTimeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000;
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      payload = await fetchJson(endpoint, {
        method: 'POST',
        signal: requestSignal,
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(requestBody({ provider, model, messages, think: currentThink, toolsEnabled })),
      }, { errorCode: 'vision_service_error' });
      await emitEvent(onEvent, 'vision_upstream_response', { ...summary, http_status: 200, elapsed_ms: Date.now() - requestStartedAt });
    } catch (error) {
      if (timeoutSignal.aborted && !signal?.aborted) {
        const timeoutError = new HttpError(504, `Visual service exceeded the configured ${requestTimeoutMs} ms request timeout.`, {
          code: 'vision_service_timeout',
          retryable: true,
          details: { transport_phase: 'deadline', timeout_ms: requestTimeoutMs },
        });
        await emitEvent(onEvent, 'vision_upstream_response', {
          ...summary,
          http_status: 504,
          elapsed_ms: Date.now() - requestStartedAt,
          code: timeoutError.code,
          retryable: true,
          transport_phase: 'deadline',
          timeout_ms: requestTimeoutMs,
        });
        throw timeoutError;
      }
      await emitEvent(onEvent, 'vision_upstream_response', {
        ...summary,
        http_status: Number.isInteger(error?.status) ? error.status : null,
        elapsed_ms: Date.now() - requestStartedAt,
        code: error?.code || 'vision_service_error',
        retryable: Boolean(error?.retryable),
        ...(error?.details?.transport_code ? { transport_code: error.details.transport_code } : {}),
        ...(error?.details?.transport_phase ? { transport_phase: error.details.transport_phase } : {}),
      });
      throw error;
    }
    const message = responseMessage(payload, provider);
    if (!message) throw new HttpError(502, 'Visual service returned no message.', { code: 'vision_invalid_response', retryable: true });
    const controlTags = scanControlTags(message.content || '');
    if (controlTags.length > 0) {
      const tags = [...new Set(controlTags.map((tag) => tag.replace(/[<>/]/g, '').split(/[=\s]/)[0].toLowerCase()))];
      await onDiagnostic('visual_control_tags_detected', { tagCount: controlTags.length, tags });
    }
    const sanitized = sanitizeVisionContent(message);
    if (sanitized.nativeThinking || sanitized.inlineThinkRegions > 0 || sanitized.orphanThinkTags > 0) {
      await onDiagnostic('visual_reasoning_stripped', {
        native_thinking: sanitized.nativeThinking,
        inline_think_regions: sanitized.inlineThinkRegions,
        orphan_think_tags: sanitized.orphanThinkTags,
      });
    }
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const quality = classifyVisionOutputQuality(sanitized.content, { toolCallCount: calls.length });
    await onDiagnostic('vision_output_observed', {
      content_chars: sanitized.content.length,
      thinking_chars: typeof message?.thinking === 'string' ? message.thinking.length : 0,
      tool_call_count: calls.length,
      control_tag_count: controlTags.length,
      usable_content: quality.quality === 'good',
    });
    await onDiagnostic('vision_output_quality', {
      quality: quality.quality,
      reasons: quality.reasons,
      cacheable: quality.cacheable,
    });

    if (calls.length === 0 || !toolsEnabled) {
      if (quality.quality === 'good') {
        return {
          markdown: sanitized.content,
          warnings: [],
          cropCount,
        };
      }
      if (qualityRecoveryRetries < 1) {
        qualityRecoveryRetries += 1;
        const previousThink = currentThink;
        if (quality.quality === 'empty') {
          await onDiagnostic('vision_empty_output_retry', {
            attempt: qualityRecoveryRetries,
            max_retries: 1,
            tool_call_count: calls.length,
          });
        }
        await onDiagnostic('vision_quality_retry', {
          attempt: qualityRecoveryRetries,
          max_retries: 1,
          quality: quality.quality,
          reasons: quality.reasons,
          from_think: previousThink,
          to_think: currentThink,
          strict: true,
        });
        await onProgress('圖片分析內容不足，正在以嚴格提示重試…', {
          phase: 'vision_quality_retry',
          attempt: qualityRecoveryRetries,
          max_retries: 1,
          reason: quality.reasons[0] || quality.quality,
        });
        messages.push({ role: 'user', content: VISION_RECOVERY_PROMPT });
        continue;
      }
      if (quality.quality === 'empty') {
        throw new HttpError(502, 'Visual service returned no usable visible content.', {
          code: 'vision_empty_output',
          retryable: true,
        });
      }
      throw new HttpError(502, 'Visual service returned low-quality visible content.', {
        code: 'vision_output_invalid',
        retryable: true,
        details: { quality: quality.quality, reasons: quality.reasons },
      });
    }

    messages.push(assistantMessage(message, provider, sanitized.content));
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
          const derived = registry.registerCrop(args.source_id, crop, authorization, { purpose: authorization.purpose });
          result = {
            ok: true,
            source_id: derived.sourceId,
            parent_source_id: args.source_id,
            root_source_id: derived.rootSourceId,
            depth: derived.depth,
            purpose: authorization.purpose,
            crop_index: cropCount,
          };
          cropAssets.push(derived);
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
      transmittedAssets.push(...cropAssets);
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
