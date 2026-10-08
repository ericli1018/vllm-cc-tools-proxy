import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { resolveModelRoute } from '../src/proxy/model-router.js';
const base = { VLLM_BASE_URL: 'http://fallback:8000/v1' };
const routes = JSON.stringify({ 'claude-sonnet-5': { url: 'http://a:8000/v1', protocol: 'openai', model: 'qwen-local', api_key: 'secret' }, 'claude-opus-5': { url: 'http://b:8000/v1', protocol: 'anthropic', upstream_model: 'ornith' } });
test('ENV routes resolve exact alias, protocol, key and model', () => {
 const config = loadConfig({ ...base, VLLM_MODEL_ROUTES: routes });
 assert.deepEqual({ ...resolveModelRoute('claude-sonnet-5', config) }, { url: 'http://a:8000/v1', protocol: 'openai', model: 'qwen-local', apiKey: 'secret', alias: 'claude-sonnet-5' });
 assert.equal(resolveModelRoute('claude-opus-5', config).model, 'ornith');
 assert.throws(() => resolveModelRoute('unknown', config), /Unknown model alias/);
});
test('routing disabled uses original base and unknown fallback only when configured', () => {
 assert.equal(resolveModelRoute('unknown', loadConfig(base)).url, base.VLLM_BASE_URL);
 assert.equal(resolveModelRoute('unknown', loadConfig({ ...base, VLLM_MODEL_ROUTES: routes, VLLM_MODEL_ROUTING_UNKNOWN_MODEL: 'fallback' })).url, base.VLLM_BASE_URL);
});
test('routing input validation prevents unsafe URLs and unsupported protocols', () => {
 for (const entry of [{ url: 'file:///etc/passwd', protocol: 'openai', model: 'x' }, { url: 'http://x', protocol: 'bad', model: 'x' }, { url: 'http://user:pwd@x', protocol: 'openai', model: 'x' }]) {
  assert.throws(() => loadConfig({ ...base, VLLM_MODEL_ROUTES: JSON.stringify({ x: entry }) }));
 }
});
test('completion probe ENV defaults on and explicitly disables', () => {
 assert.equal(loadConfig(base).completionProbeEnabled, true);
 assert.equal(loadConfig({ ...base, COMPLETION_PROBE_ENABLED: 'false' }).completionProbeEnabled, false);
 assert.throws(() => loadConfig({ ...base, COMPLETION_PROBE_ENABLED: 'nope' }), /COMPLETION_PROBE_ENABLED/);
});
