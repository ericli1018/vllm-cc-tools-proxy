import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/app.js';

test('createServer creates the single proxy service', () => {
  const server = createServer({
    vllmBaseUrl: 'http://127.0.0.1:9', vllmBaseApiKey: '',
    vllmVisionUrl: '', vllmVisionModel: '', vllmVisionApiKey: '',
    limits: { maxRequestBytes: 1000, maxDecodedBytes: 1000, maxPdfPages: 1, maxOutputChars: 1000, processTimeoutMs: 1000, nativeTextMinCharsPerPage: 80, maxImagePixels: 10000, maxVisualPagesPerBatch: 4 },
    searxngUrl: '', webFetchUrl: '', maxToolRounds: 1,
    progressVisibleAfterMs: 0, progressPingIntervalMs: 1000, progressHeartbeatMs: 5000,
    logLevel: 'error', gitRevision: 'test', resourceProfile: 'small',
  });
  assert.equal(typeof server.listen, 'function');
  server.close();
});
