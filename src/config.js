import os from 'node:os';
import path from 'node:path';

const MiB = 1024 * 1024;

const PROFILE_LIMITS = Object.freeze({
  small: { maxRequestBytes: 16 * MiB, maxDecodedBytes: 12 * MiB, maxPdfPages: 40, maxImagePixels: 20_000_000, maxOutputChars: 120_000, processTimeoutMs: 60_000 },
  default: { maxRequestBytes: 48 * MiB, maxDecodedBytes: 32 * MiB, maxPdfPages: 100, maxImagePixels: 40_000_000, maxOutputChars: 300_000, processTimeoutMs: 120_000 },
  large: { maxRequestBytes: 128 * MiB, maxDecodedBytes: 96 * MiB, maxPdfPages: 300, maxImagePixels: 80_000_000, maxOutputChars: 900_000, processTimeoutMs: 300_000 },
});

const CONCURRENCY_PROFILES = Object.freeze({
  small: { managedLimit: 1, queueLimit: 4, queueTimeoutMs: 120_000, visionLimit: 1 },
  default: { managedLimit: 2, queueLimit: 12, queueTimeoutMs: 120_000, visionLimit: 1 },
  large: { managedLimit: 4, queueLimit: 32, queueTimeoutMs: 180_000, visionLimit: 2 },
});

const CACHE_PROFILES = Object.freeze({
  small: { maxMb: 512, retentionDays: 3 },
  default: { maxMb: 2048, retentionDays: 7 },
  large: { maxMb: 10240, retentionDays: 30 },
});

function intValue(value, fallback, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

function enumValue(value, fallback, name, allowed) {
  const candidate = String(value ?? fallback).trim().toLowerCase();
  if (!allowed.includes(candidate)) throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  return candidate;
}

function booleanValue(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const candidate = String(value).trim().toLowerCase();
  if (candidate === 'true') return true;
  if (candidate === 'false') return false;
  throw new Error(`${name} must be true or false`);
}


function derivedChatCompletionsUrl(baseValue) {
  const url = new URL(baseValue);
  const clean = url.pathname.replace(/\/+$/, '');
  if (clean.endsWith('/v1/messages')) url.pathname = `${clean.slice(0, -'/messages'.length)}/chat/completions`;
  else if (clean.endsWith('/v1')) url.pathname = `${clean}/chat/completions`;
  else url.pathname = `${clean}/v1/chat/completions`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function normalizedUrl(value, fallback, name, { required = false } = {}) {
  const candidate = value || fallback;
  if (!candidate) {
    if (required) throw new Error(`${name} is required`);
    return '';
  }
  let url;
  try { url = new URL(candidate); } catch { throw new Error(`${name} must be a valid http(s) URL`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name} must use http or https`);
  return candidate.replace(/\/$/, '');
}

export function loadConfig(env = process.env) {
  const profileName = env.RESOURCE_PROFILE || 'default';
  const profile = PROFILE_LIMITS[profileName];
  if (!profile) throw new Error(`Unsupported RESOURCE_PROFILE: ${profileName}`);

  const vllmBaseUrl = normalizedUrl(env.VLLM_BASE_URL, '', 'VLLM_BASE_URL', { required: true });
  const vllmBaseApiKey = env.VLLM_BASE_API_KEY || '';
  const hasExplicitWebFetchProcessorUrl = Boolean(env.WEB_FETCH_PROCESSOR_URL);
  const webFetchProcessor = Object.freeze({
    enabled: booleanValue(env.WEB_FETCH_PROCESSOR_ENABLED, true, 'WEB_FETCH_PROCESSOR_ENABLED'),
    url: normalizedUrl(
      env.WEB_FETCH_PROCESSOR_URL,
      derivedChatCompletionsUrl(vllmBaseUrl),
      'WEB_FETCH_PROCESSOR_URL',
    ),
    model: env.WEB_FETCH_PROCESSOR_MODEL || '',
    apiKey: env.WEB_FETCH_PROCESSOR_API_KEY || (hasExplicitWebFetchProcessorUrl ? '' : vllmBaseApiKey),
    think: booleanValue(env.WEB_FETCH_PROCESSOR_THINK, false, 'WEB_FETCH_PROCESSOR_THINK'),
  });

  const vllmVisionUrl = normalizedUrl(env.VLLM_VISION_URL, '', 'VLLM_VISION_URL');
  const vllmVisionModel = env.VLLM_VISION_MODEL || '';
  const vllmVisionProvider = enumValue(env.VLLM_VISION_PROVIDER, 'vllm', 'VLLM_VISION_PROVIDER', ['vllm', 'ollama']);
  const vllmVisionThink = booleanValue(env.VLLM_VISION_THINK, false, 'VLLM_VISION_THINK');
  const vllmVisionApiProtocol = vllmVisionProvider === 'ollama' ? 'ollama-native' : 'openai-chat';
  if (vllmVisionUrl && !vllmVisionModel) throw new Error('VLLM_VISION_MODEL is required when VLLM_VISION_URL is set');
  if (vllmVisionModel && !vllmVisionUrl) throw new Error('VLLM_VISION_URL is required when VLLM_VISION_MODEL is set');

  const limits = Object.freeze({
    ...profile,
    maxRequestBytes: intValue(env.MAX_REQUEST_BYTES, profile.maxRequestBytes, 'MAX_REQUEST_BYTES', { min: 1024 }),
    maxDecodedBytes: intValue(env.MAX_DECODED_BYTES, profile.maxDecodedBytes, 'MAX_DECODED_BYTES', { min: 1024 }),
    maxPdfPages: intValue(env.MAX_PDF_PAGES, profile.maxPdfPages, 'MAX_PDF_PAGES', { min: 1, max: 5000 }),
    maxImagePixels: intValue(env.MAX_IMAGE_PIXELS, profile.maxImagePixels, 'MAX_IMAGE_PIXELS', { min: 1 }),
    maxOutputChars: intValue(env.MAX_OUTPUT_CHARS, profile.maxOutputChars, 'MAX_OUTPUT_CHARS', { min: 1024 }),
    processTimeoutMs: intValue(env.PROCESS_TIMEOUT_MS, profile.processTimeoutMs, 'PROCESS_TIMEOUT_MS', { min: 1000 }),
    nativeTextMinCharsPerPage: intValue(env.NATIVE_TEXT_MIN_CHARS_PER_PAGE, 80, 'NATIVE_TEXT_MIN_CHARS_PER_PAGE', { min: 0 }),
    maxVisualPagesPerBatch: intValue(env.MAX_VISUAL_PAGES_PER_BATCH, 4, 'MAX_VISUAL_PAGES_PER_BATCH', { min: 1, max: 8 }),
  });

  const concurrencyProfileName = env.CONCURRENCY_PROFILE || 'default';
  const concurrencyProfile = CONCURRENCY_PROFILES[concurrencyProfileName];
  if (!concurrencyProfile) throw new Error(`Unsupported CONCURRENCY_PROFILE: ${concurrencyProfileName}`);
  const concurrency = Object.freeze({
    profile: concurrencyProfileName,
    managedLimit: intValue(env.MANAGED_MAX_CONCURRENCY, concurrencyProfile.managedLimit, 'MANAGED_MAX_CONCURRENCY', { min: 1, max: 128 }),
    queueLimit: intValue(env.MANAGED_MAX_QUEUE, concurrencyProfile.queueLimit, 'MANAGED_MAX_QUEUE', { min: 0, max: 10_000 }),
    queueTimeoutMs: intValue(env.MANAGED_QUEUE_TIMEOUT_MS, concurrencyProfile.queueTimeoutMs, 'MANAGED_QUEUE_TIMEOUT_MS', { min: 1000, max: 3_600_000 }),
    visionLimit: intValue(env.VISION_MAX_CONCURRENCY, concurrencyProfile.visionLimit, 'VISION_MAX_CONCURRENCY', { min: 1, max: 64 }),
  });

  const cacheProfile = CACHE_PROFILES[profileName];
  const explicitCacheMb = env.MEDIA_CACHE_MAX_MB === undefined || env.MEDIA_CACHE_MAX_MB === ''
    ? cacheProfile.maxMb
    : intValue(env.MEDIA_CACHE_MAX_MB, cacheProfile.maxMb, 'MEDIA_CACHE_MAX_MB', { min: 0, max: 1024 * 1024 });
  const cache = Object.freeze({
    rootDir: env.MEDIA_CACHE_DIR || '/var/lib/vllm-cc-tools-proxy/media-cache',
    maxBytes: explicitCacheMb * MiB,
    retentionMs: cacheProfile.retentionDays * 24 * 60 * 60 * 1000,
    limitMode: explicitCacheMb === 0 ? 'filesystem' : 'bounded',
    pipelineVersion: 'media-v5',
    visualPromptVersion: 'visual-v4',
    evidenceContractVersion: 'evidence-v1',
  });

  return Object.freeze({
    port: intValue(env.PORT || env.PROXY_PORT, 8080, 'PORT', { min: 1, max: 65535 }),
    host: env.HOST || '0.0.0.0',
    resourceProfile: profileName,
    limits,
    concurrency,
    cache,
    vllmBaseUrl,
    vllmBaseApiKey,
    vllmBaseTimeouts: Object.freeze({
      connectTimeoutMs: intValue(env.VLLM_BASE_CONNECT_TIMEOUT_MS, 10000, 'VLLM_BASE_CONNECT_TIMEOUT_MS', { min: 1000, max: 3_600_000 }),
      headersTimeoutMs: intValue(env.VLLM_BASE_HEADERS_TIMEOUT_MS, 900000, 'VLLM_BASE_HEADERS_TIMEOUT_MS', { min: 1000, max: 3_600_000 }),
      bodyTimeoutMs: intValue(env.VLLM_BASE_BODY_TIMEOUT_MS, 900000, 'VLLM_BASE_BODY_TIMEOUT_MS', { min: 1000, max: 3_600_000 }),
    }),
    vllmVisionUrl,
    vllmVisionModel,
    vllmVisionApiKey: env.VLLM_VISION_API_KEY || '',
    vllmVisionProvider,
    vllmVisionThink,
    vllmVisionApiProtocol,
    searxngUrl: normalizedUrl(env.SEARXNG_URL, '', 'SEARXNG_URL'),
    webFetchUrl: normalizedUrl(env.WEB_FETCH_URL, '', 'WEB_FETCH_URL'),
    webFetchApiKey: env.WEB_FETCH_API_KEY || '',
    webFetchProcessor,
    logLevel: env.LOG_LEVEL || 'info',
    logProtocolSnippets: booleanValue(env.LOG_PROTOCOL_SNIPPETS, false, 'LOG_PROTOCOL_SNIPPETS'),
    protocolDiagnosticsDir: path.join(os.tmpdir(), 'vllm-cc-tools-proxy', 'protocol-snippets'),
    maxToolRounds: intValue(env.MAX_TOOL_ROUNDS, 6, 'MAX_TOOL_ROUNDS', { min: 1, max: 12 }),
    progressVisibleAfterMs: intValue(env.PROGRESS_VISIBLE_AFTER_MS, 1500, 'PROGRESS_VISIBLE_AFTER_MS', { min: 0 }),
    progressPingIntervalMs: intValue(env.PROGRESS_PING_INTERVAL_MS, 5000, 'PROGRESS_PING_INTERVAL_MS', { min: 1000 }),
    progressHeartbeatMs: intValue(env.PROGRESS_HEARTBEAT_MS, 30000, 'PROGRESS_HEARTBEAT_MS', { min: 5000 }),
    sseDrainTimeoutMs: intValue(env.SSE_DRAIN_TIMEOUT_MS, 10000, 'SSE_DRAIN_TIMEOUT_MS', { min: 1000, max: 300000 }),
    gitRevision: env.GIT_REVISION || 'unknown',
  });
}
