import { HttpError } from '../lib/http.js';
import { fetchJson, serviceEndpoint } from '../lib/media.js';
import { neutralizeProtocolValue } from '../proxy/protocol-sanitizer.js';

export const DIRECTED_VISUAL_TOOL_NAME = 'VisualInspect';

export function isDirectedVisualToolName(name) {
  return String(name || '') === DIRECTED_VISUAL_TOOL_NAME;
}

function boundedString(value, max = 1000) {
  return String(value ?? '').slice(0, max);
}

export class DirectedVisualStore {
  constructor() {
    this.assets = new Map();
    this.nextId = 1;
  }

  register({
    buffer,
    mediaType,
    width,
    height,
    receivedWidth = width,
    receivedHeight = height,
    filename = '',
    sourceRef = '',
    sourceKind = 'direct_image',
    origin = 'direct',
    originTool = '',
  } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new HttpError(422, 'Directed visual asset is empty.', { code: 'invalid_visual_asset' });
    }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw new HttpError(422, 'Directed visual asset dimensions are invalid.', { code: 'invalid_visual_asset' });
    }
    const assetId = `visual-${this.nextId++}`;
    const asset = Object.freeze({
      assetId,
      buffer,
      mediaType: boundedString(mediaType, 100) || 'image/png',
      width: Math.round(width),
      height: Math.round(height),
      receivedWidth: Number.isFinite(receivedWidth) && receivedWidth > 0 ? Math.round(receivedWidth) : Math.round(width),
      receivedHeight: Number.isFinite(receivedHeight) && receivedHeight > 0 ? Math.round(receivedHeight) : Math.round(height),
      filename: boundedString(filename, 500),
      sourceRef: boundedString(sourceRef, 2000),
      sourceKind: boundedString(sourceKind, 100),
      origin: boundedString(origin, 100),
      originTool: boundedString(originTool, 100),
    });
    this.assets.set(assetId, asset);
    return asset;
  }

  get(assetId) {
    const asset = this.assets.get(String(assetId || ''));
    if (!asset) {
      throw new HttpError(422, `Unknown directed visual asset: ${String(assetId || '').slice(0, 100)}`, {
        code: 'unknown_visual_asset',
        retryable: false,
      });
    }
    return asset;
  }

  get size() {
    return this.assets.size;
  }

  clear() {
    this.assets.clear();
  }
}

export function formatDirectedVisualDescriptor(asset) {
  const descriptor = {
    asset_id: asset.assetId,
    media_type: asset.mediaType,
    received_width: asset.receivedWidth,
    received_height: asset.receivedHeight,
    normalized_width: asset.width,
    normalized_height: asset.height,
    source_kind: asset.sourceKind,
    ...(asset.filename ? { filename: asset.filename } : {}),
    ...(asset.sourceRef ? { source_ref: asset.sourceRef } : {}),
  };
  return [
    '[PROXY_VISUAL_ASSET]',
    JSON.stringify(descriptor),
    'The visual content is not directly visible to this text-only model. Use the VisualInspect tool when visual evidence is required. Ask only for task-relevant observable facts. If the result reports insufficient resolution, decide whether to reacquire/crop/re-read the source using normal Claude Code tools and then inspect the newly acquired image.',
  ].join('\n');
}

export function formatHistoricalDirectedVisualMarker({ filename = '', sourceKind = 'image' } = {}) {
  const descriptor = {
    source_kind: boundedString(sourceKind, 100) || 'image',
    ...(filename ? { filename: boundedString(filename, 500) } : {}),
  };
  return [
    '[PROXY_HISTORICAL_VISUAL]',
    JSON.stringify(descriptor),
    'This image belongs to an earlier conversation turn and is not loaded as a current visual asset. Do not treat it as newly provided visual evidence. If current visual evidence is needed, reacquire the image with normal Claude Code tools (for example Read, or crop then Read) so it arrives in the current turn.',
  ].join('\\n');
}

export function directedVisualToolDefinition() {
  return {
    name: DIRECTED_VISUAL_TOOL_NAME,
    description: 'Inspect a request-local image through the configured external Vision model. Use this only for asset_id values announced in [PROXY_VISUAL_ASSET]. Ask precise task-specific questions. The tool only reports observable visual evidence; it does not crop, modify files, or decide the final task.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        asset_id: { type: 'string', minLength: 1, maxLength: 100 },
        objective: { type: 'string', minLength: 1, maxLength: 2000 },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 100 },
              question: { type: 'string', minLength: 1, maxLength: 1000 },
            },
            required: ['id', 'question'],
          },
        },
      },
      required: ['asset_id', 'objective', 'questions'],
    },
  };
}


const DIRECTED_SYSTEM_PROMPT = `You are a visual perception sensor for a separate text-only reasoning agent. Answer only the requested questions using directly observable image content. Do not solve the user's overall task, recommend code changes, choose tools, or issue commands. Do not crop or request crops. If the current image resolution is insufficient, mark the affected question unresolved and identify the smallest useful follow-up region using normalized coordinates from 0 to 1000 where [0,0,1000,1000] is the full image. Return JSON only and exactly follow the requested schema.`;

const EVIDENCE_KINDS = new Set(['text', 'object', 'state', 'value', 'relationship']);
const RESULT_STATUSES = new Set(['complete', 'partial', 'unreadable']);
const ANSWER_STATUSES = new Set(['answered', 'unresolved']);

function validateText(value, { field, min = 0, max }) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new HttpError(422, `Invalid VisualInspect ${field}.`, { code: 'invalid_tool_input', retryable: false });
  }
  return value;
}

function validateQuestions(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) {
    throw new HttpError(422, 'VisualInspect questions must contain 1 to 8 items.', { code: 'invalid_tool_input', retryable: false });
  }
  const seen = new Set();
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new HttpError(422, 'VisualInspect question must be an object.', { code: 'invalid_tool_input', retryable: false });
    }
    const id = validateText(entry.id, { field: 'question id', min: 1, max: 100 });
    const question = validateText(entry.question, { field: 'question', min: 1, max: 1000 });
    if (seen.has(id)) throw new HttpError(422, 'VisualInspect question ids must be unique.', { code: 'invalid_tool_input', retryable: false });
    seen.add(id);
    return { id, question };
  });
}

function validateInspectInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(422, 'VisualInspect input must be an object.', { code: 'invalid_tool_input', retryable: false });
  }
  return {
    assetId: validateText(input.asset_id, { field: 'asset_id', min: 1, max: 100 }),
    objective: validateText(input.objective, { field: 'objective', min: 1, max: 2000 }),
    questions: validateQuestions(input.questions),
  };
}

function validBbox(value) {
  return Array.isArray(value)
    && value.length === 4
    && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 1000)
    && value[2] > value[0]
    && value[3] > value[1];
}

function resultSchemaError(message) {
  return new HttpError(502, message, { code: 'directed_vision_schema_invalid', retryable: true });
}

function boundedResultString(value, max, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw resultSchemaError(`Directed Vision ${field} is invalid.`);
  return value;
}

function validatePerceptionResult(raw, input) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw resultSchemaError('Directed Vision result must be a JSON object.');
  if (raw.schema !== 'visual_perception_v1') throw resultSchemaError('Directed Vision result schema is invalid.');
  if (raw.asset_id !== input.assetId) throw resultSchemaError('Directed Vision result asset_id does not match the request.');
  if (!RESULT_STATUSES.has(raw.status)) throw resultSchemaError('Directed Vision result status is invalid.');
  if (!Array.isArray(raw.answers) || raw.answers.length !== input.questions.length) {
    throw resultSchemaError('Directed Vision must return one answer for every requested question.');
  }
  const expected = new Set(input.questions.map((entry) => entry.id));
  const answered = new Set();
  const answers = raw.answers.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw resultSchemaError('Directed Vision answer is invalid.');
    const questionId = boundedResultString(entry.question_id, 100, 'question_id');
    if (!expected.has(questionId) || answered.has(questionId)) throw resultSchemaError('Directed Vision answer question_id is invalid or duplicated.');
    answered.add(questionId);
    if (!ANSWER_STATUSES.has(entry.status)) throw resultSchemaError('Directed Vision answer status is invalid.');
    const answer = boundedResultString(entry.answer, 4000, 'answer', { nullable: true });
    if (!Array.isArray(entry.evidence) || entry.evidence.length > 16) throw resultSchemaError('Directed Vision evidence is invalid.');
    const evidence = entry.evidence.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !EVIDENCE_KINDS.has(item.kind)) throw resultSchemaError('Directed Vision evidence item is invalid.');
      const value = boundedResultString(item.value, 4000, 'evidence value');
      if (item.region !== undefined && !validBbox(item.region)) throw resultSchemaError('Directed Vision evidence region is invalid.');
      return { kind: item.kind, value, ...(item.region !== undefined ? { region: [...item.region] } : {}) };
    });
    const uncertainty = boundedResultString(entry.uncertainty ?? '', 2000, 'uncertainty');
    if (entry.status === 'answered' && answer === null) throw resultSchemaError('Answered Directed Vision question requires a non-null answer.');
    return { question_id: questionId, status: entry.status, answer, evidence, uncertainty };
  });
  const followUpsRaw = raw.follow_up_regions ?? [];
  if (!Array.isArray(followUpsRaw) || followUpsRaw.length > 8) throw resultSchemaError('Directed Vision follow_up_regions is invalid.');
  const followUpRegions = followUpsRaw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !validBbox(entry.bbox)) throw resultSchemaError('Directed Vision follow-up region is invalid.');
    return {
      bbox: [...entry.bbox],
      target: boundedResultString(entry.target, 1000, 'follow-up target'),
      reason: boundedResultString(entry.reason, 1000, 'follow-up reason'),
    };
  });
  return neutralizeProtocolValue({
    schema: 'visual_perception_v1',
    asset_id: input.assetId,
    status: raw.status,
    answers,
    follow_up_regions: followUpRegions,
  });
}

function stripJsonFence(content) {
  const text = String(content ?? '').trim();
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return fenced ? fenced[1].trim() : text;
}

function responseContent(payload, provider) {
  if (provider === 'ollama') return payload?.message?.content;
  return payload?.choices?.[0]?.message?.content;
}

function visionEndpoint(baseUrl, provider) {
  return serviceEndpoint(baseUrl, provider === 'ollama' ? '/api/chat' : '/v1/chat/completions');
}

function requestBody(asset, input, config) {
  const request = {
    asset_id: input.assetId,
    objective: input.objective,
    questions: input.questions,
    required_output_schema: {
      schema: 'visual_perception_v1',
      asset_id: input.assetId,
      status: 'complete|partial|unreadable',
      answers: [{
        question_id: 'must match requested question id',
        status: 'answered|unresolved',
        answer: 'string or null',
        evidence: [{ kind: 'text|object|state|value|relationship', value: 'observable fact', region: [0, 0, 1000, 1000] }],
        uncertainty: 'string',
      }],
      follow_up_regions: [{ bbox: [0, 0, 1000, 1000], target: 'string', reason: 'string' }],
    },
  };
  const prompt = JSON.stringify(request);
  if (config.vllmVisionProvider === 'ollama') {
    return {
      model: config.vllmVisionModel,
      stream: false,
      think: Boolean(config.vllmVisionThink),
      messages: [
        { role: 'system', content: DIRECTED_SYSTEM_PROMPT },
        { role: 'user', content: prompt, images: [asset.buffer.toString('base64')] },
      ],
    };
  }
  return {
    model: config.vllmVisionModel,
    stream: false,
    reasoning_effort: config.vllmVisionThink ? 'high' : 'none',
    chat_template_kwargs: { enable_thinking: Boolean(config.vllmVisionThink) },
    messages: [
      { role: 'system', content: DIRECTED_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${asset.mediaType};base64,${asset.buffer.toString('base64')}` } },
        ],
      },
    ],
  };
}

export async function executeDirectedVisualInspect(store, rawInput, config, signal, {
  fetchJsonImpl = fetchJson,
  acquireVision = async () => () => {},
  onEvent = async () => {},
} = {}) {
  if (!config?.vllmVisionUrl || !config?.vllmVisionModel) {
    throw new HttpError(422, 'Visual endpoint is required for VisualInspect.', { code: 'vision_endpoint_required', retryable: false });
  }
  if (!['vllm', 'ollama'].includes(config.vllmVisionProvider || 'vllm')) {
    throw new HttpError(500, 'Unsupported visual provider.', { code: 'vision_provider_invalid', retryable: false });
  }
  const input = validateInspectInput(rawInput);
  const asset = store.get(input.assetId);
  const endpoint = visionEndpoint(config.vllmVisionUrl, config.vllmVisionProvider || 'vllm');
  const release = await acquireVision({ signal });
  const startedAt = Date.now();
  const timeoutMs = Number.isInteger(config.vllmVisionTimeoutMs) && config.vllmVisionTimeoutMs > 0 ? config.vllmVisionTimeoutMs : 120000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  await onEvent('directed_visual_inspect_started', {
    asset_id: asset.assetId,
    question_count: input.questions.length,
    media_type: asset.mediaType,
    width: asset.width,
    height: asset.height,
  });
  try {
    let payload;
    try {
      payload = await fetchJsonImpl(endpoint, {
        method: 'POST',
        signal: requestSignal,
        headers: { 'content-type': 'application/json', ...(config.vllmVisionApiKey ? { authorization: `Bearer ${config.vllmVisionApiKey}` } : {}) },
        body: JSON.stringify(requestBody(asset, input, config)),
      }, { errorCode: 'vision_service_error' });
    } catch (error) {
      if (timeoutSignal.aborted && !signal?.aborted) {
        throw new HttpError(504, `VisualInspect exceeded the configured ${timeoutMs} ms request timeout.`, {
          code: 'vision_service_timeout', retryable: true, details: { timeout_ms: timeoutMs },
        });
      }
      throw error;
    }
    const content = responseContent(payload, config.vllmVisionProvider || 'vllm');
    if (typeof content !== 'string' || !content.trim()) {
      throw new HttpError(502, 'Directed Vision returned no JSON content.', { code: 'directed_vision_invalid_json', retryable: true });
    }
    const maxChars = Math.min(65536, Number(config?.limits?.maxOutputChars) || 65536);
    if (content.length > maxChars) {
      throw new HttpError(502, 'Directed Vision JSON exceeds the bounded output size.', { code: 'directed_vision_schema_invalid', retryable: true });
    }
    let parsed;
    try { parsed = JSON.parse(stripJsonFence(content)); }
    catch {
      throw new HttpError(502, 'Directed Vision returned malformed JSON.', { code: 'directed_vision_invalid_json', retryable: true });
    }
    const result = validatePerceptionResult(parsed, input);
    await onEvent('directed_visual_inspect_completed', {
      asset_id: asset.assetId,
      question_count: input.questions.length,
      status: result.status,
      answered_count: result.answers.filter((entry) => entry.status === 'answered').length,
      unresolved_count: result.answers.filter((entry) => entry.status === 'unresolved').length,
      follow_up_region_count: result.follow_up_regions.length,
      elapsed_ms: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    await onEvent('directed_visual_inspect_failed', {
      asset_id: asset.assetId,
      question_count: input.questions.length,
      code: String(error?.code || error?.name || 'error').slice(0, 100),
      retryable: Boolean(error?.retryable),
      elapsed_ms: Date.now() - startedAt,
    });
    throw error;
  } finally {
    release();
  }
}
