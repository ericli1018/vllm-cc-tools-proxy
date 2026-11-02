// Shared bounded SSE framing for the public Chat Completions boundary.
import { HttpError } from '../lib/http.js';

export const invalidUpstream = (message = 'Invalid upstream completion stream.') => new HttpError(502, message, { code: 'invalid_upstream_response' });
export const sseData = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseUpstreamJson(text) {
  try {
    const value = JSON.parse(text);
    if (!isObject(value)) throw new Error();
    return value;
  } catch { throw invalidUpstream('Upstream returned invalid JSON.'); }
}

export async function readUpstreamJson(body, limitBytes) {
  const parts = []; let size = 0;
  for await (const part of body) {
    const chunk = Buffer.from(part); size += chunk.length;
    if (size > limitBytes) throw invalidUpstream('Upstream JSON exceeds the configured resource limit.');
    parts.push(chunk);
  }
  return parseUpstreamJson(Buffer.concat(parts).toString('utf8'));
}

// Decode incrementally: neither UTF-8 characters nor CRLF boundaries have to
// align with HTTP chunks. Comments are preserved as transport liveness only.
export async function* readSseFrames(body, limitBytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', lines = [], frameBytes = 0;
  const build = () => {
    let event = '', data = [];
    for (const line of lines) {
      const colon = line.indexOf(':');
      const name = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (name === 'event') event = value;
      if (name === 'data') data.push(value);
    }
    const result = { event, data: data.join('\n'), raw: `${lines.join('\n')}\n\n`, hasData: data.length > 0 };
    lines = []; frameBytes = 0;
    return result;
  };
  const consume = function* (final = false) {
    let pos;
    while ((pos = buffer.search(/[\r\n]/)) >= 0) {
      if (!final && buffer[pos] === '\r' && pos === buffer.length - 1) break;
      const width = buffer[pos] === '\r' && buffer[pos + 1] === '\n' ? 2 : 1;
      const line = buffer.slice(0, pos); buffer = buffer.slice(pos + width);
      if (line === '') { if (lines.length) yield build(); }
      else {
        frameBytes += Buffer.byteLength(line) + 1;
        if (frameBytes > limitBytes) throw invalidUpstream('Upstream SSE frame exceeds the configured resource limit.');
        lines.push(line);
      }
    }
    if (frameBytes + Buffer.byteLength(buffer) > limitBytes) throw invalidUpstream('Upstream SSE frame exceeds the configured resource limit.');
  };
  for await (const chunk of body) {
    try { buffer += decoder.decode(chunk, { stream: true }); }
    catch { throw invalidUpstream('Upstream SSE contains invalid UTF-8.'); }
    yield* consume();
  }
  try { buffer += decoder.decode(); } catch { throw invalidUpstream('Upstream SSE contains incomplete UTF-8.'); }
  yield* consume(true);
  if (buffer.trim() || lines.some(line => !line.startsWith(':'))) throw invalidUpstream('Upstream ended inside an SSE frame.');
}

// Native OpenAI deltas retain vendor fields, n>1, usage, and tool fragments.
// A finish_reason is committed only after [DONE]; EOF is never success.
export async function* relayOpenAIStream(body, clientModel, { limitBytes, n = 1 } = {}) {
  const finishes = new Map(), tools = new Map();
  const deferred = []; let deferredBytes = 0, toolBytes = 0, sawChoice = false;
  const defer = payload => {
    deferredBytes += Buffer.byteLength(JSON.stringify(payload));
    if (deferredBytes > limitBytes) throw invalidUpstream('Upstream completion trailer exceeds the configured resource limit.');
    deferred.push(payload);
  };
  for await (const frame of readSseFrames(body, limitBytes)) {
    if (!frame.hasData || frame.data === '') { yield frame.raw; continue; }
    if (frame.data.trim() === '[DONE]') {
      if (!sawChoice || finishes.size !== n) throw invalidUpstream('OpenAI stream ended without all completion finish reasons.');
      for (const tool of tools.values()) {
        if (tool.type && tool.type !== 'function') continue; // Native custom-tool dialect remains native.
        if (!tool.id || !tool.name) throw invalidUpstream('OpenAI stream returned an incomplete tool call.');
        let args; try { args = JSON.parse(tool.arguments); } catch { throw invalidUpstream('OpenAI stream returned invalid tool arguments.'); }
        if (!isObject(args)) throw invalidUpstream('OpenAI tool arguments must be a JSON object.');
      }
      for (const payload of deferred) yield sseData(payload);
      yield sseData('[DONE]');
      return;
    }
    const payload = parseUpstreamJson(frame.data);
    if (payload.error) throw new HttpError(502, typeof payload.error.message === 'string'
      ? payload.error.message : 'OpenAI upstream reported a streaming error.', { code: 'upstream_stream_error' });
    if (!Array.isArray(payload.choices)) throw invalidUpstream('OpenAI SSE chunk has no choices array.');
    sawChoice ||= payload.choices.length > 0;
    const mapped = { ...payload, model: clientModel };
    let hasFinish = false;
    for (const choice of payload.choices) {
      if (!Number.isInteger(choice.index) || choice.index < 0 || choice.index >= n || finishes.has(choice.index)) throw invalidUpstream('OpenAI stream has an invalid or already finished choice.');
      for (const piece of choice.delta?.tool_calls || []) {
        if (!Number.isInteger(piece.index) || piece.index < 0) throw invalidUpstream('OpenAI stream has an invalid tool index.');
        const key = `${choice.index}:${piece.index}`;
        const tool = tools.get(key) || { id: '', name: '', arguments: '', type: '' };
        if (piece.id) tool.id = piece.id;
        if (piece.type) tool.type = piece.type;
        if (piece.function?.name) tool.name += piece.function.name;
        if (piece.function?.arguments) {
          tool.arguments += piece.function.arguments;
          toolBytes += Buffer.byteLength(piece.function.arguments);
          if (toolBytes > limitBytes) throw invalidUpstream('OpenAI tool arguments exceed the configured resource limit.');
        }
        tools.set(key, tool);
      }
      if (choice.finish_reason != null) { finishes.set(choice.index, choice.finish_reason); hasFinish = true; }
    }
    if (hasFinish) {
      // Forward any text/argument delta now, holding only its completion marker.
      const liveChoices = mapped.choices.filter(c => c.delta && Object.keys(c.delta).length)
        .map(c => ({ ...c, finish_reason: null }));
      if (liveChoices.length) yield sseData({ ...mapped, choices: liveChoices, ...(mapped.usage ? { usage: null } : {}) });
      defer({ ...mapped, choices: mapped.choices.filter(c => c.finish_reason != null).map(c => ({ ...c, delta: {} })) });
    } else if (finishes.size && !mapped.choices.length) defer(mapped);
    else yield sseData(mapped);
  }
  throw invalidUpstream('OpenAI stream closed without [DONE].');
}
