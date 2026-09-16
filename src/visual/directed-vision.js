import { HttpError } from '../lib/http.js';
import { fetchJson, serviceEndpoint } from '../lib/media.js';
import { neutralizeProtocolValue } from '../proxy/protocol-sanitizer.js';

function boundedString(value, max = 1000) {
  return String(value ?? '').slice(0, max);
}

export class DirectedVisualStore {
  constructor() {
    this.assets = new Map();
    this.nextId = 1;
  }

  register({
    buffer, mediaType, width, height, receivedWidth = width, receivedHeight = height,
    filename = '', sourceRef = '', sourceKind = 'direct_image', origin = 'direct', originTool = '',
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
      width: Math.round(width), height: Math.round(height),
      receivedWidth: Number.isFinite(receivedWidth) && receivedWidth > 0 ? Math.round(receivedWidth) : Math.round(width),
      receivedHeight: Number.isFinite(receivedHeight) && receivedHeight > 0 ? Math.round(receivedHeight) : Math.round(height),
      filename: boundedString(filename, 500), sourceRef: boundedString(sourceRef, 2000),
      sourceKind: boundedString(sourceKind, 100), origin: boundedString(origin, 100), originTool: boundedString(originTool, 100),
    });
    this.assets.set(assetId, asset);
    return asset;
  }

  get(assetId) {
    const asset = this.assets.get(String(assetId || ''));
    if (!asset) {
      throw new HttpError(422, `Unknown directed visual asset: ${String(assetId || '').slice(0, 100)}`, {
        code: 'unknown_visual_asset', retryable: false,
      });
    }
    return asset;
  }

  values() { return [...this.assets.values()]; }
  get size() { return this.assets.size; }
  clear() { this.assets.clear(); }
}

function assetMetadata(asset) {
  return {
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
}

export function formatDirectedVisualInput(asset) {
  return [
    '[PROXY_VISUAL_INPUT]',
    JSON.stringify(assetMetadata(asset)),
    'This image was intentionally acquired in the current interaction. The visual content is not directly visible during perception planning. Plan exactly what observable information must be extracted from this image for the current task.',
  ].join('\n');
}

const PLANNING_TOOL_NAME = 'SubmitVisualPlan';

const PLANNING_INSTRUCTION = `[VCC_DIRECTED_VISUAL_PLANNING_V2]
This is a hidden perception-planning phase for exactly one image that was intentionally acquired in the current interaction. The image itself is not visible to you in this phase. Decide only what observable information must be extracted from the image for the current task. Do not solve the user's task, do not recommend commands, do not call any other tool, and do not claim to see pixels. You MUST call SubmitVisualPlan exactly once. The tool call is the only accepted planning result.`;

function appendSystemInstruction(system, text) {
  if (Array.isArray(system)) return [...structuredClone(system), { type: 'text', text }];
  if (typeof system === 'string' && system) return `${system}\n\n${text}`;
  return text;
}

function directedPlanningToolDefinition() {
  return {
    name: PLANNING_TOOL_NAME,
    description: 'Submit the exact visual perception objective and observable questions for the single image in the current planning transaction. You must use this tool exactly once.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['objective', 'questions'],
      properties: {
        objective: { type: 'string', minLength: 1, maxLength: 2000 },
        questions: {
          type: 'array', minItems: 1, maxItems: 8,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'question'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 100 },
              question: { type: 'string', minLength: 1, maxLength: 1000 },
            },
          },
        },
      },
    },
  };
}

function normalizePlanningAsset(assetOrStore) {
  if (assetOrStore?.assetId) return assetOrStore;
  if (assetOrStore && typeof assetOrStore.values === 'function') {
    const values = assetOrStore.values();
    if (values.length === 1) return values[0];
  }
  throw new HttpError(500, 'Directed perception planning requires exactly one current visual asset.', { code: 'directed_visual_assets_missing' });
}

function keepOnlyPlanningAsset(value, assetId) {
  if (Array.isArray(value)) return value.map((entry) => keepOnlyPlanningAsset(entry, assetId)).filter((entry) => entry !== null);
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'text' && typeof value.text === 'string' && value.text.startsWith('[PROXY_VISUAL_INPUT]')) {
    return value.text.includes(`"asset_id":"${assetId}"`) ? value : null;
  }
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    const filtered = keepOnlyPlanningAsset(entry, assetId);
    if (filtered !== null) output[key] = filtered;
  }
  return output;
}

export function buildDirectedPlanningRequest(request, assetOrStore) {
  const asset = normalizePlanningAsset(assetOrStore);
  const planning = structuredClone(request || {});
  planning.messages = keepOnlyPlanningAsset(planning.messages || [], asset.assetId);
  planning.stream = false;
  planning.system = appendSystemInstruction(planning.system, PLANNING_INSTRUCTION);
  planning.tools = [directedPlanningToolDefinition()];
  planning.tool_choice = { type: 'tool', name: PLANNING_TOOL_NAME, disable_parallel_tool_use: true };
  delete planning.output_config;
  if (Number.isInteger(planning.max_tokens)) planning.max_tokens = Math.min(planning.max_tokens, 4096);
  else planning.max_tokens = 4096;
  return planning;
}

function stripJsonFence(content) {
  const text = String(content ?? '').trim();
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return fenced ? fenced[1].trim() : text;
}

function planningError(message) {
  return new HttpError(502, message, { code: 'directed_planning_invalid', retryable: true });
}

function validatePlanQuestion(entry, seen) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw planningError('Directed perception planning question is invalid.');
  const id = boundedString(entry.id, 100);
  const question = boundedString(entry.question, 1000);
  if (!id || !question || seen.has(id)) throw planningError('Directed perception planning question id/text is invalid or duplicated.');
  seen.add(id);
  return { id, question };
}

export function parseDirectedPlanningResponse(payload, assetOrStore) {
  const asset = normalizePlanningAsset(assetOrStore);
  const toolUses = Array.isArray(payload?.content)
    ? payload.content.filter((block) => block?.type === 'tool_use' && block?.name === PLANNING_TOOL_NAME)
    : [];
  if (toolUses.length !== 1) throw planningError('Directed perception planning must return exactly one SubmitVisualPlan tool call.');
  const raw = toolUses[0]?.input;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw planningError('Directed perception planning tool input is invalid.');
  const objective = boundedString(raw.objective, 2000);
  if (!objective) throw planningError('Directed perception planning objective is invalid.');
  if (!Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 8) throw planningError('Directed perception planning requires 1 to 8 questions.');
  const questionIds = new Set();
  const questions = raw.questions.map((question) => validatePlanQuestion(question, questionIds));
  return neutralizeProtocolValue({ asset_id: asset.assetId, objective, questions });
}

const SENSOR_SYSTEM_PROMPT = `You are a visual perception sensor for a separate text-only reasoning agent. Answer only the requested questions using directly observable image content. Do not solve the user's overall task, recommend code changes, choose tools, or issue commands. Do not crop or request a crop operation. If current resolution is insufficient, mark the question unresolved and report the smallest useful follow-up region using normalized 0..1000 coordinates. Return JSON only and exactly follow the requested schema.`;
const EVIDENCE_KINDS = new Set(['text', 'object', 'state', 'value', 'relationship']);
const RESULT_STATUSES = new Set(['complete', 'partial', 'unreadable']);
const ANSWER_STATUSES = new Set(['answered', 'unresolved']);

function validBbox(value) {
  return Array.isArray(value) && value.length === 4
    && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 1000)
    && value[2] > value[0] && value[3] > value[1];
}
function resultSchemaError(message) { return new HttpError(502, message, { code: 'directed_vision_schema_invalid', retryable: true }); }
function resultString(value, max, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw resultSchemaError(`Directed Vision ${field} is invalid.`);
  return value;
}
function validatePerceptionResult(raw, plan) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema !== 'visual_perception_v1' || raw.asset_id !== plan.asset_id || !RESULT_STATUSES.has(raw.status)) {
    throw resultSchemaError('Directed Vision result envelope is invalid.');
  }
  if (!Array.isArray(raw.answers) || raw.answers.length !== plan.questions.length) throw resultSchemaError('Directed Vision must return one answer for every question.');
  const expected = new Set(plan.questions.map((q) => q.id));
  const seen = new Set();
  const answers = raw.answers.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw resultSchemaError('Directed Vision answer is invalid.');
    const questionId = resultString(entry.question_id, 100, 'question_id');
    if (!expected.has(questionId) || seen.has(questionId) || !ANSWER_STATUSES.has(entry.status)) throw resultSchemaError('Directed Vision answer question_id/status is invalid.');
    seen.add(questionId);
    const answer = resultString(entry.answer, 4000, 'answer', { nullable: true });
    if (entry.status === 'answered' && answer === null) throw resultSchemaError('Answered Directed Vision question requires an answer.');
    if (!Array.isArray(entry.evidence) || entry.evidence.length > 16) throw resultSchemaError('Directed Vision evidence is invalid.');
    const evidence = entry.evidence.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !EVIDENCE_KINDS.has(item.kind)) throw resultSchemaError('Directed Vision evidence item is invalid.');
      if (item.region !== undefined && !validBbox(item.region)) throw resultSchemaError('Directed Vision evidence region is invalid.');
      return { kind: item.kind, value: resultString(item.value, 4000, 'evidence value'), ...(item.region !== undefined ? { region: [...item.region] } : {}) };
    });
    return { question_id: questionId, status: entry.status, answer, evidence, uncertainty: resultString(entry.uncertainty ?? '', 2000, 'uncertainty') };
  });
  const followUps = raw.follow_up_regions ?? [];
  if (!Array.isArray(followUps) || followUps.length > 8) throw resultSchemaError('Directed Vision follow_up_regions is invalid.');
  return neutralizeProtocolValue({
    schema: 'visual_perception_v1', asset_id: plan.asset_id, status: raw.status, answers,
    follow_up_regions: followUps.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !validBbox(entry.bbox)) throw resultSchemaError('Directed Vision follow-up region is invalid.');
      return { bbox: [...entry.bbox], target: resultString(entry.target, 1000, 'follow-up target'), reason: resultString(entry.reason, 1000, 'follow-up reason') };
    }),
  });
}

function visionResponseContent(payload, provider) {
  if (provider === 'ollama') return payload?.message?.content;
  return payload?.choices?.[0]?.message?.content;
}
function visionEndpoint(baseUrl, provider) { return serviceEndpoint(baseUrl, provider === 'ollama' ? '/api/chat' : '/v1/chat/completions'); }
function visionRequestBody(asset, plan, config) {
  const request = {
    asset_id: plan.asset_id, objective: plan.objective, questions: plan.questions,
    required_output_schema: {
      schema: 'visual_perception_v1', asset_id: plan.asset_id, status: 'complete|partial|unreadable',
      answers: [{ question_id: 'requested id', status: 'answered|unresolved', answer: 'string or null', evidence: [{ kind: 'text|object|state|value|relationship', value: 'observable fact', region: [0, 0, 1000, 1000] }], uncertainty: 'string' }],
      follow_up_regions: [{ bbox: [0, 0, 1000, 1000], target: 'string', reason: 'string' }],
    },
  };
  const prompt = JSON.stringify(request);
  if (config.vllmVisionProvider === 'ollama') {
    return { model: config.vllmVisionModel, stream: false, think: Boolean(config.vllmVisionThink), messages: [{ role: 'system', content: SENSOR_SYSTEM_PROMPT }, { role: 'user', content: prompt, images: [asset.buffer.toString('base64')] }] };
  }
  return {
    model: config.vllmVisionModel, stream: false,
    reasoning_effort: config.vllmVisionThink ? 'high' : 'none', chat_template_kwargs: { enable_thinking: Boolean(config.vllmVisionThink) },
    messages: [{ role: 'system', content: SENSOR_SYSTEM_PROMPT }, { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${asset.mediaType};base64,${asset.buffer.toString('base64')}` } }] }],
  };
}

export async function executeDirectedPerception(store, plan, config, signal, {
  fetchJsonImpl = fetchJson, acquireVision = async () => () => {}, onEvent = async () => {},
} = {}) {
  if (!config?.vllmVisionUrl || !config?.vllmVisionModel) throw new HttpError(422, 'Visual endpoint is required for directed perception.', { code: 'vision_endpoint_required', retryable: false });
  if (!['vllm', 'ollama'].includes(config.vllmVisionProvider || 'vllm')) throw new HttpError(500, 'Unsupported visual provider.', { code: 'vision_provider_invalid', retryable: false });
  const asset = store.get(plan?.asset_id);
  if (!plan?.objective || !Array.isArray(plan?.questions) || plan.questions.length < 1) throw new HttpError(422, 'Directed perception plan is invalid.', { code: 'directed_planning_invalid', retryable: false });
  const endpoint = visionEndpoint(config.vllmVisionUrl, config.vllmVisionProvider || 'vllm');
  const release = await acquireVision({ signal });
  const startedAt = Date.now();
  const timeoutMs = Number.isInteger(config.vllmVisionTimeoutMs) && config.vllmVisionTimeoutMs > 0 ? config.vllmVisionTimeoutMs : 120000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  await onEvent('directed_perception_started', { asset_id: asset.assetId, question_count: plan.questions.length, media_type: asset.mediaType, width: asset.width, height: asset.height });
  try {
    let payload;
    try {
      payload = await fetchJsonImpl(endpoint, { method: 'POST', signal: requestSignal, headers: { 'content-type': 'application/json', ...(config.vllmVisionApiKey ? { authorization: `Bearer ${config.vllmVisionApiKey}` } : {}) }, body: JSON.stringify(visionRequestBody(asset, plan, config)) }, { errorCode: 'vision_service_error' });
    } catch (error) {
      if (timeoutSignal.aborted && !signal?.aborted) throw new HttpError(504, `Directed perception exceeded ${timeoutMs} ms.`, { code: 'vision_service_timeout', retryable: true, details: { timeout_ms: timeoutMs } });
      throw error;
    }
    const content = visionResponseContent(payload, config.vllmVisionProvider || 'vllm');
    if (typeof content !== 'string' || !content.trim()) throw new HttpError(502, 'Directed Vision returned no JSON content.', { code: 'directed_vision_invalid_json', retryable: true });
    const maxChars = Math.min(65536, Number(config?.limits?.maxOutputChars) || 65536);
    if (content.length > maxChars) throw resultSchemaError('Directed Vision JSON exceeds the bounded output size.');
    let parsed;
    try { parsed = JSON.parse(stripJsonFence(content)); }
    catch { throw new HttpError(502, 'Directed Vision returned malformed JSON.', { code: 'directed_vision_invalid_json', retryable: true }); }
    const result = validatePerceptionResult(parsed, plan);
    await onEvent('directed_perception_completed', { asset_id: asset.assetId, question_count: plan.questions.length, status: result.status, answered_count: result.answers.filter((a) => a.status === 'answered').length, unresolved_count: result.answers.filter((a) => a.status === 'unresolved').length, follow_up_region_count: result.follow_up_regions.length, elapsed_ms: Date.now() - startedAt });
    return result;
  } catch (error) {
    await onEvent('directed_perception_failed', { asset_id: asset.assetId, question_count: plan.questions.length, code: String(error?.code || error?.name || 'error').slice(0, 100), retryable: Boolean(error?.retryable), elapsed_ms: Date.now() - startedAt });
    throw error;
  } finally { release(); }
}

function evidenceText(assetId, entry) {
  return [
    '[PROXY_VISUAL_EVIDENCE]',
    JSON.stringify(neutralizeProtocolValue({ asset_id: assetId, perception_request: entry.plan, perception_result: entry.result })),
    'This is one-shot visual sensor evidence from the image acquired in the current interaction. Use it for the current task. If it reports partial/unresolved content or follow_up_regions, decide yourself whether to reacquire/read/crop using normal Claude Code tools. The Proxy will not perform another visual round automatically.',
  ].join('\n');
}

export function injectDirectedPerceptionEvidence(messages, evidenceByAssetId) {
  const replace = (value) => {
    if (Array.isArray(value)) return value.map(replace).filter((entry) => entry !== null);
    if (!value || typeof value !== 'object') return value;
    if (value.type === 'text' && typeof value.text === 'string' && value.text.startsWith('[PROXY_VISUAL_INPUT]\n')) {
      const line = value.text.split('\n', 2)[1] || '{}';
      let descriptor = {};
      try { descriptor = JSON.parse(line); } catch {}
      const assetId = String(descriptor.asset_id || '');
      const evidence = evidenceByAssetId?.get?.(assetId);
      if (!evidence) throw new HttpError(500, `Missing directed perception evidence for ${assetId || 'unknown asset'}.`, { code: 'directed_perception_evidence_missing' });
      return { type: 'text', text: evidenceText(assetId, evidence) };
    }
    const clone = { ...value };
    if (Array.isArray(value.content)) clone.content = value.content.map(replace).filter((entry) => entry !== null);
    return clone;
  };
  return replace(structuredClone(messages || []));
}
