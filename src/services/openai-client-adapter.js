// Reverse bridge ONLY for an OpenAI client routed to an Anthropic backend.
// Native OpenAI traffic must not pass through this conversion.
import { HttpError } from '../lib/http.js';
import { isObject, invalidUpstream, parseUpstreamJson, readSseFrames, sseData } from './chat-stream.js';

function bad(param, message = `Parameter ${param} is not supported by the Anthropic bridge.`) {
  return new HttpError(400, message, { code: 'unsupported_parameter', details: { param } });
}
function onlyKeys(value, allowed, path) {
  if (!isObject(value)) throw bad(path, `${path} must be an object.`);
  for (const [name, entry] of Object.entries(value)) if (!allowed.includes(name) && entry != null) throw bad(`${path}.${name}`);
}
function textContent(value, path, allowNull = false) {
  if (allowNull && value == null) return '';
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw bad(path, `${path} must contain text.`);
  return value.map((part, i) => {
    onlyKeys(part, ['type', 'text'], `${path}[${i}]`);
    if (part.type !== 'text' || typeof part.text !== 'string') throw bad(`${path}[${i}]`);
    return part.text;
  }).join('');
}
function userContent(value, path) {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) throw bad(path);
  return value.map((part, index) => {
    const at = `${path}[${index}]`;
    if (part?.type === 'text') { onlyKeys(part, ['type', 'text'], at); if (typeof part.text !== 'string') throw bad(at); return { type: 'text', text: part.text }; }
    if (part?.type !== 'image_url') throw bad(at);
    onlyKeys(part, ['type', 'image_url'], at); onlyKeys(part.image_url, ['url', 'detail'], `${at}.image_url`);
    if (part.image_url.detail != null && part.image_url.detail !== 'auto') throw bad(`${at}.image_url.detail`);
    const url = part.image_url.url;
    if (typeof url !== 'string') throw bad(`${at}.image_url.url`);
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (match) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
    let uri; try { uri = new URL(url); } catch { throw bad(`${at}.image_url.url`); }
    if (!['https:', 'http:'].includes(uri.protocol) || uri.username || uri.password) throw bad(`${at}.image_url.url`);
    return { type: 'image', source: { type: 'url', url } };
  });
}

export function toAnthropicRequest(input, upstreamModel) {
  const allowed = ['model', 'messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning_effort', 'n', 'logprobs', 'response_format'];
  onlyKeys(input, allowed, 'request');
  if (input.n != null && input.n !== 1) throw bad('n');
  if (input.logprobs != null && input.logprobs !== false) throw bad('logprobs');
  if (input.response_format != null && (input.response_format.type !== 'text' || Object.keys(input.response_format).some(k => k !== 'type'))) throw bad('response_format');
  if (input.stream_options != null) {
    onlyKeys(input.stream_options, ['include_usage'], 'stream_options');
    if (input.stream !== true || (input.stream_options.include_usage != null && typeof input.stream_options.include_usage !== 'boolean')) throw bad('stream_options');
  }
  const maxTokens = input.max_completion_tokens ?? input.max_tokens ?? 4096;
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw bad('max_tokens', 'max_tokens must be a positive integer.');
  if (input.max_tokens != null && input.max_completion_tokens != null && input.max_tokens !== input.max_completion_tokens) throw bad('max_completion_tokens', 'Conflicting token limits.');
  const out = { model: upstreamModel, messages: [], max_tokens: maxTokens, stream: input.stream === true };
  for (const key of ['temperature', 'top_p']) if (input[key] != null) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > 1) throw bad(key, `${key} must be between 0 and 1 for the Anthropic backend.`);
    out[key] = input[key];
  }
  if (input.stop != null) {
    const stops = typeof input.stop === 'string' ? [input.stop] : input.stop;
    if (!Array.isArray(stops) || !stops.every(x => typeof x === 'string')) throw bad('stop');
    out.stop_sequences = stops;
  }
  const system = [], pending = new Set(), usedIds = new Set(); let conversationStarted = false;
  for (const [index, msg] of input.messages.entries()) {
    const at = `messages[${index}]`;
    onlyKeys(msg, ['role', 'content', 'tool_calls', 'tool_call_id'], at);
    if (['system', 'developer'].includes(msg.role)) {
      if (conversationStarted || msg.tool_calls != null || msg.tool_call_id != null) throw bad(at, 'System/developer messages must precede conversation messages in the Anthropic bridge.');
      system.push(textContent(msg.content, `${at}.content`)); continue;
    }
    conversationStarted = true;
    if (msg.role === 'tool') {
      if (msg.tool_calls != null || typeof msg.tool_call_id !== 'string' || !pending.delete(msg.tool_call_id)) throw bad(`${at}.tool_call_id`, 'Tool result must match a pending tool call exactly once.');
      const block = { type: 'tool_result', tool_use_id: msg.tool_call_id, content: textContent(msg.content, `${at}.content`) };
      const last = out.messages.at(-1);
      if (last?.role === 'user' && last.content.every(x => x.type === 'tool_result')) last.content.push(block);
      else out.messages.push({ role: 'user', content: [block] });
      continue;
    }
    if (pending.size) throw bad(at, 'All pending tool calls require results before the next conversation message.');
    if (msg.tool_call_id != null) throw bad(`${at}.tool_call_id`);
    if (msg.role === 'user') {
      if (msg.tool_calls != null) throw bad(`${at}.tool_calls`);
      out.messages.push({ role: 'user', content: userContent(msg.content, `${at}.content`) });
    } else if (msg.role === 'assistant') {
      const text = textContent(msg.content, `${at}.content`, true), content = text ? [{ type: 'text', text }] : [];
      if (msg.tool_calls != null && !Array.isArray(msg.tool_calls)) throw bad(`${at}.tool_calls`);
      for (const call of msg.tool_calls || []) {
        onlyKeys(call, ['id', 'type', 'function'], `${at}.tool_calls`); onlyKeys(call.function, ['name', 'arguments'], `${at}.tool_calls.function`);
        if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || usedIds.has(call.id) || typeof call.function.name !== 'string' || !call.function.name || typeof call.function.arguments !== 'string') throw bad(`${at}.tool_calls`);
        let args; try { args = JSON.parse(call.function.arguments); } catch { throw bad(`${at}.tool_calls`, 'Tool call arguments must be valid JSON.'); }
        if (!isObject(args)) throw bad(`${at}.tool_calls`, 'Tool call arguments must be a JSON object.');
        usedIds.add(call.id); pending.add(call.id);
        content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: args });
      }
      if (!content.length) throw bad(at, 'Assistant message must contain text or tool calls.');
      out.messages.push({ role: 'assistant', content });
    } else throw bad(`${at}.role`, 'Unsupported message role for the Anthropic bridge.');
  }
  if (pending.size) throw bad('messages', 'Missing results for pending tool calls.');
  if (!out.messages.length) throw bad('messages', 'A conversation message is required.');
  if (system.length) out.system = system.join('\n\n');
  if (input.tools != null) {
    if (!Array.isArray(input.tools)) throw bad('tools');
    const names = new Set();
    out.tools = input.tools.map((tool, i) => {
      const at = `tools[${i}]`; onlyKeys(tool, ['type', 'function'], at); onlyKeys(tool.function, ['name', 'description', 'parameters', 'strict'], `${at}.function`);
      const fn = tool.function;
      if (tool.type !== 'function' || typeof fn.name !== 'string' || !fn.name || names.has(fn.name) || fn.strict === true) throw bad(at);
      if (fn.strict != null && typeof fn.strict !== 'boolean') throw bad(`${at}.function.strict`);
      if (fn.description != null && typeof fn.description !== 'string') throw bad(`${at}.function.description`);
      if (fn.parameters != null && !isObject(fn.parameters)) throw bad(`${at}.function.parameters`);
      names.add(fn.name);
      return { name: fn.name, ...(fn.description == null ? {} : { description: fn.description }), input_schema: fn.parameters ?? { type: 'object', properties: {} } };
    });
  }
  if (input.parallel_tool_calls != null && typeof input.parallel_tool_calls !== 'boolean') throw bad('parallel_tool_calls');
  const choice = input.tool_choice ?? 'auto';
  if (out.tools?.length) {
    if (['auto', 'none', 'required'].includes(choice)) out.tool_choice = { type: choice === 'required' ? 'any' : choice };
    else {
      onlyKeys(choice, ['type', 'function'], 'tool_choice'); onlyKeys(choice.function, ['name'], 'tool_choice.function');
      if (choice.type !== 'function' || !out.tools.some(t => t.name === choice.function.name)) throw bad('tool_choice');
      out.tool_choice = { type: 'tool', name: choice.function.name };
    }
    if (input.parallel_tool_calls != null) out.tool_choice.disable_parallel_tool_use = !input.parallel_tool_calls;
  } else if (!['auto', 'none'].includes(choice) || input.parallel_tool_calls != null) throw bad('tool_choice', 'Tool options require declared function tools.');
  if (input.reasoning_effort != null) {
    if (input.reasoning_effort === 'none') out.thinking = { type: 'disabled' };
    else if (['low', 'medium', 'high', 'xhigh', 'max'].includes(input.reasoning_effort)) {
      out.thinking = { type: 'adaptive' }; out.output_config = { effort: input.reasoning_effort };
    } else throw bad('reasoning_effort');
  }
  return out;
}

export function chatUsage(usage) {
  if (!isObject(usage) || usage.input_tokens == null || usage.output_tokens == null) return undefined;
  const count = key => { const value = usage[key] ?? 0; if (!Number.isSafeInteger(value) || value < 0) throw invalidUpstream('Invalid upstream token usage.'); return value; };
  const read = count('cache_read_input_tokens'), written = count('cache_creation_input_tokens');
  const prompt = count('input_tokens') + read + written, completion = count('output_tokens');
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
    ...(usage.cache_read_input_tokens == null ? {} : { prompt_tokens_details: { cached_tokens: read } }) };
}
function finishReason(reason) {
  const map = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length', refusal: 'content_filter' };
  if (!Object.hasOwn(map, reason)) throw invalidUpstream('Unsupported or missing Anthropic stop reason.');
  return map[reason];
}
function toolCall(block) {
  if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name || !isObject(block.input)) throw invalidUpstream('Invalid Anthropic tool call.');
  return { id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } };
}
export function fromAnthropicResponse(payload, clientModel, created = Math.floor(Date.now() / 1000)) {
  if (!isObject(payload) || payload.type !== 'message' || typeof payload.id !== 'string' || !payload.id || !Array.isArray(payload.content)) throw invalidUpstream('Invalid Anthropic completion response.');
  let text = '', reasoning = ''; const tools = [], ids = new Set();
  for (const block of payload.content) {
    if (block.type === 'text' && typeof block.text === 'string' && !block.citations?.length) text += block.text;
    else if (block.type === 'thinking' && typeof block.thinking === 'string') reasoning += block.thinking;
    else if (block.type === 'tool_use') {
      const call = toolCall(block); if (ids.has(call.id)) throw invalidUpstream('Duplicate upstream tool call ID.'); ids.add(call.id); tools.push(call);
    } else throw invalidUpstream('Unsupported Anthropic response content block.');
  }
  const finish = finishReason(payload.stop_reason);
  // Partial tool output at a token limit is not an executable tool call.
  if (tools.length && finish !== 'tool_calls') throw invalidUpstream('Anthropic tool call did not finish successfully.');
  if (finish === 'tool_calls' && !tools.length) throw invalidUpstream('Missing Anthropic tool call.');
  const usage = chatUsage(payload.usage);
  return { id: payload.id, object: 'chat.completion', created, model: clientModel,
    choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: finish }],
    ...(usage ? { usage } : {}) };
}

// Text/reasoning are incremental. Tools stay transactional until message_stop,
// so aborted streams cannot commit a partial or unvalidated tool invocation.
export async function* fromAnthropicStream(body, clientModel, { includeUsage = false, limitBytes } = {}) {
  let start = null, usage = {}, reason = null, finalDelta = false, outputBytes = 0;
  const blocks = new Map(), tools = [], ids = new Set();
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null) => ({ id: start.id, object: 'chat.completion.chunk', created, model: clientModel,
    choices: [{ index: 0, delta, finish_reason: finish }], ...(includeUsage ? { usage: null } : {}) });
  const account = value => { outputBytes += Buffer.byteLength(value); if (outputBytes > limitBytes) throw invalidUpstream('Anthropic response exceeds the configured resource limit.'); };
  for await (const frame of readSseFrames(body, limitBytes)) {
    if (!frame.hasData || frame.data === '') { yield ': ping\n\n'; continue; }
    const p = parseUpstreamJson(frame.data), type = p.type || frame.event;
    if (frame.event && frame.event !== type) throw invalidUpstream('Anthropic SSE event type mismatch.');
    if (type === 'ping') { yield ': ping\n\n'; continue; }
    if (type === 'error') throw new HttpError(502, 'Anthropic upstream reported a streaming error.', { code: 'upstream_stream_error' });
    if (type === 'message_start') {
      if (start || !isObject(p.message) || typeof p.message.id !== 'string' || !p.message.id || !Array.isArray(p.message.content) || p.message.content.length) throw invalidUpstream('Invalid Anthropic message_start.');
      start = p.message; usage = { ...(start.usage || {}) }; yield sseData(chunk({ role: 'assistant', content: '' })); continue;
    }
    if (!start) throw invalidUpstream('Anthropic stream did not start with message_start.');
    if (type === 'content_block_start') {
      if (finalDelta || !Number.isInteger(p.index) || p.index < 0 || blocks.has(p.index) || [...blocks.values()].some(b => !b.closed)) throw invalidUpstream('Invalid Anthropic block start.');
      const block = { ...p.content_block, json: '', closed: false };
      if (!['text', 'thinking', 'tool_use'].includes(block.type)) throw invalidUpstream('Unsupported Anthropic streaming content.');
      if (block.citations?.length) throw invalidUpstream('Anthropic citations cannot be mapped to Chat Completions.');
      if ((block.type === 'text' && typeof block.text !== 'string')
          || (block.type === 'thinking' && typeof block.thinking !== 'string')) throw invalidUpstream('Invalid Anthropic content block text.');
      if (block.type === 'tool_use' && (!block.id || !block.name || !isObject(block.input) || ids.has(block.id))) throw invalidUpstream('Invalid Anthropic streaming tool call.');
      blocks.set(p.index, block);
      if (block.type === 'text' && block.text) { account(block.text); yield sseData(chunk({ content: block.text })); }
      if (block.type === 'thinking' && block.thinking) { account(block.thinking); yield sseData(chunk({ reasoning_content: block.thinking })); }
      continue;
    }
    if (type === 'content_block_delta' || type === 'content_block_stop') {
      const block = blocks.get(p.index);
      if (finalDelta || !block || block.closed) throw invalidUpstream('Anthropic SSE references an invalid content block.');
      if (type === 'content_block_stop') {
        block.closed = true;
        if (block.type === 'tool_use') {
          let input = block.input;
          if (block.json) { try { input = JSON.parse(block.json); } catch { throw invalidUpstream('Anthropic stream returned invalid tool JSON.'); } }
          const call = toolCall({ ...block, input }); ids.add(call.id); tools.push({ index: tools.length, ...call });
        }
        continue;
      }
      const d = p.delta;
      if (block.type === 'text' && d?.type === 'text_delta' && typeof d.text === 'string') { account(d.text); yield sseData(chunk({ content: d.text })); }
      else if (block.type === 'thinking' && d?.type === 'thinking_delta' && typeof d.thinking === 'string') { account(d.thinking); yield sseData(chunk({ reasoning_content: d.thinking })); }
      else if (block.type === 'thinking' && d?.type === 'signature_delta') { /* Signature is Anthropic-specific, never fabricated for OpenAI. */ }
      else if (block.type === 'tool_use' && d?.type === 'input_json_delta' && typeof d.partial_json === 'string') { account(d.partial_json); block.json += d.partial_json; }
      else throw invalidUpstream('Unsupported Anthropic content delta.');
      continue;
    }
    if (type === 'message_delta') {
      if ([...blocks.values()].some(b => !b.closed)) throw invalidUpstream('Anthropic message ended before its content blocks.');
      if (p.delta?.stop_reason != null) { reason = finishReason(p.delta.stop_reason); finalDelta = true; }
      if (p.usage) usage = { ...usage, ...p.usage };
      continue;
    }
    if (type === 'message_stop') {
      if (!finalDelta || !reason || [...blocks.values()].some(b => !b.closed)) throw invalidUpstream('Incomplete Anthropic stream.');
      if ((tools.length > 0) !== (reason === 'tool_calls')) throw invalidUpstream('Anthropic tool completion did not match its stop reason.');
      const finalUsage = chatUsage(usage); // Validate before emitting executable tools.
      if (tools.length) yield sseData(chunk({ tool_calls: tools }));
      yield sseData(chunk({}, reason));
      if (includeUsage) yield sseData({ id: start.id, object: 'chat.completion.chunk', created, model: clientModel, choices: [], usage: finalUsage ?? null });
      yield sseData('[DONE]'); return;
    }
    throw invalidUpstream('Unsupported Anthropic SSE event.');
  }
  throw invalidUpstream('Anthropic stream closed without message_stop.');
}
