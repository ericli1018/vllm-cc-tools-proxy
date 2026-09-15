import { HttpError } from '../lib/http.js';

export const VISUAL_QUERY_PLANNER_MARKER = 'VCC_PROXY_VISUAL_PLANNER_V1';
export const VISUAL_QUERY_PLAN_SCHEMA = 'visual-query-plan-v1';

const PLANNER_INSTRUCTION = `[${VISUAL_QUERY_PLANNER_MARKER}]
You are the Proxy's internal visual perception planner.
A fresh image source has been detected for the current task, but you do not receive image pixels.
Decide only WHAT observable facts should be inspected in the listed VCC_VISUAL_SOURCE handles.
Do not answer the user's final task. Do not claim to see image content. Do not call tools.
Return exactly one JSON object and no prose using schema_version="${VISUAL_QUERY_PLAN_SCHEMA}" with:
- source_ids: the supplied source ids
- objective: concise task-relevant visual objective
- questions: 1..8 objects {id, question}
- requested_evidence: optional short evidence categories
- detail_level: low|normal|high
Questions must ask for observable visual facts, not final-task reasoning.`;

function appendSystem(system, text) {
  if (typeof system === 'string') return system ? `${system}\n\n${text}` : text;
  if (Array.isArray(system)) return [...structuredClone(system), { type:'text', text }];
  return text;
}

function plannerRequestText(sourceIds) {
  return [
    '[VCC_PROXY_VISUAL_PLANNER_REQUEST]',
    `Fresh source_ids: ${JSON.stringify(sourceIds)}`,
    'Use the existing user request, conversation, recent tool calls, filenames, and source metadata to decide what the Vision sensor should inspect.',
    'Return JSON only.',
  ].join('\n');
}

export function buildVisualQueryPlannerRequest(request, { sourceIds = [] } = {}) {
  const ids = [...new Set(sourceIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (ids.length < 1) throw new HttpError(500, 'Visual planner requires at least one source.', { code:'visual_query_planner_sources_missing' });
  const clone = structuredClone(request || {});
  clone.stream = false;
  clone.system = appendSystem(clone.system, PLANNER_INSTRUCTION);
  clone.tools = [];
  delete clone.tool_choice;
  clone.max_tokens = Math.min(Math.max(Number(clone.max_tokens) || 2048, 512), 4096);
  const messages = Array.isArray(clone.messages) ? clone.messages : [];
  messages.push({ role:'user', content:[{ type:'text', text:plannerRequestText(ids) }] });
  clone.messages = messages;
  return clone;
}

function extractText(response) {
  return (Array.isArray(response?.content) ? response.content : [])
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text || ''))
    .join('\n')
    .trim();
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
  const value = parseJsonObject(extractText(response));
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
