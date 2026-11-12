import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { configureModelRoutes, resolveModelRoute } from '../src/proxy/model-router.js';

const env = (changes={}) => ({
  VLLM_BASE_URL: 'http://127.0.0.1:8001/v1',
  VLLM_BASE_MODEL: 'real-base', VLLM_BASE_API_PROTOCOL:'anthropic',
  VLLM_MODEL_ROUTES: JSON.stringify({
    local: {url:'http://127.0.0.1:8001/v1', protocol:'anthropic',model:'real-local',tool_reference_mode:'compat'},
    native: {url:'https://api.anthropic.com/v1', protocol:'anthropic',model:'real-native',tool_reference_mode:'passthrough'},
  }),
  ...changes,
});

test('v0.29.79 global ToolSearch mode defaults to local compat', () => {
  assert.equal(loadConfig(env()).toolReferenceMode, 'compat');
});
test('v0.29.79 native mode can be set globally', () => {
  assert.equal(loadConfig(env({TOOL_REFERENCE_MODE:'passthrough'})).toolReferenceMode,'passthrough');
});
test('v0.29.79 route-specific modes override Base default', () => {
  const cfg=loadConfig(env());
  assert.equal(resolveModelRoute('local',cfg).toolReferenceMode,'compat');
  assert.equal(resolveModelRoute('native',cfg).toolReferenceMode,'passthrough');
  assert.equal(resolveModelRoute('missing',{...cfg,modelRouting:{...cfg.modelRouting,unknownModel:'fallback'}}).alias,null);
});
test('v0.29.79 invalid global mode fails startup', () => {
  assert.throws(()=>loadConfig(env({TOOL_REFERENCE_MODE:'silent-drop'})), /TOOL_REFERENCE_MODE/);
});
test('v0.29.79 invalid per-route mode fails startup', () => {
  assert.throws(()=>configureModelRoutes(env({VLLM_MODEL_ROUTES:JSON.stringify({a:{url:'http://127.0.0.1:8001/v1',protocol:'anthropic',model:'real',tool_reference_mode:'silently-drop'}})})), /tool_reference_mode/);
});
