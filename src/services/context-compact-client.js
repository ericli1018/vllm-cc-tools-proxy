const MAX_OUTPUT_TOKENS = 16384;
const COMPACT_TIMEOUT_MS = 900_000;

function stringify(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value ?? ''); }
}

function blockText(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text') return String(block.text || '');
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return '';
  if (block.type === 'tool_use') {
    return `[Tool Use]\nname: ${String(block.name || '')}\nid: ${String(block.id || '')}\ninput: ${stringify(block.input ?? {})}`;
  }
  if (block.type === 'tool_result') {
    return `[Tool Result]\ntool_use_id: ${String(block.tool_use_id || '')}\ncontent: ${contentText(block.content)}`;
  }
  if (block.type === 'server_tool_use') {
    return `[Server Tool Use]\nname: ${String(block.name || '')}\nid: ${String(block.id || '')}\ninput: ${stringify(block.input ?? {})}`;
  }
  if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
    return `[${block.type}]\ntool_use_id: ${String(block.tool_use_id || '')}\ncontent: ${stringify(block.content ?? {})}`;
  }
  if (block.type === 'image' || block.type === 'document') return `[${block.type} content omitted from compact worker transport]`;
  return stringify(block);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringify(content ?? '');
  return content.map(blockText).filter(Boolean).join('\n\n');
}

export function normalizeCompactMessages(request) {
  const messages = [];
  const system = contentText(request?.system).trim();
  if (system) messages.push({ role: 'system', content: system });
  for (const message of Array.isArray(request?.messages) ? request.messages : []) {
    if (!['user', 'assistant'].includes(message?.role)) continue;
    const content = contentText(message.content).trim();
    if (!content) continue;
    messages.push({ role: message.role, content });
  }
  return messages;
}

export function contextCompactEndpoint(baseUrl, provider = 'vllm') {
  const url = new URL(baseUrl);
  const clean = url.pathname.replace(/\/+$/, '');
  if (provider === 'ollama') {
    if (clean.endsWith('/api/chat')) url.pathname = clean;
    else if (clean.endsWith('/api')) url.pathname = `${clean}/chat`;
    else url.pathname = `${clean}/api/chat`.replace(/\/{2,}/g, '/');
  } else {
    if (clean.endsWith('/v1/chat/completions')) url.pathname = clean;
    else if (clean.endsWith('/v1')) url.pathname = `${clean}/chat/completions`;
    else url.pathname = `${clean}/v1/chat/completions`.replace(/\/{2,}/g, '/');
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function buildContextCompactRequest(request, {
  provider = 'vllm', model, think = false,
} = {}) {
  const messages = normalizeCompactMessages(request);
  if (provider === 'ollama') {
    return {
      model,
      stream: false,
      think: Boolean(think),
      options: { temperature: 0.1, num_predict: MAX_OUTPUT_TOKENS },
      messages,
    };
  }
  return {
    model,
    stream: false,
    temperature: 0.1,
    max_tokens: MAX_OUTPUT_TOKENS,
    chat_template_kwargs: {
      enable_thinking: Boolean(think),
      preserve_thinking: false,
    },
    messages,
  };
}

function stripBackendThinking(value) {
  let text = String(value || '');
  text = text.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '');
  text = text.replace(/<\/?think\b[^>]*>/gi, '');
  return text.trim();
}

export function parseContextCompactResponse(payload, provider = 'vllm') {
  const message = provider === 'ollama' ? payload?.message : payload?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') return '';
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return '';
  return stripBackendThinking(message.content);
}

function errorCode(error) {
  if (error?.name === 'TimeoutError') return 'timeout';
  if (error?.name === 'AbortError') return 'aborted';
  return String(error?.code || error?.cause?.code || 'compact_backend_error').slice(0, 120);
}

export async function runContextCompact(request, {
  config,
  signal,
  onEvent = () => {},
} = {}) {
  const provider = config?.provider || 'vllm';
  const endpoint = contextCompactEndpoint(config.url, provider);
  const body = buildContextCompactRequest(request, config);
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const startedAt = Date.now();
  await onEvent('context_compact_backend_request', {
    provider,
    backend_host: new URL(endpoint).host,
    endpoint_path: new URL(endpoint).pathname,
    model: config.model,
    think: Boolean(config.think),
    message_count: body.messages.length,
  });
  try {
    const timeoutSignal = AbortSignal.timeout(COMPACT_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify(body), signal: combinedSignal,
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { throw Object.assign(new Error('Compact backend returned invalid JSON.'), { code: 'invalid_json' }); }
    if (!response.ok) {
      throw Object.assign(new Error(payload?.error?.message || payload?.error || 'Compact backend rejected the request.'), { code: `http_${response.status}` });
    }
    const summary = parseContextCompactResponse(payload, provider);
    if (!summary) throw Object.assign(new Error('Compact backend returned empty visible content or a tool call.'), { code: 'empty_content' });
    const backendUsage = provider === 'ollama'
      ? { prompt_tokens: payload?.prompt_eval_count || 0, output_tokens: payload?.eval_count || 0 }
      : { prompt_tokens: payload?.usage?.prompt_tokens || 0, output_tokens: payload?.usage?.completion_tokens || 0 };
    await onEvent('context_compact_backend_response', {
      provider,
      backend_host: new URL(endpoint).host,
      elapsed_ms: Date.now() - startedAt,
      output_chars: summary.length,
      backend_prompt_tokens: backendUsage.prompt_tokens,
      backend_output_tokens: backendUsage.output_tokens,
    });
    return { summary, backendUsage };
  } catch (error) {
    if (signal?.aborted) throw error;
    error.compactReason = errorCode(error);
    throw error;
  }
}
