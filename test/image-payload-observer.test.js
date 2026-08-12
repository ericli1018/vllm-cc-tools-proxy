import test from 'node:test';
import assert from 'node:assert/strict';
import { observeImagePayloads } from '../src/proxy/image-payload-observer.js';

const IMAGE = {
  type: 'image',
  source: {
    type: 'base64',
    media_type: 'image/png',
    data: 'AAAA',
    original_width: 1920,
    original_height: 1080,
    source_path: '/home/master/private/board.png',
  },
  resized_width: 1456,
  resized_height: 819,
};

test('observer correlates nested Read image without exposing full path or Base64', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/home/master/project/board.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: [structuredClone(IMAGE)] }] },
  ];
  const [item] = observeImagePayloads(messages);
  assert.equal(item.origin, 'read');
  assert.equal(item.toolName, 'Read');
  assert.equal(item.filename, 'board.png');
  assert.match(item.readSourceRef, /^[a-f0-9]{64}$/);
  assert.equal(item.parentType, 'tool_result');
  assert.equal(item.sourceType, 'base64');
  assert.equal(item.mediaType, 'image/png');
  assert.deepEqual(item.blockKeys, ['resized_height', 'resized_width', 'source', 'type']);
  assert.deepEqual(item.sourceKeys, ['data', 'media_type', 'original_height', 'original_width', 'source_path', 'type']);
  assert.deepEqual(item.dimensionMetadata, {
    original_height: 1080,
    original_width: 1920,
    resized_height: 819,
    resized_width: 1456,
  });
  assert.equal(item.sourceReferenceBasename, 'board.png');
  assert.match(item.sourceReferenceRef, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(item).includes('/home/master'), false);
  assert.equal(JSON.stringify(item).includes('AAAA'), false);
});

test('observer labels direct user image separately from tool results', () => {
  const [item] = observeImagePayloads([{ role: 'user', content: [structuredClone(IMAGE)] }]);
  assert.equal(item.origin, 'direct');
  assert.equal(item.toolName, '');
  assert.equal(item.parentType, null);
});

test('observer labels non-Read tool-result image without inventing MCP semantics', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'capture_screenshot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [structuredClone(IMAGE)] }] },
  ];
  const [item] = observeImagePayloads(messages);
  assert.equal(item.origin, 'tool_result');
  assert.equal(item.toolName, 'capture_screenshot');
});

test('V0.2.28.20 image payload observer bounds deep content instead of overflowing', () => {
  let nested = { type: 'text', text: 'leaf' };
  for (let i = 0; i < 140; i += 1) nested = { type: 'tool_result', content: [nested] };
  assert.throws(
    () => observeImagePayloads([{ role: 'user', content: [nested] }]),
    (error) => error?.code === 'request_structure_too_deep' && error?.status === 422,
  );
});
