import fs from 'node:fs';
import { HttpError } from '../lib/http.js';

function readRoutes(value, label) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${label} must contain valid JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must contain a JSON object`);
  if (parsed.routes && parsed.version !== undefined && parsed.version !== 1) throw new Error(`${label} unsupported version`);
  return parsed.routes || parsed;
}

export function configureModelRoutes(env) {
  const enabledRaw = String(env.VLLM_MODEL_ROUTING_ENABLED ?? '').trim().toLowerCase();
  if (enabledRaw && !['true','false'].includes(enabledRaw)) throw new Error('VLLM_MODEL_ROUTING_ENABLED must be true or false');
  const enabled = enabledRaw ? enabledRaw === 'true' : Boolean(env.VLLM_MODEL_ROUTES || env.VLLM_MODEL_ROUTING_FILE);
  const unknownModel = String(env.VLLM_MODEL_ROUTING_UNKNOWN_MODEL || 'reject').trim().toLowerCase();
  if (!['reject','fallback'].includes(unknownModel)) throw new Error('VLLM_MODEL_ROUTING_UNKNOWN_MODEL must be reject or fallback');
  if (!enabled) return Object.freeze({ enabled: false, unknownModel, routes: Object.freeze({}) });
  const routeFile = String(env.VLLM_MODEL_ROUTING_FILE || '').trim();
  const raw = env.VLLM_MODEL_ROUTES ? String(env.VLLM_MODEL_ROUTES) : routeFile ? fs.readFileSync(routeFile, 'utf8') : '';
  if (!raw) throw new Error('Model routing enabled but no routes configured');
  const definitions = readRoutes(raw, env.VLLM_MODEL_ROUTES ? 'VLLM_MODEL_ROUTES' : 'VLLM_MODEL_ROUTING_FILE');
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) throw new Error('Model routes must be an object');
  const routes = Object.create(null);
  for (const [alias, entry] of Object.entries(definitions)) {
    if (!alias.trim() || !entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Invalid model route: ${alias}`);
    const url = String(entry.url || '').trim();
    let uri;
    try { uri = new URL(url); } catch { throw new Error(`Invalid URL for model route ${alias}`); }
    if (!['http:', 'https:'].includes(uri.protocol) || uri.username || uri.password) throw new Error(`Invalid URL for model route ${alias}`);
    const protocol = String(entry.protocol || '').trim().toLowerCase();
    if (!['openai', 'anthropic'].includes(protocol)) throw new Error(`Invalid protocol for model route ${alias}`);
    const model = String(entry.upstream_model || entry.model || '').trim();
    if (!model) throw new Error(`Missing upstream model for route ${alias}`);
    const keyEnv = entry.api_key_env === undefined ? '' : String(entry.api_key_env).trim();
    if (keyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw new Error(`Invalid api_key_env for route ${alias}`);
    const apiKey = keyEnv ? String(env[keyEnv] || '') : String(entry.api_key || '');
    routes[alias] = Object.freeze({ url, protocol, model, apiKey, alias });
  }
  if (!Object.keys(routes).length) throw new Error('Model routes cannot be empty');
  return Object.freeze({ enabled: true, unknownModel, routes: Object.freeze(routes) });
}

export function resolveModelRoute(clientModel, config) {
  const routing = config.modelRouting;
  if (!routing?.enabled) return Object.freeze({ url: config.vllmBaseUrl, protocol: config.vllmBaseApiProtocol, model: config.vllmBaseModel, apiKey: config.vllmBaseApiKey, alias: null });
  const alias = String(clientModel || '');
  if (Object.hasOwn(routing.routes, alias)) return routing.routes[alias];
  if (routing.unknownModel === 'fallback') return Object.freeze({ url: config.vllmBaseUrl, protocol: config.vllmBaseApiProtocol, model: config.vllmBaseModel, apiKey: config.vllmBaseApiKey, alias: null });
  throw new HttpError(400, `Unknown model alias: ${alias || '(missing)'}`, { code: 'unknown_model_alias' });
}
