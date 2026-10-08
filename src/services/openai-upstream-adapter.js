// Base-model protocol boundary: Anthropic Messages <-> OpenAI Chat Completions.
// Deliberately does not modify the public Claude Code /v1/messages contract.
import { HttpError } from '../lib/http.js';

const textOf = (v) => typeof v === 'string' ? v : Array.isArray(v) ? v.filter(x => x?.type === 'text').map(x => x.text || '').join('\n') : '';

export function toOpenAIRequest(request) {
  const messages = [];
  if (request.system) messages.push({ role: 'system', content: textOf(request.system) });
  for (const msg of request.messages || []) {
    const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content || []);
    if (!Array.isArray(blocks)) throw new HttpError(400, 'Unsupported Anthropic message content.', { code: 'unsupported_content' });
    if (msg.role === 'assistant') {
      const tools = blocks.filter(x => x.type === 'tool_use');
      const text = blocks.filter(x => x.type === 'text').map(x => x.text || '').join('\n');
      const output = { role: 'assistant', content: text || null };
      if (tools.length) output.tool_calls = tools.map(x => ({ id: x.id, type: 'function', function: { name: x.name, arguments: JSON.stringify(x.input || {}) } }));
      messages.push(output);
    } else if (msg.role === 'user') {
      const pending = [];
      const flush = () => { if (pending.length) messages.push({ role: 'user', content: pending.splice(0) }); };
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          flush();
          messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: textOf(block.content) });
        } else if (block.type === 'text') pending.push({ type: 'text', text: block.text || '' });
        else if (block.type === 'image') {
          const source = block.source || {};
          if (source.type !== 'base64') throw new HttpError(400, 'OpenAI upstream requires base64 image sources.', { code: 'unsupported_content' });
          pending.push({ type: 'image_url', image_url: { url: `data:${source.media_type || 'image/png'};base64,${source.data}` } });
        } else throw new HttpError(400, `Unsupported Anthropic content block: ${block.type}`, { code: 'unsupported_content' });
      }
      flush();
    } else throw new HttpError(400, `Unsupported message role: ${msg.role}`, { code: 'unsupported_role' });
  }
  const out = { model: request.model, messages, stream: Boolean(request.stream) };
  if (request.max_tokens != null) out.max_tokens = request.max_tokens;
  if (request.temperature != null) out.temperature = request.temperature;
  if (request.top_p != null) out.top_p = request.top_p;
  if (request.stop_sequences?.length) out.stop = request.stop_sequences;
  if (Array.isArray(request.tools) && request.tools.length) {
    out.tools = request.tools.filter(x => !x.type || x.type === 'custom').map(x => ({ type: 'function', function: { name: x.name, description: x.description || '', parameters: x.input_schema || { type: 'object', properties: {} } } }));
    if (out.tools.length !== request.tools.length) throw new HttpError(400, 'OpenAI backend cannot natively execute Anthropic server tools.', { code: 'unsupported_server_tool' });
  }
  if (request.tool_choice) {
    const choice = request.tool_choice;
    out.tool_choice = choice.type === 'tool' ? { type: 'function', function: { name: choice.name } } : choice.type === 'any' ? 'required' : choice.type === 'none' ? 'none' : 'auto';
  }
  return out;
}

function parsedArgs(value, toolName = '') {
  try {
    const result = JSON.parse(value || '{}');
    if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new SyntaxError('Tool input must be an object');
    return result;
  } catch {
    throw new HttpError(502, 'OpenAI backend returned malformed tool arguments.', {
      code: 'vllm_invalid_tool_json', retryable: true,
      details: { tool_name: String(toolName).slice(0, 128), partial_json_bytes: Buffer.byteLength(value || '') },
    });
  }
}
const stopping = (reason, hasTools) => hasTools || reason === 'tool_calls' ? 'tool_use' : reason === 'length' ? 'max_tokens' : 'end_turn';
export function toAnthropicMessage(payload, model = '') {
  const choice = payload.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  const body = typeof msg.content === 'string' ? msg.content : textOf(msg.content);
  if (body) content.push({ type: 'text', text: body });
  for (const call of msg.tool_calls || []) content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input: parsedArgs(call.function?.arguments, call.function?.name) });
  return { id: payload.id || `msg_${Date.now()}`, type: 'message', role: 'assistant', model: payload.model || model, content, stop_reason: stopping(choice.finish_reason, Boolean(msg.tool_calls?.length)), stop_sequence: null, usage: { input_tokens: payload.usage?.prompt_tokens || 0, output_tokens: payload.usage?.completion_tokens || 0 } };
}
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
function createMessageStream(payload, model) {
  const msg = toAnthropicMessage(payload, model);
  const data = [event('message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null } })];
  msg.content.forEach((block, index) => {
    const base = block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} };
    data.push(event('content_block_start', { type: 'content_block_start', index, content_block: base }));
    if (block.type === 'text') data.push(event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }));
    else data.push(event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }));
    data.push(event('content_block_stop', { type: 'content_block_stop', index }));
  });
  data.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: msg.usage.output_tokens } }));
  data.push(event('message_stop', { type: 'message_stop' }));
  return data.join('');
}

// Incremental OpenAI -> Anthropic SSE translation. No complete-response buffering.
// Tool arguments are forwarded as deltas, then validated on tool close. A malformed
// partial call fails the stream rather than fabricating a successful tool request.
async function* translateOpenAIStream(source, model) {
  const decoder = new TextDecoder();
  let pending = '', started = false, textOpen = false, nextIndex = 0;
  let finishReason = null, completed = false, usage = null;
  const tools = new Map();
  let textIndex = -1;
  const emit = (name, payload) => Buffer.from(event(name, payload));
  const start = (id, modelName) => emit('message_start', { type: 'message_start', message: {
    id: id || `msg_${Date.now()}`, type: 'message', role: 'assistant', model: modelName || model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
  } });
  async function* handle(frame) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { completed = true; return; }
    let item;
    try { item = JSON.parse(data); } catch { throw new HttpError(502, 'Malformed OpenAI SSE JSON.', { code: 'vllm_invalid_stream', retryable: true }); }
    if (!started) { started = true; yield start(item.id, item.model); }
    if (item.usage) usage = item.usage;
    const choice = item.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      if (!textOpen) {
        textOpen = true; textIndex = nextIndex++;
        yield emit('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
      }
      yield emit('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } });
    }
    for (const tc of delta.tool_calls || []) {
      const key = tc.index ?? 0;
      let tool = tools.get(key);
      if (!tool) {
        if (textOpen) { yield emit('content_block_stop', { type: 'content_block_stop', index: textIndex }); textOpen = false; }
        tool = { index: nextIndex++, id: '', name: '', arguments: '', opened: false };
        tools.set(key, tool);
      }
      if (tc.id) tool.id = tc.id;
      if (tc.function?.name) tool.name += tc.function.name;
      if (!tool.opened && tool.id && tool.name) {
        tool.opened = true;
        yield emit('content_block_start', { type: 'content_block_start', index: tool.index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
      }
      if (tc.function?.arguments) {
        tool.arguments += tc.function.arguments;
        if (!tool.opened) throw new HttpError(502, 'OpenAI tool arguments arrived before tool identity.', { code: 'vllm_invalid_stream', retryable: true });
        yield emit('content_block_delta', { type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
      }
    }
  }
  for await (const chunk of source) {
    pending += decoder.decode(chunk, { stream: true });
    const frames = pending.split(/\r?\n\r?\n/);
    pending = frames.pop();
    for (const frame of frames) yield* handle(frame);
  }
  pending += decoder.decode();
  if (pending.trim()) yield* handle(pending);
  // Never close a streamed tool_use without an explicit upstream terminator.
  // finish_reason alone can arrive just before a broken transport; emitting a
  // successful tool block here would expose an uncommitted operation to CC.
  if (!completed || !finishReason) {
    const unfinished = [...tools.values()].find(tool => tool.opened || tool.arguments);
    if (unfinished) throw new HttpError(502, 'OpenAI SSE interrupted during tool call.', {
      code: 'vllm_invalid_tool_json', retryable: true,
      details: { tool_name: String(unfinished.name).slice(0, 128), partial_json_bytes: Buffer.byteLength(unfinished.arguments) },
    });
    throw new HttpError(502, 'OpenAI SSE ended without confirmed completion.', { code: 'vllm_invalid_stream', retryable: true });
  }
  if (!started) throw new HttpError(502, 'OpenAI SSE contained no completion.', { code: 'vllm_invalid_stream', retryable: true });
  if (textOpen) yield emit('content_block_stop', { type: 'content_block_stop', index: textIndex });
  for (const tool of tools.values()) {
    if (!tool.opened) throw new HttpError(502, 'OpenAI tool call missing identity.', { code: 'vllm_invalid_stream', retryable: true });
    parsedArgs(tool.arguments, tool.name);
    yield emit('content_block_stop', { type: 'content_block_stop', index: tool.index });
  }
  yield emit('message_delta', { type: 'message_delta', delta: { stop_reason: stopping(finishReason, tools.size > 0), stop_sequence: null }, usage: { output_tokens: usage?.completion_tokens ?? 0, ...(usage?.prompt_tokens != null ? { input_tokens: usage.prompt_tokens } : {}) } });
  yield emit('message_stop', { type: 'message_stop' });
}

export async function adaptOpenAIResponse(response, request) {
  if (!response.ok) return response;
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (request.stream && contentType.includes('text/event-stream')) {
    const body = { [Symbol.asyncIterator]: () => translateOpenAIStream(response.body, request.model) };
    return { status: response.status, ok: true,
      headers: { get: name => name.toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null },
      body, text: async () => { let result = ''; for await (const bytes of body) result += Buffer.from(bytes).toString('utf8'); return result; },
    };
  }
  let payload;
  try { payload = JSON.parse(await response.text()); } catch { throw new HttpError(502, 'Invalid OpenAI upstream JSON.', { code: 'vllm_invalid_response', retryable: true }); }
  const translated = request.stream ? createMessageStream(payload, request.model) : JSON.stringify(toAnthropicMessage(payload, request.model));
  const bytes = Buffer.from(translated);
  return { status: response.status, ok: true, headers: { get: name => name.toLowerCase() === 'content-type' ? (request.stream ? 'text/event-stream; charset=utf-8' : 'application/json') : null },
    body: { async *[Symbol.asyncIterator]() { yield bytes; } }, text: async () => translated };
}

export function approximateTokenCount(request) {
  // No portable token-count endpoint exists in OpenAI Chat Completions.
  // Deliberately return zero rather than misreport an inaccurate token count.
  return { input_tokens: 0 };
}
