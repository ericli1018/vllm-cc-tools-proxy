import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const compose = await fs.readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
const envExample = await fs.readFile(new URL('../.env.example', import.meta.url), 'utf8');

test('Compose uses one official Node container with persistent source clone and fast-forward pull', () => {
  assert.match(compose, /image:\s*node:22-bookworm-slim/);
  const servicesBlock = compose.split('\nvolumes:\n', 1)[0];
  assert.equal((servicesBlock.match(/^  [a-zA-Z0-9_-]+:\s*$/gm) || []).length, 1);
  assert.match(compose, /git clone --depth 1 --branch main/);
  assert.match(compose, /git -C \"\$\$SOURCE_DIR\" pull --ff-only origin main/);
  assert.match(compose, /proxy-source:\s*\/workspace\/vllm-cc-tools-proxy/);
  assert.match(compose, /proxy-npm-cache:\s*\/root\/.npm/);
  assert.match(compose, /proxy-apt-cache:\s*\/var\/cache\/apt\/archives/);
  assert.match(compose, /proxy-data:\s*\/var\/lib\/vllm-cc-tools-proxy/);
  assert.match(compose, /^volumes:\s*\n  proxy-source:\s*\n  proxy-npm-cache:\s*\n  proxy-apt-cache:\s*\n  proxy-data:/m);
  assert.match(compose, /DEPENDENCY_FINGERPRINT/);
  assert.doesNotMatch(compose, /(?<!\$)\$SOURCE_DIR/);
  assert.doesNotMatch(compose, /(?<!\$)\$DEPENDENCY_FINGERPRINT/);
  assert.match(compose, /npm ci --omit=dev/);
  assert.match(compose, /node_modules\/.dependency-fingerprint/);
  assert.doesNotMatch(compose, /rm -rf \/workspace\/vllm-cc-tools-proxy/);
  assert.doesNotMatch(compose, /bootstrap\.sh/);
  assert.doesNotMatch(compose, /document-parser:|image-parser:|ocr-service:/);
});

test('ENV example preserves base and vision vLLM variables', () => {
  for (const name of ['VLLM_BASE_URL','VLLM_BASE_API_KEY','VLLM_VISION_URL','VLLM_VISION_MODEL','VLLM_VISION_API_KEY','VLLM_VISION_PROVIDER','VLLM_VISION_THINK']) {
    assert.match(envExample, new RegExp(`^${name}=`, 'm'));
  }
  for (const removed of ['DOCUMENT_PARSER_URL','IMAGE_PARSER_URL','OCR_SERVICE_URL','VISION_SERVICE_URL','AUTO_UPDATE']) {
    assert.doesNotMatch(envExample, new RegExp(`^${removed}=`, 'm'));
  }
  assert.match(envExample, /^CONCURRENCY_PROFILE=default$/m);
  assert.match(envExample, /^MEDIA_CACHE_MAX_MB=0$/m);
});

test('Compose exposes the simple concurrency profile without adding queue services', () => {
  assert.match(compose, /CONCURRENCY_PROFILE:\s*\$\{CONCURRENCY_PROFILE:-default\}/);
  assert.match(compose, /MANAGED_MAX_CONCURRENCY:\s*\$\{MANAGED_MAX_CONCURRENCY:-\}/);
  assert.match(compose, /MANAGED_MAX_QUEUE:\s*\$\{MANAGED_MAX_QUEUE:-\}/);
  assert.match(compose, /MANAGED_QUEUE_TIMEOUT_MS:\s*\$\{MANAGED_QUEUE_TIMEOUT_MS:-\}/);
  assert.match(compose, /VISION_MAX_CONCURRENCY:\s*\$\{VISION_MAX_CONCURRENCY:-\}/);
  assert.match(compose, /MEDIA_CACHE_MAX_MB:\s*\$\{MEDIA_CACHE_MAX_MB:-0\}/);
  assert.match(compose, /VLLM_VISION_PROVIDER:\s*\$\{VLLM_VISION_PROVIDER:-vllm\}/);
  assert.match(compose, /VLLM_VISION_THINK:\s*\$\{VLLM_VISION_THINK:-false\}/);
  assert.match(compose, /PROGRESS_HEARTBEAT_MS:\s*\$\{PROGRESS_HEARTBEAT_MS:-30000\}/);
  assert.match(compose, /SSE_DRAIN_TIMEOUT_MS:\s*\$\{SSE_DRAIN_TIMEOUT_MS:-10000\}/);
  assert.match(envExample, /^PROGRESS_HEARTBEAT_MS=30000$/m);
  assert.match(envExample, /^SSE_DRAIN_TIMEOUT_MS=10000$/m);
  assert.doesNotMatch(compose, /redis:|rabbitmq:|queue-service:/);
});

test('package version is V0.2.8', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.version, '0.2.8');
  assert.equal(lock.version, '0.2.8');
  assert.equal(lock.packages[''].version, '0.2.8');
});


test('current progress protocol does not generate the V0.2.2 nonce sentinel', async () => {
  const source = await fs.readFile(new URL('../src/proxy/progress.js', import.meta.url), 'utf8');
  const generatorSection = source.slice(source.indexOf('export class ProgressStream'));
  assert.doesNotMatch(generatorSection, /VLLMCCP:v1:/);
  assert.match(source, /目前處理進度/);
  assert.doesNotMatch(source, /function createProgressMarkers/);
});
