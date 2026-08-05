import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptMessages } from '../src/proxy/content-blocks.js';

test('adaptMessages replaces top-level PDF and nested tool-result image blocks', async () => {
  const input = [{
    role: 'user',
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'PDFDATA' } },
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: [
          { type: 'text', text: 'screenshot follows' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'IMGDATA' } },
        ],
      },
    ],
  }];

  const output = await adaptMessages(input, {
    adaptDocument: async () => ({ type: 'text', text: '<document>parsed</document>' }),
    adaptImage: async () => ({ type: 'text', text: '<image>ocr</image>' }),
  });

  assert.equal(output[0].content[0].text, '<document>parsed</document>');
  assert.equal(output[0].content[1].tool_use_id, 'tool-1');
  assert.equal(output[0].content[1].content[0].text, 'screenshot follows');
  assert.equal(output[0].content[1].content[1].text, '<image>ocr</image>');
  assert.equal(JSON.stringify(output).includes('PDFDATA'), false);
  assert.equal(JSON.stringify(output).includes('IMGDATA'), false);
});

test('adaptMessages leaves ordinary text untouched', async () => {
  const input = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
  const output = await adaptMessages(input, {});
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
});
