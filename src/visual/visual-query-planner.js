import { HttpError } from '../lib/http.js';

export const VISUAL_QUERY_PLANNER_MARKER = 'VCC_PROXY_VISUAL_PLANNER_V1';
export const VISUAL_QUERY_PLAN_SCHEMA = 'visual-query-plan-v1';
export const VISUAL_QUERY_PLAN_TOOL = 'submit_visual_plan';
export const VISUAL_QUERY_PLANNER_FALLBACK_MARKER = 'VCC_PROXY_VISUAL_PLANNER_FALLBACK_V1';

const PLANNER_INSTRUCTION = `[${VISUAL_QUERY_PLANNER_MARKER}]
You are the Proxy's internal visual perception planner.
A fresh image source has been detected for the current task, but you do not receive image pixels.
Use the ENTIRE existing Main context to decide only WHAT observable facts should be inspected in the listed VCC_VISUAL_SOURCE handles.
Do not answer the user's final task. Do not claim to see image content.
You MUST call the internal ${VISUAL_QUERY_PLAN_TOOL} tool exactly once with the perception plan.
Do not emit the plan as prose or JSON text.
Questions must ask for observable visual facts, not final-task reasoning.`;

const PLANNER_FALLBACK_INSTRUCTION = `[${VISUAL_QUERY_PLANNER_FALLBACK_MARKER}]
The previous internal visual planning attempt did not produce the required tool call.
Use the SAME complete Main context to produce the visual perception plan.
Return exactly one JSON object and nothing else.
The JSON must contain: schema_version, source_ids, objective, questions, requested_evidence, detail_level.
Do not answer the user's final task. Do not claim to see image pixels.`;

function appendSystem(system, text) {
  if (typeof system === 'string') return system ? `${system}\n\n${text}` : text;
  if (Array.isArray(system)) return [...structuredClone(system), { type:'text', text }];
  return text;
}

function plannerRequestText(sourceIds) {
  return [
    '[VCC_PROXY_VISUAL_PLANNER_REQUEST]',
    `Fresh source_ids: ${JSON.stringify(sourceIds)}`,
    'Use the complete existing Main request context, conversation, recent tool calls, filenames, and source metadata to decide what the Vision sensor should inspect.',
    `Call ${VISUAL_QUERY_PLAN_TOOL} exactly once.`,
  ].join('\n');
}

function visualPlanTool(sourceIds) {
  return {
    name: VISUAL_QUERY_PLAN_TOOL,
    description: 'Submit the task-specific visual perception plan for the fresh VCC visual sources. This is an internal Proxy planner tool.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schema_version: { type: 'string', enum: [VISUAL_QUERY_PLAN_SCHEMA] },
        source_ids: {
          type: 'array', minItems: sourceIds.length, maxItems: sourceIds.length, uniqueItems: true,
          items: { type: 'string', enum: sourceIds },
        },
        objective: { type: 'string', minLength: 1, maxLength: 1500 },
        questions: {
          type: 'array', minItems: 1, maxItems: 8,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 64 },
              question: { type: 'string', minLength: 1, maxLength: 1000 },
            },
            required: ['id', 'question'],
          },
        },
        requested_evidence: {
          type: 'array', maxItems: 16,
          items: { type: 'string', minLength: 1, maxLength: 128 },
        },
        detail_level: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
      required: ['schema_version', 'source_ids', 'objective', 'questions', 'requested_evidence', 'detail_level'],
    },
  };
}

export function buildVisualQueryPlannerRequest(request, { sourceIds = [] } = {}) {
  const ids = [...new Set(sourceIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (ids.length < 1) throw new HttpError(500, 'Visual planner requires at least one source.', { code:'visual_query_planner_sources_missing' });
  const clone = structuredClone(request || {});
  clone.stream = false;
  clone.system = appendSystem(clone.system, PLANNER_INSTRUCTION);
  clone.tools = [visualPlanTool(ids)];
  clone.tool_choice = { type: 'tool', name: VISUAL_QUERY_PLAN_TOOL };
  clone.max_tokens = Math.min(Math.max(Number(clone.max_tokens) || 1024, 512), 2048);
  const messages = Array.isArray(clone.messages) ? clone.messages : [];
  messages.push({ role:'user', content:[{ type:'text', text:plannerRequestText(ids) }] });
  clone.messages = messages;
  return clone;
}

export function buildVisualQueryPlannerFallbackRequest(request, { sourceIds = [], primaryResponse = null } = {}) {
  const ids = [...new Set(sourceIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (ids.length < 1) throw new HttpError(500, 'Visual planner fallback requires at least one source.', { code:'visual_query_planner_sources_missing' });
  const clone = structuredClone(request || {});
  clone.stream = false;
  clone.system = appendSystem(clone.system, PLANNER_FALLBACK_INSTRUCTION);
  clone.tools = [];
  delete clone.tool_choice;
  clone.max_tokens = Math.min(Math.max(Number(clone.max_tokens) || 768, 256), 1024);
  const messages = Array.isArray(clone.messages) ? clone.messages : [];
  const prior = extractPlannerResponseText(primaryResponse);
  messages.push({ role:'user', content:[{ type:'text', text:[
    '[VCC_PROXY_VISUAL_PLANNER_FALLBACK_REQUEST]',
    `source_ids: ${JSON.stringify(ids)}`,
    ...(prior ? ['Previous planner response:', prior.slice(0, 6000)] : []),
    'Return exactly one visual-query-plan-v1 JSON object. No markdown and no prose.',
  ].join('\n') }] });
  clone.messages = messages;
  return clone;
}

function extractPlannerResponseText(response) {
  return (Array.isArray(response?.content) ? response.content : [])
    .map((block) => {
      if (block?.type === 'text') return String(block.text || '');
      if (block?.type === 'thinking') return String(block.thinking || '');
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractText(response) {
  return extractPlannerResponseText(response);
}

function parseJsonObject(text) {
  const stripped = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(stripped); } catch {}
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(stripped.slice(first, last + 1)); } catch {}
  }
  throw new HttpError(502, 'Visual planner returned invalid JSON.', { code:'visual_query_planner_invalid_json', retryable:true });
}

function sameSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.every((value, index) => value === b[index]);
}

export function parseVisualQueryPlan(response, expectedSourceIds = []) {
  const expected = [...new Set(expectedSourceIds.map((id) => String(id || '').trim()).filter(Boolean))];
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const toolBlocks = blocks.filter((block) => block?.type === 'tool_use' && block?.name === VISUAL_QUERY_PLAN_TOOL);
  if (toolBlocks.length > 1) {
    throw new HttpError(502, 'Visual planner returned multiple plan tool calls.', { code:'visual_query_planner_multiple_tool_calls', retryable:true });
  }
  if (toolBlocks.length !== 1) {
    throw new HttpError(502, 'Visual planner did not call submit_visual_plan.', { code:'visual_query_planner_tool_missing', retryable:true });
  }
  const value = structuredClone(toolBlocks[0].input || {});
  if (value?.schema_version !== VISUAL_QUERY_PLAN_SCHEMA) {
    throw new HttpError(502, 'Visual planner schema_version is invalid.', { code:'visual_query_planner_schema_invalid', retryable:true });
  }
  const sourceIds = Array.isArray(value.source_ids) ? value.source_ids.map((id)=>String(id||'').trim()).filter(Boolean) : [];
  if (!sameSet(sourceIds, expected)) {
    throw new HttpError(502, 'Visual planner source_ids do not match fresh visual sources.', { code:'visual_query_planner_sources_invalid', retryable:true });
  }
  const objective = String(value.objective || '').trim();
  if (!objective || objective.length > 1500) {
    throw new HttpError(502, 'Visual planner objective is invalid.', { code:'visual_query_planner_objective_invalid', retryable:true });
  }
  if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 8) {
    throw new HttpError(502, 'Visual planner questions are invalid.', { code:'visual_query_planner_questions_invalid', retryable:true });
  }
  const seen = new Set();
  const questions = value.questions.map((item, index) => {
    const id = String(item?.id || '').trim();
    const question = String(item?.question || '').trim();
    if (!id || id.length > 64 || !question || question.length > 1000 || seen.has(id)) {
      throw new HttpError(502, `Visual planner question ${index} is invalid.`, { code:'visual_query_planner_question_invalid', retryable:true });
    }
    seen.add(id);
    return { id, question };
  });
  const detailLevel = ['low','normal','high'].includes(value.detail_level) ? value.detail_level : 'normal';
  const requestedEvidence = Array.isArray(value.requested_evidence)
    ? value.requested_evidence.map((item)=>String(item||'').trim()).filter(Boolean).slice(0,16)
    : [];
  return {
    schema_version: VISUAL_QUERY_PLAN_SCHEMA,
    source_ids: sourceIds,
    objective,
    questions,
    requested_evidence: requestedEvidence,
    detail_level: detailLevel,
  };
}

export function parseVisualQueryPlanFallback(response, expectedSourceIds = []) {
  const value = parseJsonObject(extractPlannerResponseText(response));
  return parseVisualQueryPlan({
    content:[{ type:'tool_use', id:'vcc-planner-fallback', name:VISUAL_QUERY_PLAN_TOOL, input:value }],
  }, expectedSourceIds);
}

export function unavailableVisualPerception(plan, { code='visual_query_planner_failed', detail='Visual planning was unavailable.' } = {}) {
  return {
    schema_version:'visual-perception-v1',
    status:'unavailable',
    answers:[],
    source_results:(plan?.source_ids || []).map((sourceId)=>({
      source_id:sourceId,
      evidence:[], relationships:[],
      unresolved:(plan?.questions || []).map((question)=>({ question_id:question.id, reason_code:code, detail, retryable:true })),
    })),
    needs_followup:false,
  };
}

export function createSyntheticVisualExchange(plan, perceptionResult, { toolUseId = 'vcc-auto-visual-1' } = {}) {
  const input = {
    source_ids:[...(plan?.source_ids || [])],
    objective:String(plan?.objective || ''),
    questions:structuredClone(plan?.questions || []),
    requested_evidence:structuredClone(plan?.requested_evidence || []),
    detail_level:plan?.detail_level || 'normal',
  };
  return [
    { role:'assistant', content:[{ type:'tool_use', id:toolUseId, name:'proxy_visual_query', input }] },
    { role:'user', content:[{ type:'tool_result', tool_use_id:toolUseId, content:JSON.stringify(perceptionResult) }] },
  ];
}
