import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressMarkers, stripProgressHistory } from '../src/proxy/progress.js';

test('stripProgressHistory removes only proxy-generated sentinel region', () => {
  const markers = createProgressMarkers('abc123');
  const messages = [{
    role: 'assistant',
    content: [{ type: 'text', text: `${markers.start}正在解析 PDF…${markers.end}\n\n真正答案` }],
  }];
  const result = stripProgressHistory(messages);
  assert.equal(result[0].content[0].text, '\n\n真正答案');
});

test('stripProgressHistory preserves ordinary similar text', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: '正在解析 PDF，但這是使用者內容。' }] }];
  assert.deepEqual(stripProgressHistory(messages), messages);
});
