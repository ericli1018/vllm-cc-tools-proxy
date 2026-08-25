import http from 'node:http';
import crypto from 'node:crypto';
import { HttpError, readBody, sendError, sendJson, writeChunk } from '../lib/http.js';
import { adaptMessages } from '../proxy/content-blocks.js';
import { hasProgressHistory, stripProgressHistory, ProgressStream, formatSseEvent } from '../proxy/progress.js';
import { describeClaudeAgentRequest, describeClaudeAgentHandoff } from '../proxy/claude-agent-diagnostics.js';
import { createMediaAdapters } from '../proxy/media-adapters.js';
import { executeManagedTool } from '../proxy/web-tools.js';
import { renderManagedToolResult } from '../proxy/web-result-contract.js';
import { runManagedLoop } from '../proxy/managed-loop.js';
import { ProtocolDiagnosticStore } from '../proxy/protocol-diagnostic-store.js';
import { WebToolDiagnosticTraceStore } from '../proxy/web-tool-diagnostic-trace-store.js';
import { createWebToolDiagnosticController } from '../proxy/web-tool-diagnostic.js';
import { emitFinalAnthropicResponse, emitSseError, pipeAnthropicUpstreamStream, createServerToolStreamBridge } from '../proxy/anthropic-sse.js';
import { collectAnthropicMessageFromSse } from '../proxy/anthropic-sse-collector.js';
import { classifyMessagesRequest } from '../proxy/managed-detector.js';
import { classifyClaudeCodeCompactRequest, prepareClaudeCodeCompactRequest } from '../proxy/context-compact-detector.js';
import { forwardTransparent } from '../proxy/bypass.js';
import { rewriteBaseRequest, selectBaseModel } from '../proxy/base-model.js';
import { prepareMediaHandles } from '../proxy/media-preflight.js';
import { buildMediaUsageBootstrapRequest } from '../proxy/media-usage-bootstrap.js';
import { injectEvidenceContract } from '../proxy/evidence-contract.js';
import { formatRuntimeStatusLine, localizeProgressMessage, statusText } from '../i18n/response-language.js';
import { inventoryProtocolTags, sanitizeProtocolHistory, sanitizeProtocolToolDefinitions } from '../proxy/protocol-sanitizer.js';
import { AdmissionController } from '../concurrency/admission-controller.js';
import { MediaCache } from '../cache/media-cache.js';
import { MediaContinuationCache } from '../cache/media-continuation-cache.js';
import { DocumentSourceCache } from '../cache/document-source-cache.js';
import { scopeMediaCacheKey, scopePdfDocumentCacheKey } from '../cache/cache-key.js';
import { MediaAnalysisRegistry } from '../media/analysis-registry.js';
import { createMediaProgressTracker } from '../proxy/media-progress.js';
import { observeImagePayloads } from '../proxy/image-payload-observer.js';
import { requestBaseUpstream } from './base-upstream.js';
import { isExplicitVllmBusyResponse, waitForRetry } from './base-busy-retry.js';
import { VERSION } from '../version.js';
import { RuntimeTelemetry, formatStartupBanner } from '../proxy/runtime-telemetry.js';
import { normalizeAnthropicUsage, totalAnthropicInputTokens, usageFromTokenCount } from '../proxy/anthropic-usage.js';
import { normalizeNativeWebToolsRequest, createManagedWebPolicyEnforcer, detectServerWebUiDeclaration, canonicalWebToolName } from '../proxy/native-web-tools.js';
import { inspectAnthropicServerCapabilities, inspectAnthropicServerResponse } from '../proxy/server-capabilities.js';
import { prepareLocalToolSearchRequest, localToolSearchStateSnapshot } from '../proxy/tool-search.js';
import { ClientWebToolLifecycleRegistry, parseClaudeCodeWebFetchProcessorChild, webFetchResultNeedsFallback } from '../proxy/client-web-tool-lifecycle.js';
import { processWebFetchContent } from './web-fetch-processor.js';
import { runContextCompact } from './context-compact-client.js';
import { compressContinuationWindow as compressContinuationWindowWithExternalProcessor } from './continuation-state-compressor.js';
import { applyFinalLanguageGate } from '../proxy/final-language-gate.js';
import {
  buildBaseLanguageRepairRequest,
  extractLanguageRepairSegmentFromAnthropic,
  rewriteFinalSegmentsWithExternalProcessor,
} from './final-language-repair.js';

function upstreamEndpoint(baseUrl, path) {
  const base = new URL(baseUrl);
  const clean = base.pathname.replace(/\/$/, '');
  if (clean.endsWith('/v1/messages')) {
    base.pathname = path === '/v1/messages' ? clean : clean.replace(/\/messages$/, '/messages/count_tokens');
  } else if (clean.endsWith('/v1')) {
    base.pathname = `${clean}${path.replace('/v1', '')}`;
  } else {
    base.pathname = `${clean}${path}`.replace(/\/+/g, '/');
  }
  return base.toString();
}

function upstreamHeaders(incomingHeaders, config) {
  const headers = { 'content-type': 'application/json' };
  for (const name of ['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta']) {
    const value = incomingHeaders?.[name];
    if (typeof value === 'string' && value) headers[name] = value;
  }
  if (config.vllmBaseApiKey) headers.authorization = `Bearer ${config.vllmBaseApiKey}`;
  return headers;
}

function bufferedUpstreamResponse(response, text) {
  const buffer = Buffer.from(String(text || ''), 'utf8');
  const body = {
    async *[Symbol.asyncIterator]() {
      if (buffer.length) yield buffer;
    },
  };
  return {
    ...response,
    body,
    text: async () => buffer.toString('utf8'),
  };
}

async function fetchUpstream(request, config, incomingHeaders, signal, path = '/v1/messages', {
  onResponseChunk = null,
  onBusyEvent = null,
} = {}) {
  const retryBusy = path === '/v1/messages';
  const selectedBaseModel = selectBaseModel(request?.model, config.vllmBaseModel);
  const upstreamRequest = rewriteBaseRequest(request, config.vllmBaseModel);
  log(config, 'info', 'base_model_selected', {
    client_model: String(request?.model || ''),
    upstream_model: selectedBaseModel.model,
    source: selectedBaseModel.source,
    path,
  });
  const retryIntervalMs = Number.isFinite(Number(config.vllmBusyRetryIntervalMs))
    ? Math.max(1, Number(config.vllmBusyRetryIntervalMs))
    : 15_000;
  let attempt = 0;
  let waitingSince = 0;
  let hadBusyRejection = false;

  while (true) {
    attempt += 1;
    let forwardChunks = false;
    let response;
    try {
      response = await requestBaseUpstream(upstreamEndpoint(config.vllmBaseUrl, path), {
        method: 'POST',
        headers: upstreamHeaders(incomingHeaders, config),
        body: JSON.stringify(upstreamRequest),
        signal,
        onResponseChunk: typeof onResponseChunk === 'function'
          ? (bytes) => { if (forwardChunks) onResponseChunk(bytes); }
          : null,
      }, config.vllmBaseTimeouts);
    } catch (error) {
      if (error instanceof HttpError || error?.name === 'AbortError') throw error;
      throw new HttpError(502, 'Base vLLM upstream is unavailable.', {
        code: 'vllm_unavailable', retryable: true,
      });
    }

    if (!retryBusy || ![429, 503].includes(response.status)) {
      forwardChunks = true;
      if (hadBusyRejection && typeof onBusyEvent === 'function') {
        await onBusyEvent('accepted', {
          attempt,
          waitedMs: Math.max(0, Date.now() - waitingSince),
          status: response.status,
        });
      }
      return response;
    }

    const text = await response.text();
    if (!isExplicitVllmBusyResponse(response, text)) {
      return bufferedUpstreamResponse(response, text);
    }

    hadBusyRejection = true;
    if (!waitingSince) waitingSince = Date.now();
    if (typeof onBusyEvent === 'function') {
      await onBusyEvent('wait', {
        attempt,
        waitedMs: Math.max(0, Date.now() - waitingSince),
        status: response.status,
      });
    }
    await waitForRetry(retryIntervalMs, signal);
    if (typeof onBusyEvent === 'function') {
      await onBusyEvent('retry', {
        attempt: attempt + 1,
        waitedMs: Math.max(0, Date.now() - waitingSince),
        status: response.status,
      });
    }
  }
}

async function callUpstreamJson(request, config, incomingHeaders, signal, path = '/v1/messages', { onResponseChunk = null, onBusyEvent = null } = {}) {
  const response = await fetchUpstream({ ...request, stream: false }, config, incomingHeaders, signal, path, { onResponseChunk, onBusyEvent });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch {
    throw new HttpError(502, 'vLLM returned invalid JSON.', { code: 'vllm_invalid_response', retryable: true });
  }
  if (!response.ok) {
    throw new HttpError(response.status >= 500 ? 502 : response.status, payload?.error?.message || 'vLLM rejected the request.', {
      code: payload?.error?.type || 'vllm_request_failed', retryable: response.status >= 500, details: payload?.error,
    });
  }
  return payload;
}

async function callUpstreamManagedStream(request, config, incomingHeaders, signal, path = '/v1/messages', { onResponseChunk = null, onStreamPhase = null, onSemanticDelta = null, onCheckpoint = null, onBusyEvent = null, onResponseMode = null } = {}) {
  const response = await fetchUpstream({ ...request, stream: true }, config, incomingHeaders, signal, path, { onResponseChunk, onBusyEvent });
  if (!response.ok) {
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    throw new HttpError(response.status >= 500 ? 502 : response.status, payload?.error?.message || text || 'vLLM rejected the request.', {
      code: payload?.error?.type || 'vllm_request_failed', retryable: response.status >= 500, details: payload?.error,
    });
  }
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const configuredResponseMode = ['streaming', 'buffered'].includes(config.vllmBaseResponseMode)
    ? config.vllmBaseResponseMode
    : 'auto';
  const observedResponseMode = contentType.includes('text/event-stream') ? 'streaming' : 'buffered';
  const effectiveResponseMode = configuredResponseMode === 'auto' ? observedResponseMode : configuredResponseMode;
  if (typeof onResponseMode === 'function') {
    await onResponseMode({
      configuredMode: configuredResponseMode,
      observedMode: observedResponseMode,
      effectiveMode: effectiveResponseMode,
      contentType,
    });
  }
  if (contentType.includes('text/event-stream')) return collectAnthropicMessageFromSse(response, {
    ...(typeof onStreamPhase === 'function' ? { onStreamPhase } : {}),
    ...(typeof onSemanticDelta === 'function' ? { onSemanticDelta } : {}),
    ...(typeof onCheckpoint === 'function' ? { onCheckpoint } : {}),
  });

  // Compatibility fallback for upstreams that ignore stream=true and still return one JSON Message.
  // Raw body chunks are still counted by requestBaseUpstream, but live token activity requires SSE.
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch {
    throw new HttpError(502, 'vLLM returned neither Anthropic SSE nor valid JSON for a managed model round.', {
      code: 'vllm_invalid_stream', retryable: true, details: { content_type: contentType, body_prefix: text.slice(0, 1000) },
    });
  }
}


function isNativeVisionCapabilityRejection(error) {
  if (!(error instanceof HttpError) || ![400, 415, 422].includes(Number(error.status))) return false;
  const text = [
    error.message || '',
    error.code || '',
    typeof error.details === 'string' ? error.details : JSON.stringify(error.details || {}),
  ].join(' ').toLowerCase();
  const mentionsVisualInput = /(?:\bimage(?:s)?\b|\bvision\b|\bvisual\b|multimodal|multi-modal)/.test(text);
  const explicitlyUnsupported = /(?:not\s+support(?:ed)?|does\s+not\s+support|doesn't\s+support|unsupported|not\s+allowed|cannot\s+(?:accept|process|handle)|can't\s+(?:accept|process|handle)|not\s+capable)/.test(text);
  return mentionsVisualInput && explicitlyUnsupported;
}

async function preflightManagedUsage(request, config, incomingHeaders, signal, onDiagnostic = () => {}, {
  successEvent = 'managed_usage_preflight_succeeded',
  failureEvent = 'managed_usage_preflight_failed',
} = {}) {
  if (config.usagePreflightEnabled === false) return usageFromTokenCount({});
  try {
    const payload = await callUpstreamJson(request, config, incomingHeaders, signal, '/v1/messages/count_tokens');
    if (!Number.isInteger(payload?.input_tokens) || payload.input_tokens < 0) {
      throw new HttpError(502, 'Token count response did not contain input_tokens.', {
        code: 'vllm_invalid_token_count',
        retryable: true,
      });
    }
    const usage = usageFromTokenCount(payload);
    await onDiagnostic(successEvent, {
      input_tokens: usage.input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      total_input_tokens: totalAnthropicInputTokens(usage),
    });
    return usage;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    await onDiagnostic(failureEvent, {
      code: typeof error?.code === 'string' ? error.code : 'vllm_token_count_failed',
      retryable: Boolean(error?.retryable),
    });
    return usageFromTokenCount({});
  }
}

function evidenceByteLength(value) {
  let total = 0;
  const walk = (item) => {
    if (typeof item === 'string') {
      if (item.includes('[VCC_PROXY_EVIDENCE_BEGIN')) total += Buffer.byteLength(item);
      return;
    }
    if (Array.isArray(item)) {
      for (const entry of item) walk(entry);
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const entry of Object.values(item)) walk(entry);
  };
  walk(value);
  return total;
}

async function streamManagedBase(progress, request, config, incomingHeaders, signal, {
  onDiagnostic = () => {}, onLifecycle = () => {}, onUsage = () => {}, onResponseChunk = null, onBusyEvent = null,
} = {}) {
  const outbound = { ...request, stream: true };
  const requestStartedAt = Date.now();
  await onLifecycle('base_upstream_request_start', {
    request_bytes: Buffer.byteLength(JSON.stringify(outbound)),
    message_count: Array.isArray(outbound.messages) ? outbound.messages.length : 0,
    evidence_bytes: evidenceByteLength(outbound.messages),
  });
  const upstream = await fetchUpstream(outbound, config, incomingHeaders, signal, '/v1/messages', { onResponseChunk, onBusyEvent });
  const headersReceivedAt = Date.now();
  await onLifecycle('base_upstream_headers_received', {
    status: upstream.status,
    header_wait_ms: headersReceivedAt - requestStartedAt,
  });
  if (!upstream.ok) {
    const text = await upstream.text();
    throw new HttpError(upstream.status >= 500 ? 502 : upstream.status, text || 'vLLM rejected the request.', {
      code: 'vllm_request_failed', retryable: upstream.status >= 500,
    });
  }
  if (!(upstream.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')) {
    const text = await upstream.text();
    throw new HttpError(502, 'vLLM did not return an Anthropic SSE stream.', {
      code: 'vllm_invalid_stream', retryable: true, details: text.slice(0, 1000),
    });
  }
  await pipeAnthropicUpstreamStream(progress, upstream, {
    locale: config.responseLanguage,
    onDiagnostic,
    onUsage,
    onFirstEvent: async ({ event, type }) => onLifecycle('base_upstream_first_event', {
      upstream_event: event,
      upstream_type: type,
      first_event_wait_ms: Date.now() - requestStartedAt,
      first_event_after_headers_ms: Date.now() - headersReceivedAt,
    }),
    onComplete: async ({ firstModelEventObserved } = {}) => onLifecycle('base_upstream_stream_completed', {
      total_stream_ms: Date.now() - requestStartedAt,
      first_model_event_observed: Boolean(firstModelEventObserved),
    }),
  });
}


async function collectManagedBase(request, config, incomingHeaders, signal, {
  onLifecycle = () => {}, onUsage = () => {}, onResponseChunk = null, onSemanticDelta = null, onBusyEvent = null,
} = {}) {
  const outbound = { ...request, stream: true };
  const requestStartedAt = Date.now();
  await onLifecycle('base_upstream_request_start', {
    request_bytes: Buffer.byteLength(JSON.stringify(outbound)),
    message_count: Array.isArray(outbound.messages) ? outbound.messages.length : 0,
    evidence_bytes: evidenceByteLength(outbound.messages),
  });
  const upstream = await fetchUpstream(outbound, config, incomingHeaders, signal, '/v1/messages', { onResponseChunk, onBusyEvent });
  const headersReceivedAt = Date.now();
  await onLifecycle('base_upstream_headers_received', {
    status: upstream.status,
    header_wait_ms: headersReceivedAt - requestStartedAt,
  });
  if (!upstream.ok) {
    const text = await upstream.text();
    throw new HttpError(upstream.status >= 500 ? 502 : upstream.status, text || 'vLLM rejected the request.', {
      code: 'vllm_request_failed', retryable: upstream.status >= 500,
    });
  }
  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/event-stream')) {
    return collectAnthropicMessageFromSse(upstream, {
      onUsage,
      ...(typeof onSemanticDelta === 'function' ? { onSemanticDelta } : {}),
      onFirstEvent: async ({ event, type, block_type }) => onLifecycle('base_upstream_first_event', {
        upstream_event: event,
        upstream_type: type,
        block_type,
        first_event_wait_ms: Date.now() - requestStartedAt,
        first_event_after_headers_ms: Date.now() - headersReceivedAt,
      }),
      onStreamPhase: async (entry) => onLifecycle('base_upstream_stream_phase', {
        ...entry,
        phase_elapsed_ms: Date.now() - requestStartedAt,
      }),
      onComplete: async ({ firstModelEventObserved } = {}) => onLifecycle('base_upstream_stream_completed', {
        total_stream_ms: Date.now() - requestStartedAt,
        first_model_event_observed: Boolean(firstModelEventObserved),
      }),
    });
  }

  const text = await upstream.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch {
    throw new HttpError(502, 'vLLM returned neither Anthropic SSE nor valid JSON for a managed model round.', {
      code: 'vllm_invalid_stream', retryable: true, details: { content_type: contentType, body_prefix: text.slice(0, 1000) },
    });
  }
  await onUsage({ stage: 'json_response', usage: normalizeAnthropicUsage(payload?.usage) });
  await onLifecycle('base_upstream_stream_completed', {
    total_stream_ms: Date.now() - requestStartedAt,
    first_model_event_observed: false,
    compatibility_json: true,
  });
  return payload;
}

async function streamTransformedBase(request, res, config, incomingHeaders, signal, path = '/v1/messages') {
  const upstream = await fetchUpstream({ ...request, stream: true }, config, incomingHeaders, signal, path);
  if (!upstream.ok) {
    const text = await upstream.text();
    throw new HttpError(upstream.status >= 500 ? 502 : upstream.status, text || 'vLLM rejected the request.', {
      code: 'vllm_request_failed', retryable: upstream.status >= 500,
    });
  }
  const contentType = upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8';
  res.writeHead(upstream.status, {
    'content-type': contentType,
    'cache-control': upstream.headers.get('cache-control') || 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (upstream.body) {
    for await (const chunk of upstream.body) await writeChunk(res, chunk);
  }
  res.end();
}

function parseJson(rawBody) {
  if (!rawBody.length) return null;
  try { return JSON.parse(rawBody.toString('utf8')); } catch { return null; }
}

function validateMessagesRequest(request) {
  if (!request || typeof request !== 'object' || !Array.isArray(request.messages)) {
    throw new HttpError(400, 'Anthropic Messages request requires a messages array.', { code: 'invalid_request' });
  }
}

function canonicalMessagesPath(pathname) {
  if (pathname === '/v1/messages' || pathname === '/v1/messages/') return '/v1/messages';
  if (pathname === '/v1/messages/count_tokens' || pathname === '/v1/messages/count_tokens/') return '/v1/messages/count_tokens';
  return '';
}

function claudeCodeSessionId(headers, request) {
  const header = headers?.['x-claude-code-session-id'];
  if (typeof header === 'string' && header.trim()) return header.trim().slice(0, 200);
  const raw = request?.metadata?.user_id;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.session_id === 'string' && parsed.session_id.trim()) return parsed.session_id.trim().slice(0, 200);
    } catch {}
  }
  return '';
}

function isToolResultContinuation(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  return last?.role === 'user'
    && Array.isArray(last.content)
    && last.content.length > 0
    && last.content.every((block) => block?.type === 'tool_result');
}

function findToolUseById(messages, toolUseId) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'assistant') continue;
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'tool_use' && String(block?.id || '') === String(toolUseId || '')) return block;
    }
  }
  return null;
}

function syntheticTextResponse(model, text) {
  return {
    id: `msg_proxy_${crypto.randomUUID().replaceAll('-', '')}`,
    type: 'message', role: 'assistant', model: model || 'proxy',
    content: [{ type: 'text', text: String(text || '') }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

async function openContextCompactLiveness(res, {
  pingIntervalMs = 5000,
  drainTimeoutMs = 0,
  onEvent = async () => {},
} = {}) {
  if (!res.headersSent) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
  }
  let stopped = false;
  let timer = null;
  let pingCount = 0;
  let queue = Promise.resolve();
  const writePing = () => {
    queue = queue.catch(() => {}).then(async () => {
      if (stopped || res.destroyed || res.writableEnded) return;
      await writeChunk(res, formatSseEvent('ping', { type: 'ping' }), { drainTimeoutMs });
      pingCount += 1;
      try { await onEvent('context_compact_client_ping', { ping_count: pingCount }); } catch {}
    });
    return queue;
  };
  await writePing();
  try {
    await onEvent('context_compact_client_stream_open', {
      ping_interval_ms: pingIntervalMs,
      ping_count: pingCount,
    });
  } catch {}
  timer = setInterval(() => { writePing().catch(() => {}); }, pingIntervalMs);
  timer.unref?.();
  return {
    async stop(reason = 'complete') {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      try { await queue; } catch {}
      try {
        await onEvent('context_compact_client_stream_stop', {
          reason,
          ping_count: pingCount,
        });
      } catch {}
    },
  };
}

async function sendContextCompactResult(res, request, summary, { drainTimeoutMs = 0 } = {}) {
  const response = syntheticTextResponse(request?.model, summary);
  if (request?.stream !== true) {
    sendJson(res, 200, response);
    return;
  }
  if (!res.headersSent) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
  }
  const events = [
    formatSseEvent('message_start', {
      type: 'message_start',
      message: { ...response, content: [], stop_reason: null },
    }),
    formatSseEvent('content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    }),
    formatSseEvent('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String(summary || '') },
    }),
    formatSseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    formatSseEvent('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: response.usage,
    }),
    formatSseEvent('message_stop', { type: 'message_stop' }),
  ];
  for (const event of events) await writeChunk(res, event, { drainTimeoutMs });
  res.end();
}

function log(config, level, event, fields = {}) {
  const ranks = { debug: 10, info: 20, warn: 30, error: 40 };
  if ((ranks[level] || 20) < (ranks[config.logLevel] || 20)) return;
  const entry = { timestamp: new Date().toISOString(), level, event, ...fields };
  if (typeof config.logSink === 'function') {
    config.logSink(entry);
    return;
  }
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

function diagnosticLogLevel(event) {
  if (event.endsWith('_rejected') || event.includes('_diagnostic_file') || event.includes('_anomaly_snippet') || event.includes('_input_protocol_snippet')) return 'warn';
  return 'info';
}

function defaultConcurrency(config) {
  return {
    visionLimit: config.concurrency?.visionLimit || 1,
    webFetchProcessorLimit: config.webFetchProcessor?.concurrency || 3,
  };
}

export function createProxyServer(config, dependencies = {}) {
  const admission = dependencies.admission || new AdmissionController(defaultConcurrency(config));
  const runtimeTelemetry = dependencies.runtimeTelemetry || new RuntimeTelemetry();
  const mediaCache = dependencies.mediaCache || new MediaCache(config.cache || { rootDir: '', maxBytes: 0 });
  const mediaContinuationCache = dependencies.mediaContinuationCache || new MediaContinuationCache();
  const progressStreamFactory = dependencies.progressStreamFactory || ((response, options) => new ProgressStream(response, options));
  const documentSourceCache = dependencies.documentSourceCache || new DocumentSourceCache({
    rootDir: config.cache?.rootDir || '',
    retentionMs: config.cache?.retentionMs,
  });
  const analysisRegistry = dependencies.analysisRegistry || new MediaAnalysisRegistry();
  const cacheReady = Promise.all([
    mediaCache.initialize(),
    typeof documentSourceCache.initialize === 'function' ? documentSourceCache.initialize() : Promise.resolve(documentSourceCache),
  ]);
  const protocolDiagnosticStore = config.logProtocolSnippets
    ? (dependencies.protocolDiagnosticStore || new ProtocolDiagnosticStore({
      rootDir: config.protocolDiagnosticsDir,
    }))
    : null;
  const webToolDiagnosticConfig = config.webToolDiagnostic || {
    enabled: false,
    trace: false,
    searchPassthroughCount: 1,
    fetchPassthroughCount: 1,
    traceDir: '/var/lib/vllm-cc-tools-proxy/diagnostics/web-tool-trace',
  };
  const webToolDiagnosticController = dependencies.webToolDiagnosticController || createWebToolDiagnosticController(webToolDiagnosticConfig);
  const clientWebToolLifecycleRegistry = dependencies.clientWebToolLifecycleRegistry || new ClientWebToolLifecycleRegistry();
  const webToolDiagnosticTraceStore = webToolDiagnosticConfig.trace
    ? (dependencies.webToolDiagnosticTraceStore || new WebToolDiagnosticTraceStore({ rootDir: webToolDiagnosticConfig.traceDir }))
    : null;

  async function writeWebToolTrace(requestId, event, direction, metadata, payload) {
    if (!webToolDiagnosticTraceStore) return null;
    try {
      const result = await webToolDiagnosticTraceStore.write({
        request_id: requestId,
        event,
        direction,
        metadata,
        payload,
      });
      log(config, 'info', 'diagnostic_web_tool_trace_file', {
        requestId,
        trace_event: event,
        file_path: result?.file_path || '',
      });
      return result;
    } catch (error) {
      log(config, 'warn', 'diagnostic_web_tool_trace_failed', {
        requestId,
        trace_event: event,
        code: String(error?.code || 'trace_write_failed'),
        message: String(error?.message || error),
      });
      return null;
    }
  }

  async function enrichReturnedWebFetchResults(messages, { sessionId, model, signal, requestId }) {
    const sourceMessages = Array.isArray(messages) ? messages : [];
    const hasFallbackCandidate = sourceMessages.some((message) => (
      message?.role === 'user'
      && Array.isArray(message.content)
      && message.content.some((block) => webFetchResultNeedsFallback(block))
    ));
    if (!hasFallbackCandidate) {
      return { messages: sourceMessages, changed: false, enrichedCount: 0 };
    }
    const outputMessages = structuredClone(sourceMessages);
    const sessionKey = sessionId || `request:${requestId}`;
    let changed = false;
    let enrichedCount = 0;
    for (const message of outputMessages) {
      if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!webFetchResultNeedsFallback(block)) continue;
        const toolUse = findToolUseById(outputMessages, block.tool_use_id);
        if (!toolUse || canonicalWebToolName(toolUse.name) !== 'WebFetch') continue;
        let rendered = clientWebToolLifecycleRegistry.getEnriched(sessionKey, block.tool_use_id);
        if (!rendered) {
          try {
            const fetched = await executeManagedTool(toolUse, config, signal, {
              model: model || '',
              acquireProcessor: (options) => admission.acquireWebFetchProcessor(options),
              onEvent: (event, fields) => log(
                config,
                event.endsWith('_rejected') || event.endsWith('_fallback') ? 'warn' : 'info',
                event,
                { requestId, fallback_enrichment: true, ...fields },
              ),
            });
            rendered = renderManagedToolResult('WebFetch', fetched);
            clientWebToolLifecycleRegistry.setEnriched(sessionKey, block.tool_use_id, rendered);
          } catch (error) {
            log(config, 'warn', 'web_fetch_result_enrichment_failed', {
              requestId,
              tool_use_id: String(block.tool_use_id || ''),
              code: String(error?.code || 'web_fetch_enrichment_failed'),
              retryable: Boolean(error?.retryable),
            });
            continue;
          }
        }
        block.content = rendered;
        delete block.is_error;
        changed = true;
        enrichedCount += 1;
      }
    }
    return { messages: outputMessages, changed, enrichedCount };
  }

  return http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID();
    const requestObservedAt = Date.now();
    const abortController = new AbortController();
    let progress = null;
    let compactLiveness = null;
    let completed = false;
    let preparedMedia = null;
    let mediaProgress = null;
    let releaseRuntimeRequest = null;
    let requestStage = 'request_start';
    let initialStreamUsage = usageFromTokenCount({});
    let baseResponseBytes = 0; // raw upstream wire bytes; timeout/stall diagnostics only
    let lastBaseResponseChunkAt = 0;
    let effectiveBaseResponseMode = ['streaming', 'buffered'].includes(config.vllmBaseResponseMode)
      ? config.vllmBaseResponseMode
      : '';
    let modelOutputBytes = 0; // semantic thinking/text/tool JSON payload bytes only
    let lastModelOutputDeltaAt = 0;
    let claudeAgentRequestContext = null;
    let clientSessionId = '';
    let progressFirstVisibleAt = 0;
    const observeProgressWrite = (entry = {}) => {
      if (progressFirstVisibleAt || entry.kind !== 'progress_block_start') return;
      progressFirstVisibleAt = Date.now();
      log(config, 'info', 'proxy_progress_first_visible', {
        requestId,
        agent_context: claudeAgentRequestContext?.context || 'unknown',
        content_index: 0,
        progress_carrier: entry.carrier || 'text',
        phase: entry.phase || '',
        sequence: entry.sequence || 0,
        elapsed_ms: Math.max(0, progressFirstVisibleAt - requestObservedAt),
      });
    };
    const observeAgentHandoff = (response) => {
      const handoffs = describeClaudeAgentHandoff(response);
      if (handoffs.length === 0) return;
      log(config, 'info', 'claude_agent_handoff_observed', {
        requestId,
        agent_context: claudeAgentRequestContext?.context || 'unknown',
        progress_visible: Boolean(progress?.visible),
        progress_preceded_handoff: Boolean(progressFirstVisibleAt),
        progress_first_visible_elapsed_ms: progressFirstVisibleAt
          ? Math.max(0, progressFirstVisibleAt - requestObservedAt)
          : null,
        stop_reason: String(response?.stop_reason || ''),
        handoffs,
      });
    };
    const observeServerResponseCapabilities = (response, stage = 'base_response') => {
      const inventory = inspectAnthropicServerResponse(response);
      if (inventory.server_tool_use_count > 0
          || inventory.tool_search_result_count > 0
          || inventory.tool_reference_count > 0) {
        log(config, 'info', 'anthropic_server_response_inventory', {
          requestId,
          stage,
          server_tool_use_count: inventory.server_tool_use_count,
          tool_search_result_count: inventory.tool_search_result_count,
          tool_reference_count: inventory.tool_reference_count,
          unknown_server_tool_use_count: inventory.unknown_server_tool_use_count,
          tool_reference_names_sha256: inventory.tool_reference_names_sha256,
        });
      }
      for (const entry of inventory.unknown_server_tool_uses) {
        log(config, 'warn', 'anthropic_server_tool_use_unknown', {
          requestId,
          stage,
          server_tool_name: entry.name,
          server_tool_id: entry.id,
        });
      }
      return response;
    };
    const modelRoundProgress = {
      active: false,
      round: 0,
      lane: 'managed',
      startedAt: 0,
      startBytes: 0,
      startModelBytes: 0,
      firstByteNotified: false,
      firstSemanticDeltaNotified: false,
      phase: 'waiting',
    };
    const onManagedModelStreamPhase = async ({ phase, previous_phase = 'waiting', event = '', block_type = '', delta_type = '' } = {}) => {
      if (!['thinking', 'response', 'tool'].includes(phase)) return;
      if (modelRoundProgress.phase === phase) return;
      const previousPhase = modelRoundProgress.phase || previous_phase || 'waiting';
      modelRoundProgress.phase = phase;
      runtimeTelemetry.updateRequest(requestId, { phase });
      const elapsedMs = modelRoundProgress.startedAt > 0
        ? Math.max(0, Date.now() - modelRoundProgress.startedAt)
        : 0;
      const receivedThisRound = modelRoundProgress.active
        ? Math.max(0, modelOutputBytes - modelRoundProgress.startModelBytes)
        : modelOutputBytes;
      log(config, 'info', 'managed_model_stream_phase_changed', {
        requestId,
        lane: modelRoundProgress.lane,
        round: modelRoundProgress.round || 1,
        previous_phase: previousPhase,
        phase,
        upstream_event: event,
        block_type,
        delta_type,
        elapsed_ms: elapsedMs,
        round_received_bytes: receivedThisRound,
      });
      if (progress) {
        await progress.update(statusText(config.responseLanguage, 'modelPhaseChanged', {
          modelPhase: phase,
          receivedBytes: receivedThisRound,
        }), {
          force: Boolean(progress.visible),
          details: {
            phase: 'model_stream_phase',
            model_phase: phase,
            previous_model_phase: previousPhase,
            lane: modelRoundProgress.lane,
            round: modelRoundProgress.round || 1,
            round_received_bytes: receivedThisRound,
          },
        });
      }
    };
    const onBaseResponseChunk = (bytes) => {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return;
      baseResponseBytes += value;
      lastBaseResponseChunkAt = Date.now();
      if (!modelRoundProgress.active || modelRoundProgress.firstByteNotified || baseResponseBytes <= modelRoundProgress.startBytes) return;

      modelRoundProgress.firstByteNotified = true;
      const elapsedMs = Math.max(0, lastBaseResponseChunkAt - modelRoundProgress.startedAt);
      const receivedThisRound = Math.max(0, baseResponseBytes - modelRoundProgress.startBytes);
      log(config, 'info', 'managed_model_first_byte_received', {
        requestId,
        lane: modelRoundProgress.lane,
        round: modelRoundProgress.round,
        elapsed_ms: elapsedMs,
        chunk_bytes: value,
        received_bytes: baseResponseBytes,
        round_received_bytes: receivedThisRound,
      });
    };
    const onModelSemanticDelta = async ({ bytes = 0, type = '' } = {}) => {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return;
      modelOutputBytes += value;
      lastModelOutputDeltaAt = Date.now();
      runtimeTelemetry.observeModelDelta(requestId, value, lastModelOutputDeltaAt);
      log(config, 'debug', 'model_semantic_delta_observed', {
        requestId,
        delta_type: type,
        delta_bytes: value,
        model_output_bytes: modelOutputBytes,
      });
      if (modelRoundProgress.active && !modelRoundProgress.firstSemanticDeltaNotified && progress) {
        modelRoundProgress.firstSemanticDeltaNotified = true;
        await progress.update(statusText(config.responseLanguage, 'modelHeartbeat', sampleModelHeartbeat(lastModelOutputDeltaAt)), {
          force: Boolean(progress.visible),
          details: {
            phase: 'model_semantic_first_delta',
            model_phase: modelRoundProgress.phase || 'waiting',
            round: modelRoundProgress.round || 1,
            delta_type: type,
            delta_bytes: value,
            round_model_output_bytes: getCurrentRoundResponseBytes(),
          },
        });
      }
    };
    const onBaseResponseMode = async ({ configuredMode = 'auto', observedMode = '', effectiveMode = '', contentType = '' } = {}) => {
      effectiveBaseResponseMode = ['streaming', 'buffered'].includes(effectiveMode) ? effectiveMode : effectiveBaseResponseMode;
      log(config, 'info', 'base_response_mode_selected', {
        requestId,
        configured_mode: configuredMode,
        observed_mode: observedMode,
        effective_mode: effectiveBaseResponseMode || 'auto',
        content_type: String(contentType || '').slice(0, 160),
      });
    };
    const getBaseResponseBytes = () => baseResponseBytes;
    const getCurrentRoundResponseBytes = () => {
      const snapshot = runtimeTelemetry.snapshotRequest(requestId);
      if (snapshot?.known && snapshot.roundActive) return snapshot.receivedBytes || 0;
      return modelRoundProgress.active
        ? Math.max(0, modelOutputBytes - modelRoundProgress.startModelBytes)
        : 0;
    };
    const sampleModelHeartbeat = (now = Date.now()) => {
      const snapshot = runtimeTelemetry.snapshotRequest(requestId, now);
      const roundBytes = snapshot?.known ? (snapshot.receivedBytes || 0) : getCurrentRoundResponseBytes();
      const idleMs = lastModelOutputDeltaAt > 0
        ? Math.max(0, now - lastModelOutputDeltaAt)
        : 0;
      const stalled = Boolean(
        lastModelOutputDeltaAt > 0
        && roundBytes > 0
        && idleMs >= Math.max(1, config.progressHeartbeatMs),
      );
      return {
        seconds: snapshot?.known
          ? Math.floor(Math.max(0, snapshot.elapsedMs || 0) / 1000)
          : (modelRoundProgress.startedAt > 0 ? Math.floor(Math.max(0, now - modelRoundProgress.startedAt) / 1000) : 0),
        receivedBytes: roundBytes,
        modelPhase: modelRoundProgress.phase || snapshot?.underlyingPhase || 'waiting',
        recentBytesPerSecond: snapshot?.known ? snapshot.throughputBps : undefined,
        stalled,
        idleSeconds: Math.floor(idleMs / 1000),
        responseMode: effectiveBaseResponseMode || config.vllmBaseResponseMode || 'auto',
        pulseIndex: snapshot?.known ? snapshot.pulseIndex : 0,
      };
    };
    const baseBusyState = { waiting: false, acceptedAt: 0 };
    const getBaseUpstreamActivity = () => ({
      receivedBytes: baseResponseBytes,
      lastByteAt: lastBaseResponseChunkAt,
      busyWaiting: baseBusyState.waiting,
      busyAcceptedAt: baseBusyState.acceptedAt,
      responseMode: effectiveBaseResponseMode,
      phase: modelRoundProgress.phase || 'waiting',
    });
    const progressTiming = { mode: 'initial', startedAt: Date.now(), position: 0 };
    const onBaseBusyEvent = async (event, fields = {}) => {
      const waitedMs = Math.max(0, Number(fields.waitedMs || 0));
      const attempt = Math.max(1, Number(fields.attempt || 1));
      log(config, 'info', `base_upstream_busy_${event}`, {
        requestId,
        attempt,
        waited_ms: waitedMs,
        http_status: fields.status || 0,
      });
      if (event === 'wait' || event === 'retry') {
        baseBusyState.waiting = true;
        runtimeTelemetry.setBusy(requestId, true, { attempt });
        progressTiming.mode = 'busy';
        progressTiming.startedAt = Date.now() - waitedMs;
      } else if (event === 'accepted') {
        baseBusyState.waiting = false;
        runtimeTelemetry.setBusy(requestId, false);
        runtimeTelemetry.updateRequest(requestId, { phase: 'waiting', busyAttempt: 0 });
        baseBusyState.acceptedAt = Date.now();
        progressTiming.mode = 'model';
        progressTiming.startedAt = baseBusyState.acceptedAt;
      }
      if (!progress) return;
      if (event === 'wait') {
        await progress.update(statusText(config.responseLanguage, 'upstreamBusyWait', {
          seconds: Math.floor(waitedMs / 1000),
          attempt,
        }), {
          force: true,
          details: { phase: 'upstream_busy_wait', attempt, waited_ms: waitedMs },
        });
      } else if (event === 'retry') {
        await progress.update(statusText(config.responseLanguage, 'upstreamBusyRetry', {
          seconds: Math.floor(waitedMs / 1000),
          attempt,
        }), {
          force: true,
          details: { phase: 'upstream_busy_retry', attempt, waited_ms: waitedMs },
        });
      } else if (event === 'accepted') {
        await progress.update(statusText(config.responseLanguage, 'upstreamBusyAccepted', {
          seconds: Math.floor(waitedMs / 1000),
          attempt,
        }), {
          force: true,
          details: { phase: 'upstream_busy_accepted', attempt, waited_ms: waitedMs },
        });
      }
    };
    const url = new URL(req.url || '/', 'http://localhost');

    const webFetchProcessorAvailable = () => Boolean(
      config.webFetchProcessor?.enabled
      && config.webFetchProcessor?.url
      && config.webFetchProcessor?.model
    );

    const languageProcessorAvailable = () => Boolean(
      config.langProcessor?.enabled
      && config.langProcessor?.url
      && config.langProcessor?.model
    );

    const applyFinalPresentationLanguage = async (response, sourceRequest) => {
      let externalLanguageRepairFailed = false;
      const onLanguageEvent = async (event, fields = {}) => {
        const level = event.endsWith('_failed') ? 'warn' : 'info';
        log(config, level, event, { requestId, ...fields });
        if (event === 'final_language_repair_failed' && fields.backend === 'external' && fields.fallback === 'base') {
          externalLanguageRepairFailed = true;
        }
        if (event === 'final_language_repair_started') {
          runtimeTelemetry.updateRequest(requestId, {
            phase: 'language',
            detail: fields.backend ? `${fields.backend}:${config.responseLanguage}` : config.responseLanguage,
          });
        }
        if (event === 'final_language_repair_started' && progress) {
          const statusKey = fields.backend === 'base' && externalLanguageRepairFailed
            ? 'finalLanguageRepairFallbackBase'
            : 'finalLanguageRepair';
          await progress.update(statusText(config.responseLanguage, statusKey), {
            force: true,
            details: { phase: 'final_language_repair', backend: fields.backend, target: config.responseLanguage },
          });
        }
      };

      const rewriteExternal = languageProcessorAvailable()
        ? (segments, locale, options = {}) => rewriteFinalSegmentsWithExternalProcessor(segments, {
          locale,
          processor: config.langProcessor,
          signal: abortController.signal,
          onEvent: onLanguageEvent,
          strict: Boolean(options.strict),
        })
        : undefined;

      const rewriteBase = async (segments, locale, options = {}) => {
        const rewritten = [];
        for (const segment of segments) {
          const repairRequest = buildBaseLanguageRepairRequest(segment, {
            locale,
            model: sourceRequest?.model || response?.model || '',
            maxTokens: Number.isInteger(sourceRequest?.max_tokens) && sourceRequest.max_tokens > 0
              ? sourceRequest.max_tokens
              : 16384,
            strict: Boolean(options.strict),
          });
          const repaired = await callUpstreamJson(
            repairRequest,
            config,
            req.headers,
            abortController.signal,
            '/v1/messages',
            { onResponseChunk: onBaseResponseChunk, onBusyEvent: onBaseBusyEvent },
          );
          rewritten.push(extractLanguageRepairSegmentFromAnthropic(repaired));
        }
        return rewritten;
      };

      const gated = await applyFinalLanguageGate(response, {
        locale: config.responseLanguage,
        rewriteExternal,
        rewriteBase,
        onEvent: onLanguageEvent,
      });
      return gated.response;
    };

    res.on('close', () => {
      if (!completed && !abortController.signal.aborted) {
        abortController.abort(new DOMException('Client disconnected.', 'AbortError'));
        log(config, 'info', 'client_disconnect_detected', { requestId, method: req.method, path: url.pathname });
      }
    });

    try {
      if (req.method === 'HEAD' && url.pathname === '/') {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        completed = true;
        log(config, 'debug', 'route_decision', { requestId, method: req.method, path: url.pathname, decision: 'local', reason: 'startup_probe' });
        return;
      }

      if (['GET', 'HEAD'].includes(req.method) && ['/api/hello', '/api/hello/'].includes(url.pathname)) {
        const body = JSON.stringify({ message: 'hello' });
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        completed = true;
        log(config, 'debug', 'route_decision', { requestId, method: req.method, path: url.pathname, decision: 'local', reason: 'claude_code_hello_probe' });
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
        await cacheReady;
        const state = admission.health();
        const cacheState = mediaCache.health();
        const registryState = analysisRegistry.health();
        completed = true;
        return sendJson(res, 200, {
          status: cacheState.write_available ? 'ok' : 'degraded', service: 'proxy', version: VERSION, revision: config.gitRevision,
          vision: { active: state.vision.active, limit: state.vision.limit },
          web_fetch_processor: { active: state.webFetchProcessor.active, limit: state.webFetchProcessor.limit, queued: state.webFetchProcessor.queued },
          cache: { ...cacheState, ...registryState, continuation: mediaContinuationCache.health() },
        });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/cc-tool-proxy/status/')) {
        const encodedSessionId = url.pathname.slice('/cc-tool-proxy/status/'.length);
        let sessionId = '';
        try { sessionId = decodeURIComponent(encodedSessionId); } catch {}
        const snapshot = runtimeTelemetry.snapshotSession(sessionId);
        const proxySnapshot = runtimeTelemetry.snapshot();
        if (!sessionId || !snapshot.known) {
          completed = true;
          return sendJson(res, 404, { service: 'cc-tool-proxy', version: VERSION, status: 'unknown_session' });
        }
        const display = formatRuntimeStatusLine(config.responseLanguage, {
          version: VERSION,
          ...snapshot,
          proxySessions: proxySnapshot.sessions,
          proxyActive: proxySnapshot.active,
          proxyWaiting: proxySnapshot.waiting,
        });
        completed = true;
        log(config, 'debug', 'runtime_status_read', {
          requestId,
          session_id: sessionId,
          phase: snapshot.phase,
          active: snapshot.active,
        });
        return sendJson(res, 200, {
          service: 'cc-tool-proxy',
          version: VERSION,
          session_id: sessionId,
          locale: config.responseLanguage,
          status_owner: 'main',
          active: snapshot.active,
          phase: snapshot.phase,
          round: snapshot.round || 0,
          round_active: Boolean(snapshot.roundActive),
          underlying_phase: snapshot.underlyingPhase || snapshot.lastPhase || snapshot.phase,
          elapsed_ms: snapshot.elapsedMs || 0,
          phase_elapsed_ms: snapshot.phaseElapsedMs || 0,
          received_bytes: snapshot.receivedBytes || 0,
          throughput_bps: snapshot.throughputBps || 0,
          idle_ms: snapshot.idleMs || 0,
          busy_attempt: snapshot.busyAttempt || 0,
          tool_name: snapshot.toolName || '',
          detail: snapshot.detail || '',
          pulse_index: snapshot.pulseIndex || 0,
          proxy: {
            sessions: proxySnapshot.sessions || 0,
            active: proxySnapshot.active || 0,
            waiting: proxySnapshot.waiting || 0,
          },
          display,
        });
      }

      const messagesPath = req.method === 'POST' ? canonicalMessagesPath(url.pathname) : '';
      const isMessagesPath = Boolean(messagesPath);
      if (!isMessagesPath) {
        const rawBody = await readBody(req, config.limits.maxRequestBytes);
        await writeWebToolTrace(
          requestId,
          'client_unmanaged_request',
          'claude_code_to_proxy',
          { method: req.method, path: url.pathname, query: url.search },
          {
            headers: req.headers,
            raw_body_bytes: rawBody.length,
            raw_body_utf8: rawBody.toString('utf8'),
          },
        );
        log(config, 'info', 'route_decision', { requestId, method: req.method, path: url.pathname, decision: 'bypass', reason: 'unmanaged_endpoint' });
        await forwardTransparent(req, res, config, { rawBody, signal: abortController.signal });
        await writeWebToolTrace(
          requestId,
          'client_unmanaged_request_completed',
          'proxy_to_claude_code',
          { method: req.method, path: url.pathname, query: url.search },
          { completed: true },
        );
        completed = true;
        return;
      }
      requestStage = 'request_body';
      let rawBody = await readBody(req, config.limits.maxRequestBytes);
      let original = parseJson(rawBody);
      if (!original) {
        log(config, 'info', 'route_decision', { requestId, method: req.method, path: url.pathname, decision: 'bypass', reason: 'invalid_json_passthrough' });
        await forwardTransparent(req, res, config, { rawBody, signal: abortController.signal });
        completed = true;
        return;
      }

      clientSessionId = claudeCodeSessionId(req.headers, original);
      if (messagesPath === '/v1/messages') {
        const serverCapabilityInventory = inspectAnthropicServerCapabilities(original);
        if (serverCapabilityInventory.tool_search_count > 0 || serverCapabilityInventory.unsupported_count > 0) {
          log(config, 'info', 'anthropic_server_capability_inventory', {
            requestId,
            server_tool_count: serverCapabilityInventory.server_tool_count,
            bridged_count: serverCapabilityInventory.bridged_count,
            tool_search_count: serverCapabilityInventory.tool_search_count,
            discovery_only_count: serverCapabilityInventory.discovery_only_count,
            local_bridge_count: serverCapabilityInventory.local_bridge_count,
            unsupported_count: serverCapabilityInventory.unsupported_count,
            unsupported_families: serverCapabilityInventory.unsupported_families,
          });
        }
        if (serverCapabilityInventory.tool_search_count > 0) {
          log(config, 'info', 'tool_search_request_observed', {
            requestId,
            ...serverCapabilityInventory.tool_search,
            execution_mode: 'local_bridge',
          });
        }
        for (const entry of serverCapabilityInventory.definitions.filter((item) => item.status === 'unsupported')) {
          log(config, 'warn', 'anthropic_server_tool_unsupported', {
            requestId,
            family: entry.family,
            native_type: entry.type,
            declared_name: entry.name,
            action: 'diagnostic_passthrough',
          });
        }
        claudeAgentRequestContext = describeClaudeAgentRequest(req.headers, original);
        log(config, 'info', 'claude_agent_request_observed', {
          requestId,
          agent_context: claudeAgentRequestContext.context,
          has_agent_id: claudeAgentRequestContext.has_agent_id,
          has_parent_agent_id: claudeAgentRequestContext.has_parent_agent_id,
          agent_id_fingerprint: claudeAgentRequestContext.agent_id_fingerprint,
          parent_agent_id_fingerprint: claudeAgentRequestContext.parent_agent_id_fingerprint,
          declared_subagent_tools: claudeAgentRequestContext.declared_subagent_tools,
          stream: claudeAgentRequestContext.stream,
          message_count: claudeAgentRequestContext.message_count,
        });
        log(config, 'info', 'claude_agent_progress_policy', {
          requestId,
          agent_context: claudeAgentRequestContext.context,
          visible_progress: claudeAgentRequestContext.context !== 'subagent',
          transport_liveness: 'sse_ping',
        });
      }

      requestStage = 'request_trace';
      await writeWebToolTrace(
        requestId,
        'client_request',
        'claude_code_to_proxy',
        { method: req.method, path: url.pathname, messages_path: messagesPath },
        { headers: req.headers, body: original },
      );
      // clientSessionId resolved before Agent-context binding so child requests can reuse Parent handoff metadata.
      const toolResultContinuation = messagesPath === '/v1/messages' && isToolResultContinuation(original.messages);
      if (messagesPath === '/v1/messages') {
        releaseRuntimeRequest = runtimeTelemetry.beginRequest({ requestId, sessionId: clientSessionId, agentContext: claudeAgentRequestContext?.context || 'main' });
      }
      const webFetchProcessorChild = messagesPath === '/v1/messages'
        ? parseClaudeCodeWebFetchProcessorChild(original)
        : null;
      if (webFetchProcessorChild) {
        const pending = clientWebToolLifecycleRegistry.claimLatestWebFetch(clientSessionId, { prompt: webFetchProcessorChild.prompt });
        const requestedUrl = String(pending?.input?.url || '');
        const processed = await processWebFetchContent({
          requested_url: requestedUrl,
          final_url: requestedUrl,
          status: 200,
          title: '',
          content_type: 'text/html',
          retrieved_at: new Date().toISOString(),
          browser_rendered: true,
          markdown: webFetchProcessorChild.sourceText,
          truncated: false,
          warnings: [],
        }, {
          prompt: webFetchProcessorChild.prompt,
          model: original.model || '',
          language: config.responseLanguage,
          processor: config.webFetchProcessor || {},
          signal: abortController.signal,
          acquireProcessor: (options) => admission.acquireWebFetchProcessor(options),
          onEvent: (event, fields) => log(
            config,
            event.endsWith('_fallback') ? 'warn' : 'info',
            event,
            { requestId, child_request: true, ...fields },
          ),
        });
        const childResponse = syntheticTextResponse(original.model, processed.result);
        log(config, 'info', 'web_fetch_processor_child_completed', {
          requestId,
          correlated_tool_use_id: pending?.tool_use_id || '',
          source_chars: webFetchProcessorChild.sourceText.length,
          output_chars: processed.result.length,
        });
        await writeWebToolTrace(
          requestId,
          'web_fetch_processor_child_response',
          'proxy_to_claude_code',
          { correlated_tool_use_id: pending?.tool_use_id || '', stream: original.stream === true },
          { response: childResponse },
        );
        if (original.stream === true) {
          progress = progressStreamFactory(res, {
            model: original.model || 'proxy',
            initialUsage: usageFromTokenCount({}),
            pingIntervalMs: config.progressPingIntervalMs,
            heartbeatIntervalMs: config.progressHeartbeatMs,
            drainTimeoutMs: config.sseDrainTimeoutMs,
            visibleAfterMs: config.progressVisibleAfterMs,
            visibleProgressEnabled: claudeAgentRequestContext?.context !== 'subagent',
            locale: config.responseLanguage,
            onWrite: observeProgressWrite,
          });
          await progress.open();
          observeAgentHandoff(childResponse);
          await emitFinalAnthropicResponse(progress, childResponse, { locale: config.responseLanguage });
        } else {
          observeAgentHandoff(childResponse);
          sendJson(res, 200, childResponse);
        }
        completed = true;
        return;
      }
      const returnedDiagnosticResults = webToolDiagnosticController.findReturnedToolResults(original.messages);
      if (returnedDiagnosticResults.length > 0) {
        await writeWebToolTrace(
          requestId,
          'client_tool_result_returned',
          'claude_code_to_proxy',
          { result_count: returnedDiagnosticResults.length },
          { results: returnedDiagnosticResults },
        );
      }

      requestStage = 'protocol_inventory';
      const incomingSystemProtocolInventory = inventoryProtocolTags(original.system);
      const incomingMessageProtocolInventory = inventoryProtocolTags(original.messages);
      const incomingToolProtocolInventory = inventoryProtocolTags(original.tools);
      const incomingProtocolInventory = {
        total: incomingSystemProtocolInventory.total + incomingMessageProtocolInventory.total + incomingToolProtocolInventory.total,
        counts: Object.fromEntries(
          [...new Set([
            ...Object.keys(incomingSystemProtocolInventory.counts),
            ...Object.keys(incomingMessageProtocolInventory.counts),
            ...Object.keys(incomingToolProtocolInventory.counts),
          ])]
            .sort()
            .map((name) => [
              name,
              (incomingSystemProtocolInventory.counts[name] || 0)
                + (incomingMessageProtocolInventory.counts[name] || 0)
                + (incomingToolProtocolInventory.counts[name] || 0),
            ]),
        ),
      };
      let requestRewritten = false;
      let historyRewritten = false;
      let cleanedMessages = original.messages;
      if (hasProgressHistory(cleanedMessages)) {
        cleanedMessages = stripProgressHistory(cleanedMessages);
        historyRewritten = true;
      }
      const protocolHistory = sanitizeProtocolHistory(cleanedMessages);
      if (protocolHistory.changed) {
        cleanedMessages = protocolHistory.messages;
        historyRewritten = true;
        log(config, 'warn', 'protocol_history_sanitized', {
          requestId,
          tag_count: protocolHistory.tags.length,
          tags: [...new Set(protocolHistory.tags.map((tag) => tag.replace(/[<>/]/g, '').split(/[=\s]/)[0].toLowerCase()))],
        });
      }
      if (messagesPath === '/v1/messages') {
        const enrichedFetchResults = await enrichReturnedWebFetchResults(cleanedMessages, {
          sessionId: clientSessionId, model: original.model || '', signal: abortController.signal, requestId,
        });
        if (enrichedFetchResults.changed) {
          cleanedMessages = enrichedFetchResults.messages;
          historyRewritten = true;
          log(config, 'info', 'web_fetch_tool_result_enriched', {
            requestId, enriched_count: enrichedFetchResults.enrichedCount,
          });
        }
      }
      if (historyRewritten) {
        original = { ...original, messages: cleanedMessages };
        requestRewritten = true;
      }

      const protocolTools = sanitizeProtocolToolDefinitions(original.tools);
      if (protocolTools.changed) {
        original = { ...original, tools: protocolTools.tools };
        requestRewritten = true;
        log(config, 'warn', 'protocol_tool_descriptions_sanitized', {
          requestId,
          tag_count: protocolTools.tags.length,
          tags: [...new Set(protocolTools.tags.map((tag) => tag.replace(/[<>/]/g, '').split(/[=\s]/)[0].toLowerCase()))],
        });
      }

      const compactClassification = messagesPath === '/v1/messages'
        ? classifyClaudeCodeCompactRequest(original)
        : { compact: false, family: null, anchor: null };
      if (compactClassification.compact) {
        runtimeTelemetry.updateRequest(requestId, {
          phase: 'compact',
          detail: config.contextCompact?.model || original.model || '',
        });
        const compactRequest = prepareClaudeCodeCompactRequest(original);
        const removedToolCount = Array.isArray(original.tools) ? original.tools.length : 0;
        const externalCompactEnabled = Boolean(config.contextCompact?.enabled);
        log(config, 'info', 'context_compact_request_detected', {
          requestId,
          family: compactClassification.family,
          anchor: compactClassification.anchor,
          model: original.model || '',
          stream: original.stream === true,
          removed_tool_count: removedToolCount,
          external_backend_enabled: externalCompactEnabled,
          ...(externalCompactEnabled ? {
            compact_provider: config.contextCompact.provider,
            compact_model: config.contextCompact.model,
            compact_think: Boolean(config.contextCompact.think),
          } : {}),
        });

        if (externalCompactEnabled) {
          log(config, 'info', 'route_decision', {
            requestId, method: req.method, path: url.pathname,
            decision: 'context_compact_external',
            reason: 'claude_code_context_compact',
            provider: config.contextCompact.provider,
          });
          if (original.stream === true) {
            compactLiveness = await openContextCompactLiveness(res, {
              pingIntervalMs: config.progressPingIntervalMs || 5000,
              drainTimeoutMs: config.sseDrainTimeoutMs || 0,
              onEvent: async (event, fields) => log(
                config,
                event === 'context_compact_client_ping' ? 'debug' : 'info',
                event,
                { requestId, ...fields },
              ),
            });
          }
          let compactResult = null;
          try {
            compactResult = await runContextCompact(compactRequest, {
              config: config.contextCompact,
              signal: abortController.signal,
              onEvent: async (event, fields) => log(config, 'info', event, { requestId, ...fields }),
            });
          } catch (error) {
            if (abortController.signal.aborted) throw error;
            log(config, 'warn', 'context_compact_backend_fallback', {
              requestId,
              provider: config.contextCompact.provider,
              model: config.contextCompact.model,
              reason: error?.compactReason || String(error?.code || 'compact_backend_error'),
            });
          }
          if (compactResult) {
            await compactLiveness?.stop('external_compact_complete');
            compactLiveness = null;
            await sendContextCompactResult(res, original, compactResult.summary, {
              drainTimeoutMs: config.sseDrainTimeoutMs || 0,
            });
            completed = true;
            return;
          }
        }

        await compactLiveness?.stop('base_compact_fallback');
        compactLiveness = null;
        log(config, 'info', 'route_decision', {
          requestId, method: req.method, path: url.pathname,
          decision: 'context_compact_bypass',
          reason: externalCompactEnabled ? 'context_compact_backend_fallback' : 'claude_code_context_compact',
        });
        await forwardTransparent(req, res, config, {
          rawBody: Buffer.from(JSON.stringify(compactRequest)),
          signal: abortController.signal,
        });
        completed = true;
        return;
      }

      if (messagesPath === '/v1/messages' && clientSessionId && !toolResultContinuation) {
        const removed = mediaContinuationCache.resetSession(clientSessionId);
        if (removed > 0) {
          log(config, 'info', 'media_continuation_cache_reset', {
            requestId,
            session_id: clientSessionId,
            removed_entries: removed,
          });
        }
      }

      const maybeShowStartupBanner = async (stream) => {
        if (!stream || original?.stream !== true || !clientSessionId) return false;
        if (claudeAgentRequestContext?.context === 'subagent') return false;
        if (!runtimeTelemetry.claimBanner(clientSessionId)) return false;
        const snapshot = runtimeTelemetry.snapshot();
        const banner = formatStartupBanner({
          version: VERSION,
          snapshot,
          features: {
            compact: Boolean(config.contextCompact?.enabled),
            lang: languageProcessorAvailable(),
            vision: Boolean(config.vllmVisionUrl && config.vllmVisionModel),
          },
        });
        const shown = await stream.showStartupBanner(banner);
        if (shown) {
          log(config, 'info', 'startup_banner_shown', {
            requestId,
            session_id: clientSessionId,
            sessions: snapshot.sessions,
            active: snapshot.active,
            waiting: snapshot.waiting,
            compact_enabled: Boolean(config.contextCompact?.enabled),
            lang_enabled: languageProcessorAvailable(),
            vision_enabled: Boolean(config.vllmVisionUrl && config.vllmVisionModel),
          });
        }
        return shown;
      };

      requestStage = 'request_classification';
      const classification = classifyMessagesRequest(original);
      const initiallyManaged = messagesPath === '/v1/messages/count_tokens'
        ? classification.mediaCount.documents + classification.mediaCount.images > 0
          || classification.reasons.includes('native_web_tool')
        : classification.managed;

      if (initiallyManaged) {
        log(config, 'info', 'incoming_protocol_inventory', {
          requestId,
          tag_count: incomingProtocolInventory.total,
          tag_counts: incomingProtocolInventory.counts,
          system_tag_count: incomingSystemProtocolInventory.total,
          system_tag_counts: incomingSystemProtocolInventory.counts,
          message_tag_count: incomingMessageProtocolInventory.total,
          message_tag_counts: incomingMessageProtocolInventory.counts,
          tool_tag_count: incomingToolProtocolInventory.total,
          tool_tag_counts: incomingToolProtocolInventory.counts,
        });
      }

      if (!initiallyManaged) {
        if (messagesPath === '/v1/messages/count_tokens') {
          if (requestRewritten) {
            log(config, 'info', 'route_decision', {
              requestId, method: req.method, path: url.pathname,
              decision: 'protocol_sanitize',
              reason: historyRewritten ? 'malformed_protocol_history' : 'tool_description_protocol_tags',
            });
            const payload = await callUpstreamJson(original, config, req.headers, abortController.signal, messagesPath);
            completed = true;
            return sendJson(res, 200, payload);
          }
          log(config, 'info', 'route_decision', { requestId, method: req.method, path: url.pathname, decision: 'bypass', reason: 'plain_count_tokens' });
          await forwardTransparent(req, res, config, { rawBody, signal: abortController.signal });
          completed = true;
          return;
        }

        log(config, 'info', 'route_decision', {
          requestId, method: req.method, path: url.pathname,
          decision: 'final_language_gate',
          reason: requestRewritten ? 'sanitized_plain_anthropic_request' : 'plain_anthropic_request',
          response_language: config.responseLanguage || 'en-US',
        });
        if (original.stream === true) {
          progress = progressStreamFactory(res, {
            model: original.model || 'vllm',
            initialUsage: usageFromTokenCount({}),
            pingIntervalMs: config.progressPingIntervalMs,
            heartbeatIntervalMs: config.progressHeartbeatMs,
            drainTimeoutMs: config.sseDrainTimeoutMs,
            visibleAfterMs: config.progressVisibleAfterMs,
            visibleProgressEnabled: claudeAgentRequestContext?.context !== 'subagent',
            locale: config.responseLanguage,
            getReceivedBytes: getBaseResponseBytes,
            onWrite: observeProgressWrite,
          });
          await progress.open();
          await maybeShowStartupBanner(progress);
          const directStartedAt = Date.now();
          modelRoundProgress.active = true;
          modelRoundProgress.round = 1;
          modelRoundProgress.lane = 'direct';
          modelRoundProgress.startedAt = directStartedAt;
          modelRoundProgress.startBytes = baseResponseBytes;
          modelRoundProgress.startModelBytes = modelOutputBytes;
          modelRoundProgress.firstByteNotified = false;
          modelRoundProgress.firstSemanticDeltaNotified = false;
          modelRoundProgress.phase = 'waiting';
          runtimeTelemetry.beginModelRound(requestId, { round: 1, startedAt: directStartedAt });
          runtimeTelemetry.updateRequest(requestId, { phase: 'waiting', detail: '' });
          await progress.update(statusText(config.responseLanguage, 'modelPlanning'), {
            details: { phase: 'managed_model_round_start', round: 1 },
          });
          progress.startSemanticHeartbeat(() => statusText(
            config.responseLanguage,
            'modelHeartbeat',
            sampleModelHeartbeat(),
          ));
          let response = await callUpstreamManagedStream(
            original, config, req.headers, abortController.signal, '/v1/messages', {
              onResponseChunk: onBaseResponseChunk,
              onStreamPhase: onManagedModelStreamPhase,
              onSemanticDelta: onModelSemanticDelta,
              onBusyEvent: onBaseBusyEvent,
              onResponseMode: onBaseResponseMode,
            },
          );
          response = observeServerResponseCapabilities(response, 'direct_stream');
          runtimeTelemetry.endModelRound(requestId, { endedAt: Date.now() });
          modelRoundProgress.active = false;
          response = await applyFinalPresentationLanguage(response, original);
          progress.stopSemanticHeartbeat();
          observeAgentHandoff(response);
          await emitFinalAnthropicResponse(progress, response, { locale: config.responseLanguage });
        } else {
          let response = await callUpstreamJson(original, config, req.headers, abortController.signal, '/v1/messages', { onBusyEvent: onBaseBusyEvent });
          response = observeServerResponseCapabilities(response, 'direct_json');
          response = await applyFinalPresentationLanguage(response, original);
          observeAgentHandoff(response);
          sendJson(res, 200, response);
        }
        completed = true;
        return;
      }

      requestStage = 'managed_bridge';
      validateMessagesRequest(original);
      const serverWebUiDeclaration = detectServerWebUiDeclaration(original);
      const normalizedWebTools = normalizeNativeWebToolsRequest({ ...original, messages: cleanedMessages });
      const localToolSearchPrepared = prepareLocalToolSearchRequest(normalizedWebTools.request);
      let request = localToolSearchPrepared.request;
      const managedWebPolicyEnforcer = createManagedWebPolicyEnforcer(normalizedWebTools.policies);
      if (normalizedWebTools.changed) {
        log(config, 'info', 'native_web_tools_normalized', {
          requestId,
          native_tool_count: normalizedWebTools.nativeToolCount,
          policy_tools: Object.keys(normalizedWebTools.policies).sort(),
          has_max_uses: Object.values(normalizedWebTools.policies).some((policy) => Number.isInteger(policy.maxUses)),
          has_domain_policy: Object.values(normalizedWebTools.policies).some((policy) => policy.allowedDomains.length || policy.blockedDomains.length),
          unsupported_field_count: Object.values(normalizedWebTools.policies)
            .reduce((total, policy) => total + policy.unsupportedFields.length, 0),
          forced_tool_choice: normalizedWebTools.forcedNativeSearchChoice,
        });
      }
      if (localToolSearchPrepared.changed) {
        log(config, 'info', 'local_tool_search_catalog_prepared', {
          requestId,
          ...localToolSearchStateSnapshot(localToolSearchPrepared.state),
          visible_tool_count: Array.isArray(request.tools) ? request.tools.length : 0,
          execution_mode: 'local_bridge',
        });
      }
      const usagePreflightRequest = request.stream === true
        ? { ...request, messages: request.messages }
        : null;
      const hasMedia = classification.mediaCount.documents + classification.mediaCount.images > 0;
      const hasManagedTools = classification.reasons.includes('managed_web_tool') && messagesPath === '/v1/messages';
      const hasLocalToolSearch = Boolean(localToolSearchPrepared.state?.enabled) && messagesPath === '/v1/messages';
      const hasManagedLoop = hasManagedTools || hasLocalToolSearch;
      const passthroughClientWebTools = hasManagedTools
        && serverWebUiDeclaration.native_count === 0
        && serverWebUiDeclaration.alias_count > 0;
      const nativeWebSearchFastLane = hasManagedTools
        && normalizedWebTools.forcedNativeSearchChoice === true
        && serverWebUiDeclaration.native_count === 1
        && serverWebUiDeclaration.search === true
        && serverWebUiDeclaration.fetch === false;
      if (hasManagedTools) {
        log(config, 'info', 'server_web_ui_bridge_selected', {
          requestId,
          mode: passthroughClientWebTools
            ? 'claude_code_client_tool'
            : request.stream === true && serverWebUiDeclaration.native_count > 0
              ? 'native_server_tool'
              : 'visible_progress',
          native_declaration_count: serverWebUiDeclaration.native_count,
          alias_declaration_count: serverWebUiDeclaration.alias_count,
          search: serverWebUiDeclaration.search,
          fetch: serverWebUiDeclaration.fetch,
        });
      }

      if (messagesPath === '/v1/messages/count_tokens' && !hasMedia) {
        log(config, 'info', 'route_decision', {
          requestId,
          method: req.method,
          path: url.pathname,
          decision: 'native_web_tool_normalization',
          reason: 'count_tokens_schema_compatibility',
        });
        const payload = await callUpstreamJson(request, config, req.headers, abortController.signal, messagesPath);
        completed = true;
        return sendJson(res, 200, payload);
      }

      const preloadedCache = new Map();
      let allMediaCached = false;
      let nativeVisionEligibleCount = 0;
      let nativeVisionFallbackRequest = null;
      let nativeVisionProbeUsage = null;
      let nativeVisionProbePayload = null;

      if (hasMedia) {
        requestStage = 'media_observation';
        const imagePayloadObservations = observeImagePayloads(request.messages);
        const imageObservationByPath = new Map(imagePayloadObservations.map((entry) => [JSON.stringify(entry.path), entry]));
        await cacheReady;
        requestStage = 'media_preflight';
        preparedMedia = await prepareMediaHandles(request.messages, config.limits, {
          signal: abortController.signal,
          cacheKeyContext: {
            pipelineVersion: config.cache?.pipelineVersion,
            visualPromptVersion: config.cache?.visualPromptVersion,
            evidenceContractVersion: config.cache?.evidenceContractVersion,
            visionModel: config.vllmVisionModel,
            visionProvider: config.vllmVisionProvider,
            visionApiProtocol: config.vllmVisionApiProtocol,
            visionThink: config.vllmVisionThink,
            resourceProfile: config.resourceProfile,
          },
        });
        request.messages = preparedMedia.messages;
        requestStage = 'media_progress';
        mediaProgress = createMediaProgressTracker(request.messages, { locale: config.responseLanguage });
        const nativeVisionEligible = config.vllmBaseVisionEnabled === true && config.visionNativePassthrough === true
          ? mediaProgress.descriptors.filter((entry) => entry.kind === 'image' && ['direct_image', 'read_image'].includes(entry.sourceKind))
          : [];
        nativeVisionEligibleCount = nativeVisionEligible.length;
        if (nativeVisionEligibleCount > 0) {
          nativeVisionFallbackRequest = { ...request, messages: structuredClone(request.messages) };
          log(config, 'info', 'native_vision_route_selected', {
            requestId,
            eligible_image_count: nativeVisionEligibleCount,
            source_kinds: [...new Set(nativeVisionEligible.map((entry) => entry.sourceKind))].sort(),
            base_vision_enabled: true,
            native_passthrough_enabled: true,
          });
        }
        const mediaOccurrences = preparedMedia.mediaOccurrences || preparedMedia.mediaEntries.map((entry) => ({ ...entry, path: [] }));
        for (const occurrence of mediaOccurrences) {
          if (!String(occurrence.mediaType || '').startsWith('image/')) continue;
          const observed = imageObservationByPath.get(JSON.stringify(occurrence.path));
          if (!observed) continue;
          log(config, 'info', 'image_payload_observed', {
            requestId,
            origin: observed.origin,
            parent_type: observed.parentType,
            tool_name: observed.toolName,
            filename: observed.filename,
            read_source_ref: observed.readSourceRef,
            source_type: observed.sourceType,
            media_type: observed.mediaType,
            decoded_bytes: occurrence.decodedBytes ?? null,
            block_keys: observed.blockKeys,
            source_keys: observed.sourceKeys,
            dimension_metadata: observed.dimensionMetadata,
            source_reference_basename: observed.sourceReferenceBasename,
            source_reference_ref: observed.sourceReferenceRef,
          });
        }
        let cachedOccurrences = 0;
        for (const occurrence of mediaOccurrences) {
          const tracked = mediaProgress.contextForPath(occurrence.path);
          const pageScope = occurrence.mediaType === 'application/pdf' ? tracked?.pageScope : null;
          const effectiveKey = occurrence.mediaType === 'application/pdf'
            ? scopePdfDocumentCacheKey(occurrence.key, pageScope)
            : scopeMediaCacheKey(occurrence.key, pageScope);
          const invalidScope = occurrence.mediaType === 'application/pdf' && Boolean(tracked?.pageScopeError);
          const isCurrentToolResultMedia = toolResultContinuation
            && Array.isArray(occurrence.path)
            && occurrence.path[0] === 'messages'
            && occurrence.path[1] === request.messages.length - 1;
          const continuationCached = !invalidScope && !isCurrentToolResultMedia && toolResultContinuation && clientSessionId
            ? mediaContinuationCache.get(clientSessionId, effectiveKey)
            : null;
          if (continuationCached?.block) {
            cachedOccurrences += 1;
            preloadedCache.set(effectiveKey, { __vccSource: 'continuation', __vccValue: continuationCached });
            log(config, 'info', 'media_continuation_cache_hit', {
              requestId,
              session_id: clientSessionId,
              cache_key_prefix: effectiveKey.slice(0, 12),
              media_type: occurrence.mediaType,
              ...(pageScope?.canonical ? { pdf_pages: pageScope.canonical } : {}),
            });
            continue;
          }
          const cached = invalidScope ? null : await mediaCache.get(effectiveKey);
          if (cached?.block) {
            cachedOccurrences += 1;
            preloadedCache.set(effectiveKey, cached);
            log(config, 'info', 'media_cache_hit', {
              requestId,
              cache_key_prefix: effectiveKey.slice(0, 12),
              media_type: occurrence.mediaType,
              ...(pageScope?.canonical ? { pdf_pages: pageScope.canonical } : {}),
            });
          } else {
            log(config, 'info', 'media_cache_miss', {
              requestId,
              cache_key_prefix: effectiveKey.slice(0, 12),
              media_type: occurrence.mediaType,
              ...(pageScope?.canonical ? { pdf_pages: pageScope.canonical } : {}),
            });
          }
        }
        allMediaCached = mediaOccurrences.length > 0 && cachedOccurrences === mediaOccurrences.length;
      }

      const needsManagedWork = hasManagedLoop || (hasMedia && (!allMediaCached || nativeVisionEligibleCount > 0));
      const adapterDependencies = {
        allowedMediaPaths: preparedMedia?.allowedPaths,
        acquireVision: (options) => admission.acquireVision(options),
        mediaCache,
        documentSourceCache,
        analysisRegistry,
        preloadedCache,
        ...(dependencies.mediaAdapterDependencies || {}),
        continuationFreshMessageIndex: toolResultContinuation ? request.messages.length - 1 : -1,
        continuationCacheWriter: (key, value) => {
          if (!clientSessionId || messagesPath !== '/v1/messages') return false;
          const stored = mediaContinuationCache.set(clientSessionId, key, value);
          if (stored) {
            log(config, 'info', 'media_continuation_cache_write', {
              requestId,
              session_id: clientSessionId,
              cache_key_prefix: String(key || '').slice(0, 12),
              persistent_cacheable: value?.cacheable !== false,
            });
          }
          return stored;
        },
        onCacheEvent: (event, fields) => log(config, event.includes('failed') ? 'warn' : 'info', event, { requestId, ...fields }),
        onDiagnostic: (event, fields) => log(config, 'warn', event, { requestId, ...fields }),
        onVisionEvent: (event, fields) => {
          if (event === 'vision_upstream_request') {
            runtimeTelemetry.updateRequest(requestId, {
              phase: 'vision',
              detail: config.vllmVisionModel || '',
            });
          }
          log(
            config,
            event === 'vision_upstream_response' && fields?.http_status !== 200 ? 'warn' : 'info',
            event,
            { requestId, ...fields },
          );
        },
        mediaProgress,
      };

      if (!needsManagedWork) {
        const adapters = createMediaAdapters(config, abortController.signal, () => {}, adapterDependencies);
        request.messages = await adaptMessages(request.messages, adapters);
        request = injectEvidenceContract(request);
        await preparedMedia?.cleanup(); preparedMedia = null;
        rawBody = null;
        original = null;
        log(config, 'info', 'route_decision', { requestId, method: req.method, path: url.pathname, decision: 'cached_transform', reason: 'all_media_cached' });
        if (messagesPath === '/v1/messages/count_tokens') {
          const payload = await callUpstreamJson(request, config, req.headers, abortController.signal, messagesPath);
          completed = true;
          return sendJson(res, 200, payload);
        }
        if (request.stream === true) {
          progress = progressStreamFactory(res, {
            model: request.model || 'vllm',
            initialUsage: usageFromTokenCount({}),
            pingIntervalMs: config.progressPingIntervalMs,
            heartbeatIntervalMs: config.progressHeartbeatMs,
            drainTimeoutMs: config.sseDrainTimeoutMs,
            visibleAfterMs: config.progressVisibleAfterMs,
            visibleProgressEnabled: claudeAgentRequestContext?.context !== 'subagent',
            locale: config.responseLanguage,
            getReceivedBytes: getBaseResponseBytes,
            onWrite: observeProgressWrite,
          });
          await progress.open();
          await maybeShowStartupBanner(progress);
          let response = await callUpstreamManagedStream(
            request, config, req.headers, abortController.signal, '/v1/messages', { onResponseChunk: onBaseResponseChunk, onBusyEvent: onBaseBusyEvent, onResponseMode: onBaseResponseMode },
          );
          response = observeServerResponseCapabilities(response, 'cached_transform_stream');
          response = await applyFinalPresentationLanguage(response, request);
          observeAgentHandoff(response);
          await emitFinalAnthropicResponse(progress, response, { locale: config.responseLanguage });
        } else {
          let response = await callUpstreamJson(request, config, req.headers, abortController.signal, '/v1/messages', { onBusyEvent: onBaseBusyEvent });
          response = observeServerResponseCapabilities(response, 'cached_transform_json');
          response = await applyFinalPresentationLanguage(response, request);
          observeAgentHandoff(response);
          sendJson(res, 200, response);
        }
        completed = true;
        return;
      }


      const deferredProgress = [];
      const onProgress = async (message, details = {}) => {
        const { force = false, ...stateDetails } = details;
        const localized = localizeProgressMessage(config.responseLanguage, message, stateDetails);
        const rendered = mediaProgress?.render(localized, stateDetails) || localized;
        log(config, 'info', 'managed_task_progress', { requestId, message: rendered, delivery_status: 'requested', ...stateDetails });
        if (progress) await progress.update(rendered, { force, details: stateDetails });
        else deferredProgress.push({ rendered, force, stateDetails });
      };

      const openManagedProgress = async (usage) => {
        if (progress) return progress;
        progress = progressStreamFactory(res, {
          model: request.model || 'vllm',
          initialUsage: usage,
          pingIntervalMs: config.progressPingIntervalMs,
          heartbeatIntervalMs: config.progressHeartbeatMs,
          drainTimeoutMs: config.sseDrainTimeoutMs,
          visibleAfterMs: config.progressVisibleAfterMs,
          visibleProgressEnabled: claudeAgentRequestContext?.context !== 'subagent',
          locale: config.responseLanguage,
          getReceivedBytes: getBaseResponseBytes,
          onStateChange: (entry) => {
            log(config, 'info', 'progress_state_changed', {
              requestId,
              revision: entry.revision,
              phase: entry.phase,
              changed_at: new Date(entry.changedAt).toISOString(),
            });
          },
          onWrite: (entry) => {
            observeProgressWrite(entry);
            if (entry.backpressure) {
              log(config, 'warn', 'progress_sse_backpressure', {
                requestId,
                kind: entry.kind,
                phase: entry.phase,
                progress_carrier: entry.carrier || 'text',
                sequence: entry.sequence,
                bytes: entry.bytes,
                waited_ms: entry.waitedMs,
              });
            }
            if (['progress_delta', 'semantic_heartbeat', 'usage_delta'].includes(entry.kind)) {
              log(config, 'info', 'progress_sse_sent', {
                requestId,
                kind: entry.kind,
                phase: entry.phase,
                progress_carrier: entry.carrier || 'text',
                sequence: entry.sequence,
                bytes: entry.bytes,
                revision: entry.revision,
                delivery_latency_ms: entry.deliveryLatencyMs,
                writable_length: res.writableLength || 0,
                upstream_received_bytes: getBaseResponseBytes(),
                round_received_bytes: modelRoundProgress.active ? getCurrentRoundResponseBytes() : null,
                model_elapsed_ms: progressTiming.mode === 'model'
                  ? Math.max(0, Date.now() - progressTiming.startedAt)
                  : null,
              });
            }
          },
        });
        await progress.open();
        await maybeShowStartupBanner(progress);
        progress.startSemanticHeartbeat(() => {
          if (progressTiming.mode === 'model') {
            return statusText(
              config.responseLanguage,
              'modelHeartbeat',
              sampleModelHeartbeat(),
            );
          }
          return mediaProgress?.renderHeartbeat({ receivedBytes: getBaseResponseBytes() })
            || statusText(config.responseLanguage, 'currentStepWaiting', {
              seconds: Math.floor((Date.now() - progressTiming.startedAt) / 1000),
            });
        });
        for (const entry of deferredProgress.splice(0)) {
          await progress.update(entry.rendered, { force: true, details: entry.stateDetails });
        }
        return progress;
      };

      let mediaProgressOpenedEarly = false;
      if (request.stream === true && hasMedia && !allMediaCached) {
        const bootstrapRequest = buildMediaUsageBootstrapRequest(request);
        const bootstrapUsage = await preflightManagedUsage(
          bootstrapRequest,
          config,
          req.headers,
          abortController.signal,
          (event, fields) => {
            log(config, event.endsWith('_failed') ? 'warn' : 'info', event, { requestId, ...fields });
          },
          {
            successEvent: 'managed_usage_bootstrap_succeeded',
            failureEvent: 'managed_usage_bootstrap_failed',
          },
        );
        await openManagedProgress(bootstrapUsage);
        mediaProgressOpenedEarly = true;
      }

      if (hasMedia) {
        requestStage = 'media_transform';
        if (!allMediaCached) await onProgress('正在處理新的文件與圖片內容…', { phase: 'media_cache_miss' });
        const adapters = createMediaAdapters(config, abortController.signal, onProgress, adapterDependencies);
        request.messages = await adaptMessages(request.messages, adapters);
        const proxyEvidenceCount = Math.max(0, (mediaProgress?.descriptors?.length || 0) - nativeVisionEligibleCount);
        if (proxyEvidenceCount > 0) request = injectEvidenceContract(request);

        if (nativeVisionEligibleCount > 0 && config.usagePreflightEnabled !== false) {
          requestStage = 'native_vision_capability_preflight';
          try {
            nativeVisionProbePayload = await callUpstreamJson(request, config, req.headers, abortController.signal, '/v1/messages/count_tokens');
            if (!Number.isInteger(nativeVisionProbePayload?.input_tokens) || nativeVisionProbePayload.input_tokens < 0) {
              throw new HttpError(502, 'Token count response did not contain input_tokens.', {
                code: 'vllm_invalid_token_count', retryable: true,
              });
            }
            nativeVisionProbeUsage = usageFromTokenCount(nativeVisionProbePayload);
            log(config, 'info', 'native_vision_base_probe_succeeded', {
              requestId,
              eligible_image_count: nativeVisionEligibleCount,
              input_tokens: nativeVisionProbeUsage.input_tokens,
            });
          } catch (error) {
            if (isNativeVisionCapabilityRejection(error) && nativeVisionFallbackRequest) {
              log(config, 'warn', 'native_vision_fallback_selected', {
                requestId,
                reason: 'base_image_capability_rejected',
                status: error.status,
                code: error.code,
                eligible_image_count: nativeVisionEligibleCount,
              });
              const fallbackConfig = { ...config, visionNativePassthrough: false };
              const fallbackAdapters = createMediaAdapters(fallbackConfig, abortController.signal, onProgress, adapterDependencies);
              request = { ...nativeVisionFallbackRequest, messages: await adaptMessages(nativeVisionFallbackRequest.messages, fallbackAdapters) };
              request = injectEvidenceContract(request);
              nativeVisionEligibleCount = 0;
              nativeVisionProbeUsage = null;
              nativeVisionProbePayload = null;
            } else {
              log(config, error?.retryable ? 'warn' : 'info', 'native_vision_base_probe_failed', {
                requestId,
                code: error?.code || 'native_vision_probe_failed',
                status: error?.status || null,
                retryable: Boolean(error?.retryable),
                fallback: false,
              });
            }
          }
        }

        await preparedMedia.cleanup(); preparedMedia = null;
        const readyMessage = mediaProgress?.renderMediaReady()
          || statusText(config.responseLanguage, 'mediaReady');
        log(config, 'info', 'managed_task_progress', { requestId, message: readyMessage, delivery_status: 'requested', phase: 'media_ready' });
      }

      if (request.stream === true) {
        requestStage = 'managed_usage_preflight';
        if (nativeVisionProbeUsage) {
          initialStreamUsage = nativeVisionProbeUsage;
          log(config, 'info', 'managed_usage_preflight_succeeded', {
            requestId,
            input_tokens: initialStreamUsage.input_tokens,
            cache_creation_input_tokens: initialStreamUsage.cache_creation_input_tokens || 0,
            cache_read_input_tokens: initialStreamUsage.cache_read_input_tokens || 0,
            total_input_tokens: totalAnthropicInputTokens(initialStreamUsage),
            source: 'native_vision_capability_preflight',
          });
        } else {
          initialStreamUsage = await preflightManagedUsage(
            request,
            config,
            req.headers,
            abortController.signal,
            (event, fields) => {
              log(config, event.endsWith('_failed') ? 'warn' : 'info', event, { requestId, ...fields });
            },
          );
        }
        if (!progress) await openManagedProgress(initialStreamUsage);
        else if (mediaProgressOpenedEarly) {
          await progress.updateUsage(initialStreamUsage, { phase: 'media_usage_exact' });
        }
      }

      if (hasMedia) {
        const readyMessage = mediaProgress?.renderMediaReady()
          || statusText(config.responseLanguage, 'mediaReady');
        await progress?.update(readyMessage, { details: { phase: 'media_ready' } });
      }

      rawBody = null;
      original = null;

      const inputTokens = totalAnthropicInputTokens(initialStreamUsage);
      const lane = nativeWebSearchFastLane ? 'native_web_search' : hasLocalToolSearch && !hasManagedTools ? 'tool_search' : 'managed';
      log(config, 'info', 'managed_request_started', {
        requestId,
        lane,
        input_tokens: inputTokens,
        independent_connection: true,
      });

      if (messagesPath === '/v1/messages/count_tokens') {
        const payload = nativeVisionProbePayload || await callUpstreamJson(request, config, req.headers, abortController.signal, messagesPath);
        completed = true;
        return sendJson(res, 200, payload);
      }

      const upstream = async (body, signal, runtimeOptions = {}) => {
        const response = await callUpstreamManagedStream(body, config, req.headers, signal, '/v1/messages', {
          onResponseChunk: onBaseResponseChunk,
          onStreamPhase: onManagedModelStreamPhase,
          onSemanticDelta: onModelSemanticDelta,
          ...(typeof runtimeOptions.onCheckpoint === 'function' ? { onCheckpoint: runtimeOptions.onCheckpoint } : {}),
          onBusyEvent: onBaseBusyEvent,
          onResponseMode: onBaseResponseMode,
        });
        return observeServerResponseCapabilities(response, 'managed_round');
      };
      const serverToolBridge = request.stream === true && progress && serverWebUiDeclaration.native_count > 0
        ? createServerToolStreamBridge(progress)
        : null;
      if (hasManagedLoop) {
        let result = await runManagedLoop(request, {
          upstream,
          executeTool: (toolUse, signal) => executeManagedTool(toolUse, config, signal, {
            model: request.model || '',
            policy: managedWebPolicyEnforcer.consume(toolUse.name),
            acquireProcessor: (options) => admission.acquireWebFetchProcessor(options),
            onEvent: (event, fields) => log(
              config,
              event.endsWith('_rejected') || event.endsWith('_fallback') ? 'warn' : 'info',
              event,
              { requestId, ...fields },
            ),
          }),
          maxRounds: config.maxToolRounds,
          taskTimeoutMs: config.managedTaskTimeoutMs,
          modelRoundTimeoutMs: config.managedModelRoundTimeoutMs || 360000,
          modelStallTimeoutMs: config.managedModelStallTimeoutMs ?? 90000,
          modelResponseMode: config.vllmBaseResponseMode || 'auto',
          getUpstreamActivity: getBaseUpstreamActivity,
          onModelRoundState: async ({ phase, round, startedAt, endedAt, startBytes }) => {
            if (phase === 'start') {
              progressTiming.mode = 'model';
              progressTiming.startedAt = startedAt;
              progressTiming.position = 0;
              modelRoundProgress.active = true;
              modelRoundProgress.round = round;
              modelRoundProgress.lane = lane;
              modelRoundProgress.startedAt = startedAt;
              modelRoundProgress.startBytes = startBytes;
              modelRoundProgress.startModelBytes = modelOutputBytes;
              modelRoundProgress.firstByteNotified = false;
              modelRoundProgress.firstSemanticDeltaNotified = false;
              modelRoundProgress.phase = 'waiting';
              runtimeTelemetry.beginModelRound(requestId, { round, startedAt });
              runtimeTelemetry.updateRequest(requestId, { phase: 'waiting', detail: '' });
              log(config, 'info', 'managed_model_round_started', { requestId, lane, round, start_bytes: startBytes });
            } else {
              const completedModelOutputBytes = getCurrentRoundResponseBytes();
              runtimeTelemetry.endModelRound(requestId, { endedAt: endedAt || Date.now() });
              modelRoundProgress.active = false;
              progressTiming.mode = 'step';
              progressTiming.startedAt = endedAt || Date.now();
              log(config, 'info', 'managed_model_round_completed', {
                requestId, lane, round, elapsed_ms: (endedAt || Date.now()) - startedAt,
                wire_received_bytes: getBaseResponseBytes(),
                model_output_bytes: completedModelOutputBytes,
              });
            }
          },
          locale: config.responseLanguage,
          releaseForcedManagedToolChoiceAfterUse: normalizedWebTools.forcedNativeSearchChoice,
          onProgress,
          onServerToolEvent: serverToolBridge ? (event) => serverToolBridge.emit(event) : null,
          materializeServerToolBlocks: !serverToolBridge,
          onDiagnostic: (event, fields) => log(config, diagnosticLogLevel(event), event, { requestId, ...fields }),
          showInitialModelProgress: hasMedia,
          logProtocolSnippets: Boolean(config.logProtocolSnippets),
          writeProtocolDiagnostics: protocolDiagnosticStore
            ? (bundle) => protocolDiagnosticStore.write({ request_id: requestId, ...bundle })
            : undefined,
          diagnosticPassthroughWebTools: webToolDiagnosticConfig.enabled
            ? (context) => webToolDiagnosticController.decide(context)
            : undefined,
          passthroughManagedWebTools: passthroughClientWebTools,
          localToolSearch: localToolSearchPrepared.state,
          onManagedWebToolHandoff: ({ toolUses }) => {
            clientWebToolLifecycleRegistry.recordToolUses(clientSessionId, toolUses);
          },
          compressContinuationWindow: webFetchProcessorAvailable()
            ? (window, { signal: compressionSignal } = {}) => compressContinuationWindowWithExternalProcessor(window, {
              processor: config.webFetchProcessor,
              signal: compressionSignal || abortController.signal,
              acquireProcessor: (options) => admission.acquireWebFetchProcessor(options),
              onEvent: (event, fields) => log(
                config,
                event.endsWith('_failed') ? 'warn' : 'info',
                event,
                { requestId, ...fields },
              ),
            })
            : undefined,
          onTrace: webToolDiagnosticTraceStore
            ? async (event, payload) => writeWebToolTrace(
              requestId,
              event,
              event === 'base_model_request'
                ? 'proxy_to_base_model'
                : event === 'base_model_response'
                  ? 'base_model_to_proxy'
                  : 'proxy_internal',
              { managed: true },
              payload,
            )
            : undefined,
          signal: abortController.signal,
        });
        if (!nativeWebSearchFastLane) {
          result = await applyFinalPresentationLanguage(result, request);
        }
        await writeWebToolTrace(
          requestId,
          'proxy_response',
          'proxy_to_claude_code',
          { stream: request.stream === true, managed: true },
          { response: result, diagnostic_state: webToolDiagnosticController.snapshot() },
        );
        if (request.stream === true) {
          const observedUsage = normalizeAnthropicUsage(result?.usage);
          log(config, 'info', 'managed_response_usage_observed', {
            requestId,
            preflight_input_tokens: totalAnthropicInputTokens(initialStreamUsage),
            upstream_input_tokens: totalAnthropicInputTokens(observedUsage),
            input_token_delta: totalAnthropicInputTokens(observedUsage)
              - totalAnthropicInputTokens(initialStreamUsage),
            output_tokens: observedUsage.output_tokens || 0,
          });
          observeAgentHandoff(result);
          await emitFinalAnthropicResponse(progress, result, { startIndex: serverToolBridge?.nextIndex, locale: config.responseLanguage });
        } else {
          observeAgentHandoff(result);
          sendJson(res, 200, result);
        }
      } else {
        if (request.stream === true) {
          progressTiming.mode = 'model';
          progressTiming.startedAt = Date.now();
          modelRoundProgress.active = true;
          modelRoundProgress.round = 1;
          modelRoundProgress.lane = lane;
          modelRoundProgress.startedAt = progressTiming.startedAt;
          modelRoundProgress.startBytes = baseResponseBytes;
          modelRoundProgress.startModelBytes = modelOutputBytes;
          modelRoundProgress.firstByteNotified = false;
          modelRoundProgress.firstSemanticDeltaNotified = false;
          modelRoundProgress.phase = 'waiting';
          runtimeTelemetry.beginModelRound(requestId, { round: 1, startedAt: progressTiming.startedAt });
          runtimeTelemetry.updateRequest(requestId, { phase: 'waiting', detail: '' });
          await onProgress(statusText(config.responseLanguage, 'baseRequestStart'), { phase: 'base_request_start' });
          let response = await collectManagedBase(request, config, req.headers, abortController.signal, {
            onResponseChunk: onBaseResponseChunk,
            onSemanticDelta: onModelSemanticDelta,
            onBusyEvent: onBaseBusyEvent,
            onUsage: ({ stage, usage }) => log(config, 'info', 'managed_stream_usage_observed', {
              requestId,
              stage,
              input_tokens: usage?.input_tokens || 0,
              cache_creation_input_tokens: usage?.cache_creation_input_tokens || 0,
              cache_read_input_tokens: usage?.cache_read_input_tokens || 0,
              output_tokens: usage?.output_tokens || 0,
              total_input_tokens: totalAnthropicInputTokens(usage || {}),
              preflight_input_tokens: totalAnthropicInputTokens(initialStreamUsage),
              input_token_delta: stage === 'message_start'
                ? totalAnthropicInputTokens(usage || {}) - totalAnthropicInputTokens(initialStreamUsage)
                : undefined,
            }),
            onLifecycle: async (event, fields) => {
              log(config, 'info', event, { requestId, ...fields });
              if (event === 'base_upstream_request_start') {
                progressTiming.mode = 'model';
                progressTiming.startedAt = Date.now();
                await onProgress('正在將內容送往主模型…', {
                  phase: 'base_request_start',
                  request_bytes: fields.request_bytes,
                  message_count: fields.message_count,
                  evidence_bytes: fields.evidence_bytes,
                });
              } else if (event === 'base_upstream_headers_received') {
                await onProgress('主模型已接受請求，正在準備輸出…', {
                  phase: 'base_headers_received',
                  status: fields.status,
                  header_wait_ms: fields.header_wait_ms,
                });
              } else if (event === 'base_upstream_first_event') {
                // Phase-specific progress is emitted by base_upstream_stream_phase.
              } else if (event === 'base_upstream_stream_phase') {
                await onManagedModelStreamPhase(fields);
              }
            },
          });
          runtimeTelemetry.endModelRound(requestId, { endedAt: Date.now() });
          modelRoundProgress.active = false;
          response = await applyFinalPresentationLanguage(response, request);
          observeAgentHandoff(response);
          await emitFinalAnthropicResponse(progress, response, { locale: config.responseLanguage });
        } else {
          let response = await callUpstreamJson(request, config, req.headers, abortController.signal, '/v1/messages', { onBusyEvent: onBaseBusyEvent });
          response = await applyFinalPresentationLanguage(response, request);
          observeAgentHandoff(response);
          sendJson(res, 200, response);
        }
      }

      completed = true;
      log(config, 'info', 'request_completed', { requestId, hasMedia, managed: hasManagedLoop });
    } catch (error) {
      if (abortController.signal.aborted && res.destroyed) return;
      const failureLevel = error?.retryable ? 'warn' : 'error';
      if (typeof error.code === 'string' && error.code.startsWith('vllm_')) {
        log(config, failureLevel, 'base_upstream_request_failed', {
          requestId,
          code: error.code,
          stage: error.details?.stage || (error.code.includes('headers') ? 'headers' : error.code.includes('body') ? 'body' : error.code.includes('connect') ? 'connect' : 'request'),
          timeout_ms: error.details?.timeout_ms,
          elapsed_ms: error.details?.elapsed_ms ?? error.details?.timeout_ms,
          cause_code: error.details?.cause_code,
        });
      }
      const errorStack = String(error?.stack || '')
        .split('\n')
        .slice(0, 8)
        .join(' | ')
        .slice(0, 4000);
      const managedTimeoutDetails = ['managed_model_timeout', 'managed_model_stall_timeout'].includes(String(error?.code || ''))
        ? {
            response_mode: String(error?.details?.response_mode || effectiveBaseResponseMode || config.vllmBaseResponseMode || 'auto'),
            idle_ms: Number(error?.details?.idle_ms || 0),
            received_bytes: Number(error?.details?.received_bytes || baseResponseBytes || 0),
            model_phase: modelRoundProgress.phase || 'waiting',
            timeout_ms: Number(error?.details?.timeout_ms || 0),
          }
        : {};
      log(config, failureLevel, 'request_failed', {
        requestId,
        method: req.method,
        path: url.pathname,
        code: error.code || 'internal_error',
        message: error.message,
        request_stage: requestStage,
        error_name: String(error?.name || 'Error'),
        ...managedTimeoutDetails,
        ...(errorStack ? { error_stack: errorStack } : {}),
      });
      if (progress) await emitSseError(progress, error);
      else if (!res.headersSent) sendError(res, error);
      else res.destroy(error);
      completed = true;
    } finally {
      try { await compactLiveness?.stop?.('request_finalize'); } catch {}
      try { await progress?.dispose?.(); } catch {}
      runtimeTelemetry.setBusy(requestId, false);
      releaseRuntimeRequest?.();
      await preparedMedia?.cleanup();
    }
  });
}
