import http from 'node:http';
import crypto from 'node:crypto';
import { HttpError, readBody, sendError, sendJson, writeChunk } from '../lib/http.js';
import { adaptMessages } from '../proxy/content-blocks.js';
import { hasProgressHistory, stripProgressHistory, ProgressStream } from '../proxy/progress.js';
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
import { forwardTransparent } from '../proxy/bypass.js';
import { prepareMediaHandles } from '../proxy/media-preflight.js';
import { injectEvidenceContract } from '../proxy/evidence-contract.js';
import { injectResponseLanguagePolicy } from '../proxy/response-language-policy.js';
import { localizeProgressMessage, statusText } from '../i18n/response-language.js';
import { inventoryProtocolTags, sanitizeProtocolHistory, sanitizeProtocolToolDefinitions } from '../proxy/protocol-sanitizer.js';
import { AdmissionController } from '../concurrency/admission-controller.js';
import { MediaCache } from '../cache/media-cache.js';
import { MediaAnalysisRegistry } from '../media/analysis-registry.js';
import { createMediaProgressTracker } from '../proxy/media-progress.js';
import { requestBaseUpstream } from './base-upstream.js';
import { VERSION } from '../version.js';
import { normalizeAnthropicUsage, totalAnthropicInputTokens, usageFromTokenCount } from '../proxy/anthropic-usage.js';
import { normalizeNativeWebToolsRequest, createManagedWebPolicyEnforcer, detectServerWebUiDeclaration, canonicalWebToolName } from '../proxy/native-web-tools.js';
import { ClientWebToolLifecycleRegistry, parseClaudeCodeWebFetchProcessorChild, webFetchResultNeedsFallback } from '../proxy/client-web-tool-lifecycle.js';
import { processWebFetchContent } from './web-fetch-processor.js';

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

async function fetchUpstream(request, config, incomingHeaders, signal, path = '/v1/messages', { onResponseChunk = null } = {}) {
  try {
    return await requestBaseUpstream(upstreamEndpoint(config.vllmBaseUrl, path), {
      method: 'POST',
      headers: upstreamHeaders(incomingHeaders, config),
      body: JSON.stringify(request),
      signal,
      onResponseChunk,
    }, config.vllmBaseTimeouts);
  } catch (error) {
    if (error instanceof HttpError || error?.name === 'AbortError') throw error;
    throw new HttpError(502, 'Base vLLM upstream is unavailable.', {
      code: 'vllm_unavailable', retryable: true,
    });
  }
}

async function callUpstreamJson(request, config, incomingHeaders, signal, path = '/v1/messages', { onResponseChunk = null } = {}) {
  const response = await fetchUpstream({ ...request, stream: false }, config, incomingHeaders, signal, path, { onResponseChunk });
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

async function callUpstreamManagedStream(request, config, incomingHeaders, signal, path = '/v1/messages', { onResponseChunk = null } = {}) {
  const response = await fetchUpstream({ ...request, stream: true }, config, incomingHeaders, signal, path, { onResponseChunk });
  if (!response.ok) {
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    throw new HttpError(response.status >= 500 ? 502 : response.status, payload?.error?.message || text || 'vLLM rejected the request.', {
      code: payload?.error?.type || 'vllm_request_failed', retryable: response.status >= 500, details: payload?.error,
    });
  }
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/event-stream')) return collectAnthropicMessageFromSse(response);

  // Compatibility fallback for upstreams that ignore stream=true and still return one JSON Message.
  // Raw body chunks are still counted by requestBaseUpstream, but live token activity requires SSE.
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch {
    throw new HttpError(502, 'vLLM returned neither Anthropic SSE nor valid JSON for a managed model round.', {
      code: 'vllm_invalid_stream', retryable: true, details: { content_type: contentType, body_prefix: text.slice(0, 1000) },
    });
  }
}


async function preflightManagedUsage(request, config, incomingHeaders, signal, onDiagnostic = () => {}) {
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
    await onDiagnostic('managed_usage_preflight_succeeded', {
      input_tokens: usage.input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      total_input_tokens: totalAnthropicInputTokens(usage),
    });
    return usage;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    await onDiagnostic('managed_usage_preflight_failed', {
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
  onDiagnostic = () => {}, onLifecycle = () => {}, onUsage = () => {}, onResponseChunk = null,
} = {}) {
  const outbound = { ...request, stream: true };
  const requestStartedAt = Date.now();
  await onLifecycle('base_upstream_request_start', {
    request_bytes: Buffer.byteLength(JSON.stringify(outbound)),
    message_count: Array.isArray(outbound.messages) ? outbound.messages.length : 0,
    evidence_bytes: evidenceByteLength(outbound.messages),
  });
  const upstream = await fetchUpstream(outbound, config, incomingHeaders, signal, '/v1/messages', { onResponseChunk });
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
    ...(config.concurrency || { managedLimit: 2, queueLimit: 12, queueTimeoutMs: 120000, visionLimit: 1 }),
    webFetchProcessorLimit: config.webFetchProcessor?.concurrency || 3,
  };
}

export function createProxyServer(config, dependencies = {}) {
  const admission = dependencies.admission || new AdmissionController(defaultConcurrency(config));
  const mediaCache = dependencies.mediaCache || new MediaCache(config.cache || { rootDir: '', maxBytes: 0 });
  const analysisRegistry = dependencies.analysisRegistry || new MediaAnalysisRegistry();
  const cacheReady = mediaCache.initialize();
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
    const outputMessages = structuredClone(Array.isArray(messages) ? messages : []);
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
    const abortController = new AbortController();
    let progress = null;
    let completed = false;
    let releaseManaged = null;
    let releaseLargeContext = null;
    let releaseIngress = null;
    let preparedMedia = null;
    let mediaProgress = null;
    let initialStreamUsage = usageFromTokenCount({});
    let baseResponseBytes = 0;
    let lastBaseResponseChunkAt = 0;
    const onBaseResponseChunk = (bytes) => {
      const value = Number(bytes);
      if (Number.isFinite(value) && value > 0) {
        baseResponseBytes += value;
        lastBaseResponseChunkAt = Date.now();
      }
    };
    const getBaseResponseBytes = () => baseResponseBytes;
    const getBaseUpstreamActivity = () => ({ receivedBytes: baseResponseBytes, lastByteAt: lastBaseResponseChunkAt });
    const progressTiming = { mode: 'initial', startedAt: Date.now(), position: 0 };
    const url = new URL(req.url || '/', 'http://localhost');

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
          managed: { active: state.managed.active, limit: state.managed.limit, queued: state.managed.queued, queue_limit: state.managed.queueLimit },
          native_web_search: { active: state.nativeWebSearch.active, limit: state.nativeWebSearch.limit, queued: state.nativeWebSearch.queued, queue_limit: state.nativeWebSearch.queueLimit },
          large_context: { active: state.largeContext.active, limit: state.largeContext.limit, queued: state.largeContext.queued, queue_limit: state.largeContext.queueLimit, threshold_tokens: 100000 },
          vision: { active: state.vision.active, limit: state.vision.limit },
          web_fetch_processor: { active: state.webFetchProcessor.active, limit: state.webFetchProcessor.limit, queued: state.webFetchProcessor.queued },
          cache: { ...cacheState, ...registryState },
        });
      }

      const messagesPath = req.method === 'POST' ? canonicalMessagesPath(url.pathname) : '';
      const isMessagesPath = Boolean(messagesPath);
      if (!isMessagesPath) {
        releaseIngress = await admission.acquireIngress({ signal: abortController.signal });
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
        releaseIngress(); releaseIngress = null;
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

      releaseIngress = await admission.acquireIngress({ signal: abortController.signal });
      let rawBody = await readBody(req, config.limits.maxRequestBytes);
      let original = parseJson(rawBody);
      if (!original) {
        releaseIngress(); releaseIngress = null;
        log(config, 'info', 'route_decision', { requestId, method: req.method, path: url.pathname, decision: 'bypass', reason: 'invalid_json_passthrough' });
        await forwardTransparent(req, res, config, { rawBody, signal: abortController.signal });
        completed = true;
        return;
      }

      await writeWebToolTrace(
        requestId,
        'client_request',
        'claude_code_to_proxy',
        { method: req.method, path: url.pathname, messages_path: messagesPath },
        { headers: req.headers, body: original },
      );
      const clientSessionId = claudeCodeSessionId(req.headers, original);
      const webFetchProcessorChild = messagesPath === '/v1/messages'
        ? parseClaudeCodeWebFetchProcessorChild(original)
        : null;
      if (webFetchProcessorChild) {
        const pending = clientWebToolLifecycleRegistry.claimLatestWebFetch(clientSessionId, { prompt: webFetchProcessorChild.prompt });
        const requestedUrl = String(pending?.input?.url || '');
        releaseIngress(); releaseIngress = null;
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
          progress = new ProgressStream(res, {
            model: original.model || 'proxy',
            initialUsage: usageFromTokenCount({}),
            pingIntervalMs: config.progressPingIntervalMs,
            heartbeatIntervalMs: config.progressHeartbeatMs,
            drainTimeoutMs: config.sseDrainTimeoutMs,
            visibleAfterMs: config.progressVisibleAfterMs,
            locale: config.responseLanguage,
          });
          await progress.open();
          await emitFinalAnthropicResponse(progress, childResponse, { locale: config.responseLanguage });
        } else {
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

      const languagePolicy = injectResponseLanguagePolicy(original, config.responseLanguage);
      if (languagePolicy.changed) {
        original = languagePolicy.request;
        requestRewritten = true;
      }

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
        releaseIngress(); releaseIngress = null;
        if (requestRewritten) {
          log(config, 'info', 'route_decision', {
            requestId, method: req.method, path: url.pathname,
            decision: historyRewritten || protocolTools.changed ? 'protocol_sanitize' : 'response_language_policy',
            reason: historyRewritten
              ? 'malformed_protocol_history'
              : protocolTools.changed
                ? 'tool_description_protocol_tags'
                : 'model_response_language',
            response_language: config.responseLanguage || 'en-US',
          });
          if (messagesPath === '/v1/messages/count_tokens') {
            const payload = await callUpstreamJson(original, config, req.headers, abortController.signal, messagesPath);
            completed = true;
            return sendJson(res, 200, payload);
          }
          if (original.stream === true) await streamTransformedBase(original, res, config, req.headers, abortController.signal);
          else sendJson(res, 200, await callUpstreamJson(original, config, req.headers, abortController.signal));
          completed = true;
          return;
        }
        log(config, 'info', 'route_decision', { requestId, method: req.method, path: url.pathname, decision: 'bypass', reason: 'plain_anthropic_request' });
        await forwardTransparent(req, res, config, { rawBody, signal: abortController.signal });
        completed = true;
        return;
      }

      validateMessagesRequest(original);
      const serverWebUiDeclaration = detectServerWebUiDeclaration(original);
      const normalizedWebTools = normalizeNativeWebToolsRequest({ ...original, messages: cleanedMessages });
      let request = normalizedWebTools.request;
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
      const usagePreflightRequest = request.stream === true
        ? { ...request, messages: request.messages }
        : null;
      const hasMedia = classification.mediaCount.documents + classification.mediaCount.images > 0;
      const hasManagedTools = classification.reasons.includes('managed_web_tool') && messagesPath === '/v1/messages';
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
        releaseIngress(); releaseIngress = null;
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

      if (hasMedia) {
        await cacheReady;
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
        mediaProgress = createMediaProgressTracker(request.messages, { locale: config.responseLanguage });
        for (const entry of preparedMedia.mediaEntries) {
          const cached = await mediaCache.get(entry.key);
          if (cached?.block) {
            preloadedCache.set(entry.key, cached);
            log(config, 'info', 'media_cache_hit', { requestId, cache_key_prefix: entry.key.slice(0, 12), media_type: entry.mediaType });
          } else {
            log(config, 'info', 'media_cache_miss', { requestId, cache_key_prefix: entry.key.slice(0, 12), media_type: entry.mediaType });
          }
        }
        allMediaCached = preparedMedia.mediaEntries.length > 0 && preloadedCache.size === preparedMedia.mediaEntries.length;
      }

      const needsManagedWork = hasManagedTools || (hasMedia && !allMediaCached);
      const adapterDependencies = {
        allowedMediaPaths: preparedMedia?.allowedPaths,
        acquireVision: (options) => admission.acquireVision(options),
        mediaCache,
        analysisRegistry,
        preloadedCache,
        ...(dependencies.mediaAdapterDependencies || {}),
        onCacheEvent: (event, fields) => log(config, event.includes('failed') ? 'warn' : 'info', event, { requestId, ...fields }),
        onDiagnostic: (event, fields) => log(config, 'warn', event, { requestId, ...fields }),
        mediaProgress,
      };

      if (!needsManagedWork) {
        const adapters = createMediaAdapters(config, abortController.signal, () => {}, adapterDependencies);
        request.messages = await adaptMessages(request.messages, adapters);
        request = injectEvidenceContract(request);
        await preparedMedia?.cleanup(); preparedMedia = null;
        rawBody = null;
        original = null;
        releaseIngress(); releaseIngress = null;
        log(config, 'info', 'route_decision', { requestId, method: req.method, path: url.pathname, decision: 'cached_transform', reason: 'all_media_cached' });
        if (messagesPath === '/v1/messages/count_tokens') {
          const payload = await callUpstreamJson(request, config, req.headers, abortController.signal, messagesPath);
          completed = true;
          return sendJson(res, 200, payload);
        }
        if (request.stream === true) await streamTransformedBase(request, res, config, req.headers, abortController.signal);
        else sendJson(res, 200, await callUpstreamJson(request, config, req.headers, abortController.signal));
        completed = true;
        return;
      }

      const laneCanAccept = nativeWebSearchFastLane
        ? admission.canAcceptNativeWebSearch()
        : admission.canAcceptManaged();
      if (!laneCanAccept) {
        throw new HttpError(429, 'Proxy managed-task queue is full.', { code: 'proxy_queue_full', retryable: true });
      }

      if (request.stream === true) {
        initialStreamUsage = await preflightManagedUsage(
          usagePreflightRequest || request,
          config,
          req.headers,
          abortController.signal,
          (event, fields) => {
            log(config, event.endsWith('_failed') ? 'warn' : 'info', event, { requestId, ...fields });
          },
        );
        progress = new ProgressStream(res, {
          model: request.model || 'vllm',
          initialUsage: initialStreamUsage,
          pingIntervalMs: config.progressPingIntervalMs,
          heartbeatIntervalMs: config.progressHeartbeatMs,
          drainTimeoutMs: config.sseDrainTimeoutMs,
          visibleAfterMs: config.progressVisibleAfterMs,
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
            if (entry.backpressure) {
              log(config, 'warn', 'progress_sse_backpressure', {
                requestId,
                kind: entry.kind,
                phase: entry.phase,
                sequence: entry.sequence,
                bytes: entry.bytes,
                waited_ms: entry.waitedMs,
              });
            }
            if (['progress_delta', 'semantic_heartbeat'].includes(entry.kind)) {
              log(config, 'info', 'progress_sse_sent', {
                requestId,
                kind: entry.kind,
                phase: entry.phase,
                sequence: entry.sequence,
                bytes: entry.bytes,
                revision: entry.revision,
                delivery_latency_ms: entry.deliveryLatencyMs,
                writable_length: res.writableLength || 0,
              });
            }
          },
        });
        await progress.open();
        progress.startSemanticHeartbeat(() => {
          if (progressTiming.mode === 'queue') {
            return statusText(config.responseLanguage, 'queueWait', {
              position: progressTiming.position,
              seconds: Math.floor((Date.now() - progressTiming.startedAt) / 1000),
            });
          }
          if (progressTiming.mode === 'model') {
            return statusText(config.responseLanguage, 'modelWaiting', {
              seconds: Math.floor((Date.now() - progressTiming.startedAt) / 1000),
              receivedBytes: getBaseResponseBytes(),
            });
          }
          return mediaProgress?.renderHeartbeat({ receivedBytes: getBaseResponseBytes() })
            || statusText(config.responseLanguage, 'currentStepWaiting', {
              seconds: Math.floor((Date.now() - progressTiming.startedAt) / 1000),
            });
        });
      }

      const onProgress = async (message, details = {}) => {
        const { force = false, ...stateDetails } = details;
        const localized = localizeProgressMessage(config.responseLanguage, message, stateDetails);
        const rendered = mediaProgress?.render(localized, stateDetails) || localized;
        log(config, 'info', 'managed_task_progress', { requestId, message: rendered, delivery_status: 'requested', ...stateDetails });
        await progress?.update(rendered, { force, details: stateDetails });
      };

      if (hasMedia && !allMediaCached) await onProgress('正在處理新的文件與圖片內容…', { phase: 'media_cache_miss' });
      rawBody = null;
      original = null;
      releaseIngress(); releaseIngress = null;

      const inputTokens = totalAnthropicInputTokens(initialStreamUsage);
      const isLargeContext = request.stream === true && inputTokens >= 100000 && !nativeWebSearchFastLane;
      if (isLargeContext) {
        const largeQueuedAt = Date.now();
        log(config, 'info', 'managed_request_classified', {
          requestId, class: 'large_context', input_tokens: inputTokens, threshold_tokens: 100000,
        });
        releaseLargeContext = await admission.acquireLargeContext({
          requestId,
          signal: abortController.signal,
          onPosition: (position) => {
            progressTiming.mode = 'queue';
            progressTiming.startedAt = largeQueuedAt;
            progressTiming.position = position;
            log(config, 'info', 'large_context_job_enqueued', { requestId, position, queued: admission.health().largeContext.queued });
            progress?.update(statusText(config.responseLanguage, 'queueWait', { position, seconds: Math.floor((Date.now() - largeQueuedAt) / 1000) }), { force: true, details: { phase: 'queue_wait', lane: 'large_context', position } }).catch(() => {});
          },
        });
        log(config, 'info', 'large_context_job_admitted', { requestId, queue_wait_ms: Date.now() - largeQueuedAt, input_tokens: inputTokens });
      }

      const lane = nativeWebSearchFastLane ? 'native_web_search' : 'managed';
      const laneState = nativeWebSearchFastLane ? admission.health().nativeWebSearch : admission.health().managed;
      const queuedAt = Date.now();
      const acquireLane = nativeWebSearchFastLane
        ? (options) => admission.acquireNativeWebSearch(options)
        : (options) => admission.acquireManaged(options);
      releaseManaged = await acquireLane({
        requestId,
        signal: abortController.signal,
        onPosition: (position) => {
          progressTiming.mode = 'queue';
          progressTiming.startedAt = queuedAt;
          progressTiming.position = position;
          const state = nativeWebSearchFastLane ? admission.health().nativeWebSearch : admission.health().managed;
          log(config, 'info', 'managed_job_enqueued', { requestId, lane, position, queued: state.queued });
          progress?.update(statusText(config.responseLanguage, 'queueWait', { position, seconds: Math.floor((Date.now() - queuedAt) / 1000) }), { force: true, details: { phase: 'queue_wait', lane, position } }).catch(() => {});
        },
      });
      progressTiming.mode = 'admitted';
      progressTiming.startedAt = Date.now();
      progressTiming.position = 0;
      if (laneState.active >= laneState.limit) {
        await progress?.update(statusText(config.responseLanguage, 'queueAdmitted'), { force: true, details: { phase: 'queue_admitted', lane } });
      }
      log(config, 'info', 'managed_job_admitted', { requestId, lane, queue_wait_ms: Date.now() - queuedAt, input_tokens: inputTokens });

      if (hasMedia) {
        const adapters = createMediaAdapters(config, abortController.signal, onProgress, adapterDependencies);
        request.messages = await adaptMessages(request.messages, adapters);
        request = injectEvidenceContract(request);
        await preparedMedia.cleanup(); preparedMedia = null;
        const readyMessage = mediaProgress?.renderMediaReady()
          || statusText(config.responseLanguage, 'mediaReady');
        log(config, 'info', 'managed_task_progress', { requestId, message: readyMessage, delivery_status: 'requested', phase: 'media_ready' });
        await progress?.update(readyMessage, { details: { phase: 'media_ready' } });
      }

      if (messagesPath === '/v1/messages/count_tokens') {
        releaseManaged(); releaseManaged = null;
        const payload = await callUpstreamJson(request, config, req.headers, abortController.signal, messagesPath);
        completed = true;
        return sendJson(res, 200, payload);
      }

      const upstream = (body, signal) => callUpstreamManagedStream(body, config, req.headers, signal, '/v1/messages', { onResponseChunk: onBaseResponseChunk });
      const serverToolBridge = request.stream === true && progress && serverWebUiDeclaration.native_count > 0
        ? createServerToolStreamBridge(progress)
        : null;
      if (hasManagedTools) {
        const result = await runManagedLoop(request, {
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
          modelRoundTimeoutMs: Math.min(config.managedModelRoundTimeoutMs || 360000, config.managedTaskTimeoutMs || 1800000),
          modelStallTimeoutMs: 90000,
          getUpstreamActivity: getBaseUpstreamActivity,
          onModelRoundState: async ({ phase, round, startedAt, endedAt, startBytes }) => {
            if (phase === 'start') {
              progressTiming.mode = 'model';
              progressTiming.startedAt = startedAt;
              progressTiming.position = 0;
              log(config, 'info', 'managed_model_round_started', { requestId, lane, round, start_bytes: startBytes });
            } else {
              progressTiming.mode = 'step';
              progressTiming.startedAt = endedAt || Date.now();
              log(config, 'info', 'managed_model_round_completed', { requestId, lane, round, elapsed_ms: (endedAt || Date.now()) - startedAt, received_bytes: getBaseResponseBytes() });
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
          onManagedWebToolHandoff: ({ toolUses }) => {
            clientWebToolLifecycleRegistry.recordToolUses(clientSessionId, toolUses);
          },
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
        await writeWebToolTrace(
          requestId,
          'proxy_response',
          'proxy_to_claude_code',
          { stream: request.stream === true, managed: true },
          { response: result, diagnostic_state: webToolDiagnosticController.snapshot() },
        );
        releaseManaged(); releaseManaged = null;
        releaseLargeContext?.(); releaseLargeContext = null;
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
          await emitFinalAnthropicResponse(progress, result, { startIndex: serverToolBridge?.nextIndex, locale: config.responseLanguage });
        } else sendJson(res, 200, result);
      } else {
        releaseManaged(); releaseManaged = null;
        releaseLargeContext?.(); releaseLargeContext = null;
        if (request.stream === true) {
          await streamManagedBase(progress, request, config, req.headers, abortController.signal, {
            onDiagnostic: (event, fields) => log(config, 'warn', event, { requestId, ...fields }),
            onResponseChunk: onBaseResponseChunk,
            onUsage: ({ stage, usage }) => log(config, 'info', 'managed_stream_usage_observed', {
              requestId,
              stage,
              input_tokens: usage.input_tokens || 0,
              cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
              cache_read_input_tokens: usage.cache_read_input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
              total_input_tokens: totalAnthropicInputTokens(usage),
              preflight_input_tokens: totalAnthropicInputTokens(initialStreamUsage),
              input_token_delta: stage === 'message_start'
                ? totalAnthropicInputTokens(usage) - totalAnthropicInputTokens(initialStreamUsage)
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
              }
            },
          });
        } else sendJson(res, 200, await callUpstreamJson(request, config, req.headers, abortController.signal));
      }

      completed = true;
      log(config, 'info', 'request_completed', { requestId, hasMedia, managed: hasManagedTools });
    } catch (error) {
      if (abortController.signal.aborted && res.destroyed) return;
      const failureLevel = ['proxy_queue_full', 'proxy_queue_timeout'].includes(error.code) ? 'warn' : 'error';
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
      log(config, failureLevel, 'request_failed', { requestId, method: req.method, path: url.pathname, code: error.code || 'internal_error', message: error.message });
      if (['proxy_queue_full', 'proxy_queue_timeout'].includes(error.code) && !res.headersSent) res.setHeader('retry-after', '10');
      if (progress) await emitSseError(progress, error);
      else if (!res.headersSent) sendError(res, error);
      else res.destroy(error);
      completed = true;
    } finally {
      releaseIngress?.();
      releaseManaged?.();
      releaseLargeContext?.();
      await preparedMedia?.cleanup();
    }
  });
}
