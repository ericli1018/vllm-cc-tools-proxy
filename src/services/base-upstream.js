import http from 'node:http';
import https from 'node:https';
import { HttpError } from '../lib/http.js';

function timeoutError(stage, timeoutMs) {
  const labels = {
    connect: 'connect to Base vLLM',
    headers: 'return response headers',
    body: 'send the next response body chunk',
  };
  return new HttpError(504, `Base vLLM did not ${labels[stage]} within ${timeoutMs} ms.`, {
    code: `vllm_${stage}_timeout`,
    retryable: true,
    details: { stage, timeout_ms: timeoutMs },
  });
}

function mapNetworkError(error) {
  if (error instanceof HttpError) return error;
  if (error?.name === 'AbortError') return error;
  const causeCode = String(error?.code || error?.cause?.code || '');
  const mapping = {
    ECONNREFUSED: ['vllm_connection_refused', 'Base vLLM refused the connection.'],
    ECONNRESET: ['vllm_connection_reset', 'Base vLLM reset the connection.'],
    ENETUNREACH: ['vllm_network_unreachable', 'Base vLLM network is unreachable.'],
    EHOSTUNREACH: ['vllm_network_unreachable', 'Base vLLM host is unreachable.'],
  };
  const [code, message] = mapping[causeCode] || ['vllm_unavailable', 'Base vLLM upstream is unavailable.'];
  return new HttpError(502, message, {
    code,
    retryable: true,
    details: { cause_code: causeCode || 'unknown' },
  });
}

function headerBag(headers) {
  return {
    get(name) {
      const value = headers[String(name).toLowerCase()];
      if (Array.isArray(value)) return value.join(', ');
      return value === undefined ? null : String(value);
    },
  };
}

function responseFacade(response, bodyTimeoutMs, onResponseChunk = null) {
  let bodyTimeoutError = null;
  if (bodyTimeoutMs > 0) {
    response.setTimeout(bodyTimeoutMs, () => {
      bodyTimeoutError = timeoutError('body', bodyTimeoutMs);
      response.destroy(bodyTimeoutError);
    });
  }

  const body = {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of response) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (typeof onResponseChunk === 'function') {
            try { onResponseChunk(buffer.length); } catch {}
          }
          yield buffer;
        }
      } catch (error) {
        throw bodyTimeoutError || mapNetworkError(error);
      }
    },
  };

  const text = async () => {
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  };

  return {
    status: response.statusCode || 0,
    ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
    headers: headerBag(response.headers),
    body,
    text,
  };
}

export function requestBaseUpstream(urlValue, options = {}, timeoutConfig = {}) {
  const target = new URL(urlValue);
  const transport = target.protocol === 'https:' ? https : http;
  const connectTimeoutMs = timeoutConfig.connectTimeoutMs ?? 10_000;
  const headersTimeoutMs = timeoutConfig.headersTimeoutMs ?? 900_000;
  const bodyTimeoutMs = timeoutConfig.bodyTimeoutMs ?? 900_000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let connectTimer = null;
    let headersTimer = null;
    let abortHandler = null;

    const cleanupBeforeHeaders = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (headersTimer) clearTimeout(headersTimer);
      connectTimer = null;
      headersTimer = null;
    };

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanupBeforeHeaders();
      reject(mapNetworkError(error));
    };

    const request = transport.request(target, {
      method: options.method || 'POST',
      headers: options.headers || {},
    }, (response) => {
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      cleanupBeforeHeaders();
      if (options.signal && abortHandler) {
        const clearAbort = () => options.signal.removeEventListener('abort', abortHandler);
        response.once('end', clearAbort);
        response.once('close', clearAbort);
      }
      resolve(responseFacade(response, bodyTimeoutMs, options.onResponseChunk));
    });

    request.once('socket', (socket) => {
      if (!connectTimeoutMs || !socket.connecting) return;
      const connectedEvent = target.protocol === 'https:' ? 'secureConnect' : 'connect';
      connectTimer = setTimeout(() => request.destroy(timeoutError('connect', connectTimeoutMs)), connectTimeoutMs);
      connectTimer.unref?.();
      socket.once(connectedEvent, () => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
      });
    });

    request.once('error', rejectOnce);

    if (headersTimeoutMs > 0) {
      headersTimer = setTimeout(() => request.destroy(timeoutError('headers', headersTimeoutMs)), headersTimeoutMs);
      headersTimer.unref?.();
    }

    if (options.signal) {
      abortHandler = () => {
        const reason = options.signal.reason instanceof Error
          ? options.signal.reason
          : new DOMException('Request aborted.', 'AbortError');
        request.destroy(reason);
      };
      if (options.signal.aborted) {
        abortHandler();
        return;
      }
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    if (options.body !== undefined && options.body !== null) request.write(options.body);
    request.end();
  });
}
