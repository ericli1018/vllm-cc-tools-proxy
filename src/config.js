const MiB = 1024 * 1024;

const PROFILE_LIMITS = Object.freeze({
  small: { maxRequestBytes: 16 * MiB, maxDecodedBytes: 12 * MiB, maxPdfPages: 40, maxImagePixels: 20_000_000, maxOutputChars: 120_000, processTimeoutMs: 60_000 },
  default: { maxRequestBytes: 48 * MiB, maxDecodedBytes: 32 * MiB, maxPdfPages: 100, maxImagePixels: 40_000_000, maxOutputChars: 300_000, processTimeoutMs: 120_000 },
  large: { maxRequestBytes: 128 * MiB, maxDecodedBytes: 96 * MiB, maxPdfPages: 300, maxImagePixels: 80_000_000, maxOutputChars: 900_000, processTimeoutMs: 300_000 },
});

function intValue(value, fallback, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
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

  const vllmVisionUrl = normalizedUrl(env.VLLM_VISION_URL, '', 'VLLM_VISION_URL');
  const vllmVisionModel = env.VLLM_VISION_MODEL || '';
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

  return Object.freeze({
    port: intValue(env.PORT || env.PROXY_PORT, 8080, 'PORT', { min: 1, max: 65535 }),
    host: env.HOST || '0.0.0.0',
    resourceProfile: profileName,
    limits,
    vllmBaseUrl: normalizedUrl(env.VLLM_BASE_URL, '', 'VLLM_BASE_URL', { required: true }),
    vllmBaseApiKey: env.VLLM_BASE_API_KEY || '',
    vllmVisionUrl,
    vllmVisionModel,
    vllmVisionApiKey: env.VLLM_VISION_API_KEY || '',
    searxngUrl: normalizedUrl(env.SEARXNG_URL, '', 'SEARXNG_URL'),
    webFetchUrl: normalizedUrl(env.WEB_FETCH_URL, '', 'WEB_FETCH_URL'),
    logLevel: env.LOG_LEVEL || 'info',
    maxToolRounds: intValue(env.MAX_TOOL_ROUNDS, 6, 'MAX_TOOL_ROUNDS', { min: 1, max: 12 }),
    progressVisibleAfterMs: intValue(env.PROGRESS_VISIBLE_AFTER_MS, 1500, 'PROGRESS_VISIBLE_AFTER_MS', { min: 0 }),
    progressPingIntervalMs: intValue(env.PROGRESS_PING_INTERVAL_MS, 5000, 'PROGRESS_PING_INTERVAL_MS', { min: 1000 }),
    progressHeartbeatMs: intValue(env.PROGRESS_HEARTBEAT_MS, 15000, 'PROGRESS_HEARTBEAT_MS', { min: 5000 }),
    gitRevision: env.GIT_REVISION || 'unknown',
  });
}
