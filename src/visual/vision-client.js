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

const BASE_SYSTEM_PROMPT = 'You are a bounded document and image analysis worker. Return Markdown only. Do not emit XML, HTML, reasoning delimiters, tool-call wrappers, function-result wrappers, chat-template tokens, or meta closing tags. Do not invent unreadable content. Use request_image_crop only for a precise region, then finish with evidence-focused Markdown.';

const EVIDENCE_OUTPUT_CONTRACT = `For every final non-tool visual response, the first non-empty line MUST be exactly one of:
VISUAL_STATUS: CONTENT
VISUAL_STATUS: BLANK
VISUAL_STATUS: UNREADABLE

If status is CONTENT, immediately include the exact line VISUAL_EVIDENCE: followed by one or more Markdown bullet lines beginning with "- " that state concrete visible evidence. Concise evidence is valid; do not pad the answer to satisfy a length target.
If status is BLANK, do not invent content. The status line alone is valid, or it may be followed by a brief factual note.
If status is UNREADABLE, do not guess. You may add VISUAL_REASON: followed by a brief reason.
Do not return file metadata, image dimensions, or access-limit disclaimers as visual evidence.`;

const SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}\n\n${EVIDENCE_OUTPUT_CONTRACT}`;
const RAW_SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;

const VISION_RECOVERY_PROMPT = `The previous final visual response was empty, unreadable, or violated the required output contract. Inspect the supplied image directly and follow this contract exactly:
VISUAL_STATUS: CONTENT | BLANK | UNREADABLE
For CONTENT, include the exact line VISUAL_EVIDENCE: followed by one or more "- " evidence bullets.
For BLANK, do not invent content; the status line alone is valid.
For UNREADABLE, do not guess; you may add VISUAL_REASON:.
Concise valid evidence is acceptable. Do not discuss image access limitations, file metadata, resolution, or inability to view the image. Use request_image_crop only if a precise region is genuinely required.`;

const RAW_RECOVERY_PROMPT = 'The previous response was empty or invalid. Inspect the supplied image directly and follow the requested output format exactly. Do not add unrelated commentary.';

const VISUAL_STATUS_LINE_PATTERN = /^VISUAL_STATUS:\s*(CONTENT|BLANK|UNREADABLE)\s*$/i;
const VISUAL_STATUS_PREFIX_PATTERN = /^VISUAL_STATUS:/i;
const VISUAL_EVIDENCE_LINE_PATTERN = /^VISUAL_EVIDENCE:\s*$/i;
const EVIDENCE_BULLET_PATTERN = /^\s*-\s+\S/;

function parseVisionEvidenceContract(content) {
  const text = String(content || '').trim();
  const lines = text.split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex < 0) return { visualStatus: null, contractValid: false, reasons: ['empty'] };

  const firstLine = lines[firstIndex].trim();
  const statusMatch = firstLine.match(VISUAL_STATUS_LINE_PATTERN);
  if (!statusMatch) {
    return {
      visualStatus: null,
      contractValid: false,
      reasons: [VISUAL_STATUS_PREFIX_PATTERN.test(firstLine) ? 'visual_status_invalid' : 'visual_status_missing'],
    };
  }

  const visualStatus = statusMatch[1].toLowerCase();
  if (visualStatus === 'blank') return { visualStatus, contractValid: true, reasons: [] };
  if (visualStatus === 'unreadable') {
    return { visualStatus, contractValid: true, reasons: ['visual_status_unreadable'] };
  }

  const evidenceMarkerIndex = lines.findIndex((line, index) => index > firstIndex && VISUAL_EVIDENCE_LINE_PATTERN.test(line.trim()));
  if (evidenceMarkerIndex < 0) {
    return { visualStatus, contractValid: false, reasons: ['content_evidence_missing'] };
  }
  const hasEvidenceBullet = lines.slice(evidenceMarkerIndex + 1).some((line) => EVIDENCE_BULLET_PATTERN.test(line));
  if (!hasEvidenceBullet) {
    return { visualStatus, contractValid: false, reasons: ['content_evidence_missing'] };
  }
  return { visualStatus, contractValid: true, reasons: [] };
}

function classifyVisionOutputQuality(content, { toolCallCount = 0, outputContract = 'evidence' } = {}) {
  const text = String(content || '').trim();
  if (toolCallCount > 0) {
    return { quality: 'tool_call', reasons: [], cacheable: false, visualStatus: null, contractValid: true };
  }
  if (!text) {
    return { quality: 'empty', reasons: ['empty'], cacheable: false, visualStatus: null, contractValid: false };
  }
  if (outputContract === 'raw') {
    return { quality: 'good', reasons: [], cacheable: true, visualStatus: null, contractValid: true };
  }

  const contract = parseVisionEvidenceContract(text);
  if (contract.visualStatus === 'blank' && contract.contractValid) {
    return { quality: 'good', reasons: [], cacheable: true, ...contract };
  }
  if (contract.visualStatus === 'content' && contract.contractValid) {
    return { quality: 'good', reasons: [], cacheable: true, ...contract };
  }
  return { quality: 'weak', cacheable: false, ...contract };
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
  outputContract = 'evidence',
  timeoutMs = 120000,
  prompt = 'Analyze observable content only. Preserve source identifiers. Extract visible text, tables, diagrams, arrows, relationships and uncertainty. Do not answer the user final task. Request a crop only when necessary.',
} = {}) {
  if (!baseUrl || !model) throw new HttpError(422, 'Visual endpoint is required for this media.', { code: 'vision_endpoint_required' });
  if (!['vllm', 'ollama'].includes(provider)) throw new HttpError(500, 'Unsupported visual provider.', { code: 'vision_provider_invalid' });
  const endpoint = endpointFor(baseUrl, provider);
  const messages = [
    { role: 'system', content: outputContract === 'raw' ? RAW_SYSTEM_PROMPT : SYSTEM_PROMPT },
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
    const quality = classifyVisionOutputQuality(sanitized.content, { toolCallCount: calls.length, outputContract });
    await onDiagnostic('vision_output_observed', {
      content_chars: sanitized.content.length,
      thinking_chars: typeof message?.thinking === 'string' ? message.thinking.length : 0,
      tool_call_count: calls.length,
      control_tag_count: controlTags.length,
      usable_content: quality.quality === 'good',
      output_contract: outputContract,
      visual_status: quality.visualStatus,
      contract_valid: quality.contractValid,
    });
    await onDiagnostic('vision_output_quality', {
      quality: quality.quality,
      reasons: quality.reasons,
      cacheable: quality.cacheable,
      output_contract: outputContract,
      visual_status: quality.visualStatus,
      contract_valid: quality.contractValid,
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
        messages.push({ role: 'user', content: outputContract === 'raw' ? RAW_RECOVERY_PROMPT : VISION_RECOVERY_PROMPT });
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
