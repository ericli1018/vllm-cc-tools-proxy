import { HttpError } from '../lib/http.js';
import { fetchJson } from '../lib/media.js';
import { cropToolError, asCropHttpError, recoverableCropToolError } from './crop-errors.js';
import { controlTagName, scanControlTags } from '../proxy/protocol-sanitizer.js';

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
VISUAL_STATUS: NEEDS_ZOOM
VISUAL_STATUS: UNREADABLE

If status is CONTENT, the next required contract line MUST be exactly one of:
VISUAL_DETAIL: SUFFICIENT
VISUAL_DETAIL: NEEDS_ZOOM
Then include:
VISUAL_COMPLETENESS: COMPLETE | PARTIAL
Then include the exact line VISUAL_EVIDENCE: followed by one or more Markdown bullet lines beginning with "- " that state concrete visible evidence.
Use COMPLETE when the returned evidence covers the relevant visible content required by the current visual task. Use PARTIAL when useful reliable evidence is recovered but important visible regions or details remain unresolved. PARTIAL is valid evidence but must not be treated as complete or cacheable.
Use VISUAL_DETAIL: SUFFICIENT only when the current image scale is sufficient to read the details needed for reliable evidence.
Use VISUAL_DETAIL: NEEDS_ZOOM when real content is visible but labels, values, relationships, table cells, nets, pins, or other required details are too small or dense to read reliably. Prefer request_image_crop when a precise region can be identified. If no reliable region can be selected, keep CONTENT + NEEDS_ZOOM so the caller can use deterministic overlapping tiles.
Concise evidence is valid; do not pad the answer to satisfy a length target.
If status is BLANK, do not invent content. The status line alone is valid, or it may be followed by a brief factual note.
Legacy VISUAL_STATUS: NEEDS_ZOOM remains accepted for compatibility and means that real content exists but whole-frame scale is insufficient.
If status is UNREADABLE, do not guess. You may add VISUAL_REASON: followed by a brief reason.
Do not return file metadata, image dimensions, or access-limit disclaimers as visual evidence.`;

const SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}\n\n${EVIDENCE_OUTPUT_CONTRACT}`;
const RAW_SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;

const MAX_VISION_RECOVERY_RETRIES = 3;
const RECOVERY_STRATEGIES = Object.freeze(['focused_recovery', 'structured_extraction', 'last_chance_salvage']);

const CONTENT_ADAPTIVE_EXTRACTION = `Adapt extraction to the content actually visible. Do not assume the media type.
- document/text: readable text, headings, labels, numbers and key statements
- table/form: headers, row/column relationships and readable cell values
- chart/plot: axes, legends, labels, values, trends and annotations
- diagram/flowchart: nodes, labels, arrows and explicit relationships
- technical drawing/schematic: identifiers, labels, values, pins, nets and explicit connections
- UI/screenshot: visible controls, labels, messages, values and state
- photo/scene/object: visible objects, text, state, actions and spatial relationships
- mixed/unknown: only facts that are directly visible.`;

function recoveryPromptFor({ reason, retryIndex, outputContract, recoveryContext, cropAvailable = true }) {
  const strategy = RECOVERY_STRATEGIES[Math.max(0, Math.min(RECOVERY_STRATEGIES.length - 1, retryIndex - 1))];
  if (outputContract === 'raw') {
    const rawPrefix = retryIndex === 1
      ? 'FOCUSED RECOVERY PASS. Continue the ORIGINAL visual task and prioritize a short direct answer.'
      : retryIndex === 2
        ? 'STRUCTURED RECOVERY PASS. Extract only the minimum visible facts needed to satisfy the ORIGINAL requested raw output format.'
        : 'FINAL RECOVERY PASS. Salvage the smallest reliable answer that still follows the ORIGINAL requested raw output format exactly.';
    const reasonText = reason === 'timeout'
      ? 'The previous request timed out. Prioritize speed over completeness and avoid long reasoning.'
      : 'The previous response was invalid or unusable. Do not add unrelated commentary.';
    return { strategy, prompt: `${rawPrefix}\n${reasonText}\nDo not change the original output schema or invent unreadable content.` };
  }

  const cropConstraint = cropAvailable
    ? ''
    : ' Crop tools are exhausted for this visual attempt. Do not request another crop. Use only the current images and successful crops; return reliable partial evidence and uncertainty when needed.';
  const reasonText = reason === 'timeout'
    ? `The previous request timed out. Prioritize speed over completeness. Do not reason about the entire image. Prefer short factual bullets and ignore details that cannot be read reliably.${cropConstraint}`
    : reason === 'crop_exhausted'
      ? `The maximum useful crop budget has been reached. No further crop is allowed.${cropConstraint} Recover all reliable evidence already visible instead of rejecting the whole image.`
    : reason === 'zoom_unresolved'
      ? cropAvailable
        ? `This is already a magnified or enlarged visual region. Do not request another generic zoom. Do not reject the entire region merely because some details remain small. Recover all reliable evidence already visible. If one precise smaller area is essential and can be identified accurately, request only that precise crop. Otherwise return partial reliable evidence and mark the remaining uncertainty.`
        : `This is already a magnified or enlarged visual region. Do not request another generic zoom or precise crop.${cropConstraint} Do not reject the entire region merely because some details remain small. Recover all reliable evidence already visible and mark the remaining uncertainty.`
      : `The previous response was empty, malformed, unreadable, contaminated by control tags, or otherwise unusable. Recover directly visible evidence without inventing content.${cropConstraint}`;

  const contract = `Use exactly one final status: VISUAL_STATUS: CONTENT | BLANK | NEEDS_ZOOM | UNREADABLE. For CONTENT use exactly: VISUAL_STATUS: CONTENT, then VISUAL_DETAIL: SUFFICIENT | NEEDS_ZOOM, then VISUAL_COMPLETENESS: COMPLETE | PARTIAL, then VISUAL_EVIDENCE: with one or more \"- \" bullets. BLANK is valid and must not invent content. For UNREADABLE do not guess. Do not emit XML/HTML/tool-call wrappers.`;

  if (retryIndex === 1) {
    return {
      strategy,
      prompt: `FOCUSED RECOVERY PASS. Continue serving the ORIGINAL visual-analysis task. Do not try to completely interpret the whole image before returning useful evidence.\n${reasonText}\n${CONTENT_ADAPTIVE_EXTRACTION}\nReturn the most relevant directly visible evidence.\n${contract}`,
    };
  }
  if (retryIndex === 2) {
    return {
      strategy,
      prompt: `STRUCTURED EXTRACTION RECOVERY. Do not attempt a complete interpretation. Extract only categories that actually exist in the image:\nTEXT: readable words, labels and numbers\nENTITIES: visible objects, components, controls, blocks, symbols or items\nVALUES: readable quantities, measurements, dates, identifiers or other values\nRELATIONSHIPS: explicit arrows, connections, containment, sequence, alignment or spatial relationships\nSTATE: visible status, warning, selection, condition or configuration\nUNCERTAINTY: important areas that cannot be read reliably\n${reasonText}\nA partial but reliable extraction is preferable to rejecting the whole image.\n${contract}`,
    };
  }
  return {
    strategy,
    prompt: `FINAL RECOVERY PASS. Salvage reliable evidence; do not attempt a complete analysis and do not produce a long explanation. Return every directly visible fact you can read with confidence, even if only a small amount is recoverable. Acceptable evidence includes readable text, labels, numbers, identifiers, objects, symbols, visible states, explicit connections, arrows, table cells, chart values and spatial relationships. Omit or mark uncertain anything that cannot be confirmed.\n${reasonText}\nThe goal is to salvage reliable evidence, not to fully solve the image. Keep the evidence concise.\n${contract}`,
  };
}


const VISUAL_STATUS_LINE_PATTERN = /^VISUAL_STATUS:\s*(CONTENT|BLANK|NEEDS_ZOOM|UNREADABLE)\s*$/i;
const VISUAL_STATUS_PREFIX_PATTERN = /^VISUAL_STATUS:/i;
const VISUAL_DETAIL_LINE_PATTERN = /^VISUAL_DETAIL:\s*(SUFFICIENT|NEEDS_ZOOM)\s*$/i;
const VISUAL_DETAIL_PREFIX_PATTERN = /^VISUAL_DETAIL:/i;
const VISUAL_COMPLETENESS_LINE_PATTERN = /^VISUAL_COMPLETENESS:\s*(COMPLETE|PARTIAL)\s*$/i;
const VISUAL_COMPLETENESS_PREFIX_PATTERN = /^VISUAL_COMPLETENESS:/i;
const VISUAL_EVIDENCE_LINE_PATTERN = /^VISUAL_EVIDENCE:\s*$/i;
const EVIDENCE_BULLET_PATTERN = /^\s*-\s+\S/;

function parseVisionEvidenceContract(content) {
  const text = String(content || '').trim();
  const lines = text.split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex < 0) return { visualStatus: null, visualDetail: null, visualCompleteness: null, contractValid: false, reasons: ['empty'] };

  const firstLine = lines[firstIndex].trim();
  const statusMatch = firstLine.match(VISUAL_STATUS_LINE_PATTERN);
  if (!statusMatch) {
    return {
      visualStatus: null,
      visualDetail: null,
      visualCompleteness: null,
      contractValid: false,
      reasons: [VISUAL_STATUS_PREFIX_PATTERN.test(firstLine) ? 'visual_status_invalid' : 'visual_status_missing'],
    };
  }

  const visualStatus = statusMatch[1].toLowerCase();
  if (visualStatus === 'blank') return { visualStatus, visualDetail: null, visualCompleteness: null, contractValid: true, reasons: [] };
  if (visualStatus === 'needs_zoom') {
    return { visualStatus, visualDetail: 'needs_zoom', visualCompleteness: 'partial', contractValid: true, reasons: ['visual_status_needs_zoom'] };
  }
  if (visualStatus === 'unreadable') {
    return { visualStatus, visualDetail: null, visualCompleteness: 'partial', contractValid: true, reasons: ['visual_status_unreadable'] };
  }

  const detailIndex = lines.findIndex((line, index) => index > firstIndex && VISUAL_DETAIL_PREFIX_PATTERN.test(line.trim()));
  if (detailIndex < 0) {
    return { visualStatus, visualDetail: null, visualCompleteness: null, contractValid: false, reasons: ['visual_detail_missing'] };
  }
  const detailMatch = lines[detailIndex].trim().match(VISUAL_DETAIL_LINE_PATTERN);
  if (!detailMatch) {
    return { visualStatus, visualDetail: null, visualCompleteness: null, contractValid: false, reasons: ['visual_detail_invalid'] };
  }
  const visualDetail = detailMatch[1].toLowerCase();
  const completenessIndex = lines.findIndex((line, index) => index > detailIndex && VISUAL_COMPLETENESS_PREFIX_PATTERN.test(line.trim()));
  let visualCompleteness = 'complete';
  if (completenessIndex >= 0) {
    const completenessMatch = lines[completenessIndex].trim().match(VISUAL_COMPLETENESS_LINE_PATTERN);
    if (!completenessMatch) {
      return { visualStatus, visualDetail, visualCompleteness: null, contractValid: false, reasons: ['visual_completeness_invalid'] };
    }
    visualCompleteness = completenessMatch[1].toLowerCase();
  }

  const evidenceAfterIndex = completenessIndex >= 0 ? completenessIndex : detailIndex;
  const evidenceMarkerIndex = lines.findIndex((line, index) => index > evidenceAfterIndex && VISUAL_EVIDENCE_LINE_PATTERN.test(line.trim()));
  if (evidenceMarkerIndex < 0) {
    return { visualStatus, visualDetail, visualCompleteness, contractValid: false, reasons: ['content_evidence_missing'] };
  }
  const hasEvidenceBullet = lines.slice(evidenceMarkerIndex + 1).some((line) => EVIDENCE_BULLET_PATTERN.test(line));
  if (!hasEvidenceBullet) {
    return { visualStatus, visualDetail, visualCompleteness, contractValid: false, reasons: ['content_evidence_missing'] };
  }
  if (visualDetail === 'needs_zoom') {
    return { visualStatus, visualDetail, visualCompleteness: 'partial', contractValid: true, reasons: ['visual_detail_needs_zoom'] };
  }
  return { visualStatus, visualDetail, visualCompleteness, contractValid: true, reasons: [] };
}

function repairVisionEvidenceContract(content) {
  const text = String(content || '').trim();
  const lines = text.split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex < 0) return { content: text, repaired: false, reason: '' };
  const firstLine = lines[firstIndex].trim();
  const statusMatch = firstLine.match(VISUAL_STATUS_LINE_PATTERN);
  if (!statusMatch || statusMatch[1].toLowerCase() !== 'content') {
    return { content: text, repaired: false, reason: '' };
  }
  const parsed = parseVisionEvidenceContract(text);
  if (parsed.contractValid || !parsed.reasons.includes('content_evidence_missing') || !parsed.visualDetail) {
    return { content: text, repaired: false, reason: '' };
  }
  const detailIndex = lines.findIndex((line, index) => index > firstIndex && VISUAL_DETAIL_LINE_PATTERN.test(line.trim()));
  if (detailIndex < 0) return { content: text, repaired: false, reason: '' };
  const reasonLines = lines.slice(firstIndex + 1)
    .map((line) => line.trim())
    .filter((line) => /^VISUAL_REASON:/i.test(line));
  const body = lines.slice(firstIndex + 1)
    .map((line) => line.trim())
    .filter((line) => line
      && !VISUAL_DETAIL_PREFIX_PATTERN.test(line)
      && !VISUAL_EVIDENCE_LINE_PATTERN.test(line)
      && !VISUAL_COMPLETENESS_PREFIX_PATTERN.test(line)
      && !/^VISUAL_REASON:/i.test(line));
  if (body.length === 0) return { content: text, repaired: false, reason: '' };
  const bullets = body.map((line) => EVIDENCE_BULLET_PATTERN.test(line) ? line : `- ${line.replace(/^#+\s*/, '')}`);
  return {
    content: [
      'VISUAL_STATUS: CONTENT',
      lines[detailIndex].trim(),
      ...(lines.find((line, index) => index > detailIndex && VISUAL_COMPLETENESS_LINE_PATTERN.test(line.trim())) ? [lines.find((line, index) => index > detailIndex && VISUAL_COMPLETENESS_LINE_PATTERN.test(line.trim())).trim()] : []),
      'VISUAL_EVIDENCE:',
      ...bullets,
      ...reasonLines,
    ].join('\n'),
    repaired: true,
    reason: 'content_evidence_marker_missing',
  };
}

function classifyVisionOutputQuality(content, { toolCallCount = 0, outputContract = 'evidence', controlTagCount = 0 } = {}) {
  const text = String(content || '').trim();
  if (toolCallCount > 0) {
    return { quality: 'tool_call', reasons: [], cacheable: false, visualStatus: null, visualDetail: null, visualCompleteness: null, contractValid: true };
  }
  if (!text) {
    return { quality: 'empty', reasons: ['empty'], cacheable: false, visualStatus: null, visualDetail: null, visualCompleteness: null, contractValid: false };
  }
  if (controlTagCount > 0) {
    const contract = outputContract === 'evidence'
      ? parseVisionEvidenceContract(text)
      : { visualStatus: null, visualDetail: null, visualCompleteness: null, contractValid: false };
    return { ...contract, quality: 'weak', reasons: ['control_tag_leak'], cacheable: false };
  }
  if (outputContract === 'raw') {
    return { quality: 'good', reasons: [], cacheable: true, visualStatus: null, visualDetail: null, visualCompleteness: null, contractValid: true };
  }

  const contract = parseVisionEvidenceContract(text);
  if (contract.visualStatus === 'blank' && contract.contractValid) {
    return { quality: 'good', reasons: [], cacheable: true, ...contract };
  }
  if (contract.visualStatus === 'content' && contract.visualDetail === 'sufficient' && contract.contractValid) {
    return { quality: 'good', reasons: [], cacheable: contract.visualCompleteness !== 'partial', ...contract };
  }
  if (contract.contractValid && (
    contract.visualStatus === 'needs_zoom'
    || (contract.visualStatus === 'content' && contract.visualDetail === 'needs_zoom')
  )) {
    return { quality: 'needs_zoom', cacheable: false, ...contract };
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
  allowNeedsZoomFallback = false,
  recoveryContext = 'default',
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
  let cropBudgetExhausted = false;
  const cropRoundLimit = recoveryContext === 'zoom_tile' ? Math.min(maxCropRounds, 1) : maxCropRounds;
  const transmittedAssets = [...assets];

  const scheduleRecovery = async (reason, { quality = null } = {}) => {
    if (qualityRecoveryRetries >= MAX_VISION_RECOVERY_RETRIES) {
      await onDiagnostic('vision_retry_exhausted', {
        attempts: 1 + qualityRecoveryRetries,
        max_retries: MAX_VISION_RECOVERY_RETRIES,
        final_reason: reason,
        recovery_context: recoveryContext,
      });
      return false;
    }
    qualityRecoveryRetries += 1;
    const recovery = recoveryPromptFor({ reason, retryIndex: qualityRecoveryRetries, outputContract, recoveryContext, cropAvailable: toolsEnabled && !cropBudgetExhausted });
    await onDiagnostic('vision_retry_started', {
      attempt: qualityRecoveryRetries,
      max_retries: MAX_VISION_RECOVERY_RETRIES,
      reason,
      prompt_strategy: recovery.strategy,
      recovery_context: recoveryContext,
    });
    if (quality) {
      if (quality.quality === 'empty') {
        await onDiagnostic('vision_empty_output_retry', {
          attempt: qualityRecoveryRetries,
          max_retries: MAX_VISION_RECOVERY_RETRIES,
          tool_call_count: 0,
        });
      }
      await onDiagnostic('vision_quality_retry', {
        attempt: qualityRecoveryRetries,
        max_retries: MAX_VISION_RECOVERY_RETRIES,
        quality: quality.quality,
        reasons: quality.reasons,
        from_think: currentThink,
        to_think: currentThink,
        strict: true,
        prompt_strategy: recovery.strategy,
      });
    }
    await onProgress(reason === 'timeout'
      ? '圖片分析逾時，正在以縮小任務範圍的提示重試…'
      : '圖片分析內容不足，正在以不同策略重試…', {
      phase: 'vision_quality_retry',
      attempt: qualityRecoveryRetries,
      max_retries: MAX_VISION_RECOVERY_RETRIES,
      reason,
      prompt_strategy: recovery.strategy,
    });
    messages.push({ role: 'user', content: recovery.prompt });
    return true;
  };

  const exhaustCropBudget = async (reason) => {
    if (cropBudgetExhausted) return;
    cropBudgetExhausted = true;
    toolsEnabled = false;
    await onDiagnostic('vision_crop_budget_exhausted', {
      reason,
      round: cropRound,
      recovery_context: recoveryContext,
      crop_count: cropCount,
    });
    await onProgress('已達目前圖片的局部放大上限，將使用現有畫面繼續分析…', {
      phase: 'vision_crop_budget_exhausted',
      reason,
      round: cropRound,
      recovery_context: recoveryContext,
      crop_count: cropCount,
    });
  };

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
        if (await scheduleRecovery('timeout')) continue;
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
    const evidenceControlTags = scanControlTags(sanitized.content || '');
    const evidenceControlTagNames = [...new Set(evidenceControlTags.map(controlTagName))];
    if (evidenceControlTags.length > 0) {
      await onDiagnostic('visual_evidence_control_tag_leak', {
        tagCount: evidenceControlTags.length,
        tags: evidenceControlTagNames,
      });
    }
    const repair = outputContract === 'evidence' && calls.length === 0 && evidenceControlTags.length === 0
      ? repairVisionEvidenceContract(sanitized.content)
      : { content: sanitized.content, repaired: false, reason: '' };
    const visibleContent = repair.content;
    if (repair.repaired) {
      await onDiagnostic('vision_contract_repaired', { reason: repair.reason, visual_status: 'content' });
    }
    const quality = classifyVisionOutputQuality(visibleContent, { toolCallCount: calls.length, outputContract, controlTagCount: evidenceControlTags.length });
    await onDiagnostic('vision_output_observed', {
      content_chars: visibleContent.length,
      thinking_chars: typeof message?.thinking === 'string' ? message.thinking.length : 0,
      tool_call_count: calls.length,
      control_tag_count: controlTags.length,
      evidence_control_tag_count: evidenceControlTags.length,
      usable_content: quality.quality === 'good',
      output_contract: outputContract,
      visual_status: quality.visualStatus,
      visual_detail: quality.visualDetail,
      visual_completeness: quality.visualCompleteness,
      contract_valid: quality.contractValid,
    });
    await onDiagnostic('vision_output_quality', {
      quality: quality.quality,
      reasons: quality.reasons,
      cacheable: quality.cacheable,
      output_contract: outputContract,
      visual_status: quality.visualStatus,
      visual_detail: quality.visualDetail,
      visual_completeness: quality.visualCompleteness,
      contract_valid: quality.contractValid,
    });

    if (calls.length === 0 || !toolsEnabled) {
      if (quality.quality === 'good') {
        return {
          markdown: visibleContent,
          warnings: repair.repaired ? ['vision_contract_repaired'] : [],
          cropCount,
          needsZoom: false,
          visualStatus: quality.visualStatus,
          visualDetail: quality.visualDetail,
          visualCompleteness: quality.visualCompleteness,
          cacheable: quality.cacheable !== false,
        };
      }
      if (quality.quality === 'needs_zoom') {
        await onDiagnostic('vision_needs_zoom', {
          visual_status: quality.visualStatus,
          visual_detail: quality.visualDetail,
          crop_count: cropCount,
          fallback_allowed: Boolean(allowNeedsZoomFallback),
        });
        await onProgress('整頁內容過於密集，需要放大局部區域…', {
          phase: 'vision_needs_zoom',
          crop_count: cropCount,
          fallback_allowed: Boolean(allowNeedsZoomFallback),
        });
        if (allowNeedsZoomFallback) {
          return {
            markdown: visibleContent,
            warnings: ['vision_needs_zoom'],
            cropCount,
            needsZoom: true,
            visualStatus: quality.visualStatus,
            visualDetail: quality.visualDetail,
            visualCompleteness: quality.visualCompleteness,
            cacheable: false,
          };
        }
        if (await scheduleRecovery(recoveryContext === 'zoom_tile' ? 'zoom_unresolved' : 'output_invalid', { quality })) continue;
      }
      const recoveryReason = recoveryContext === 'zoom_tile'
        && (quality.quality === 'needs_zoom' || quality.visualStatus === 'unreadable')
        ? 'zoom_unresolved'
        : (quality.reasons?.[0] || 'output_invalid');
      if (await scheduleRecovery(recoveryReason, { quality })) continue;
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

    messages.push(assistantMessage(message, provider, visibleContent));
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
          const authorization = registry.authorizeCrop(args.source_id, args.bbox, cropRound, { marginRatio: 0.12 });
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
          if (error?.code === 'visual_crop_depth_limit') {
            await exhaustCropBudget('visual_crop_depth_limit');
          }
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

    if (!cropBudgetExhausted && cropRound >= cropRoundLimit) {
      await exhaustCropBudget(recoveryContext === 'zoom_tile' ? 'zoom_tile_crop_round_limit' : 'visual_crop_round_limit');
    }

    if (cropAssets.length > 0) {
      await onProgress(`視覺模型要求檢視 ${cropAssets.length} 個局部區域…`, { phase: 'vision_crop', round: cropRound, count: cropAssets.length });
      transmittedAssets.push(...cropAssets);
      messages.push(userMessageForAssets(provider, cropAssets, cropBudgetExhausted
        ? 'Here are the requested high-resolution crops. Crop tools are now exhausted for this visual attempt. Analyze these crops and the existing images, return reliable evidence, and state uncertainty instead of requesting another crop.'
        : 'Here are the requested high-resolution crops. Continue the analysis and return final Markdown, or request another precise crop only if still essential.'));
    } else if (rejected > 0) {
      messages.push({
        role: 'user',
        content: cropBudgetExhausted
          ? 'Review the crop tool error results. Crop tools are exhausted. Finish from the existing images and successful crops; preserve reliable partial evidence and state uncertainty.'
          : 'Review the crop tool error results. Correct the crop request only if a precise crop remains essential; otherwise finish the analysis from the existing evidence.',
      });
    }

    if (batchTooLarge && !cropBudgetExhausted) {
      await exhaustCropBudget('visual_crop_batch_limit');
    }
    if (cropBudgetExhausted) {
      messages.push({
        role: 'user',
        content: 'Crop tools are now unavailable. Complete the structured Markdown analysis using the original images, native text, successful crops, and available evidence. State uncertainty instead of requesting another crop.',
      });
      if (cropAssets.length === 0 && rejected > 0) {
        if (await scheduleRecovery('crop_exhausted')) continue;
      }
    }
  }
}
