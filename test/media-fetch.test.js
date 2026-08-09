import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../src/lib/media.js';

test('V0.2.28.4 preserves safe nested headers-timeout transport cause', async (t) => {
  globalThis.fetch = async () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
    throw error;
  };
  t.after(() => { delete globalThis.fetch; });
  await assert.rejects(() => fetchJson('http://vision.local/api/chat', {}, { errorCode: 'vision_service_error' }), (error) => {
    assert.equal(error.code, 'vision_service_error');
    assert.equal(error.retryable, true);
    assert.equal(error.details?.transport_code, 'UND_ERR_HEADERS_TIMEOUT');
    assert.equal(error.details?.transport_phase, 'headers');
    assert.match(error.message, /response headers/i);
    return true;
  });
});

test('V0.2.28.4 preserves safe connection-refused transport cause', async (t) => {
  globalThis.fetch = async () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'ECONNREFUSED' };
    throw error;
  };
  t.after(() => { delete globalThis.fetch; });
  await assert.rejects(() => fetchJson('http://vision.local/api/chat', {}, { errorCode: 'vision_service_error' }), (error) => {
    assert.equal(error.details?.transport_code, 'ECONNREFUSED');
    assert.equal(error.details?.transport_phase, 'connect');
    assert.match(error.message, /connect/i);
    return true;
  });
});
