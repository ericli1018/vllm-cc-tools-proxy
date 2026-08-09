import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaUsageBootstrapRequest } from '../src/proxy/media-usage-bootstrap.js';

test('V0.2.27.1 usage bootstrap replaces pending media with bounded text placeholders', () => {
  const request = {
    model: 'm',
    stream: true,
    system: 'system text',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'inspect this board' },
        { type: 'document', source: { type: 'proxy_file', media_type: 'application/pdf', path: '/tmp/secret.pdf', cache_key: 'abc' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAAsecretbase64' } },
      ],
    }],
  };

  const bootstrap = buildMediaUsageBootstrapRequest(request);
  const serialized = JSON.stringify(bootstrap);

  assert.equal(bootstrap.stream, false);
  assert.match(serialized, /inspect this board/);
  assert.match(serialized, /pending PDF evidence/);
  assert.match(serialized, /pending image evidence/);
  assert.doesNotMatch(serialized, /proxy_file/);
  assert.doesNotMatch(serialized, /secret\.pdf/);
  assert.doesNotMatch(serialized, /AAAAsecretbase64/);
  assert.doesNotMatch(serialized, /cache_key/);
  assert.match(JSON.stringify(request), /proxy_file/);
});
