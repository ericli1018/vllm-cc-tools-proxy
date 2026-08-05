import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  PROGRESS_BLOCK_HEADER,
  ProgressStream,
  hasProgressHistory,
  stripProgressHistory,
} from '../src/proxy/progress.js';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.headers = null;
    this.status = null;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }
}

test('ProgressStream emits a readable progress block without a V0.2.2 nonce sentinel', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000 });
  await progress.open();
  await progress.update('正在解析 PDF…', { force: true });
  await progress.closeProgress('處理完成；正在回傳模型結果…');
  await progress.stop();

  const stream = response.chunks.join('');
  assert.match(stream, new RegExp(PROGRESS_BLOCK_HEADER));
  assert.match(stream, /正在解析 PDF/);
  assert.doesNotMatch(stream, /VLLMCCP:v1:/);
  assert.doesNotMatch(stream, /\u2063/);
});

test('stripProgressHistory removes a dedicated V0.2.3 progress block and keeps model blocks', () => {
  const messages = [{
    role: 'assistant',
    content: [
      { type: 'text', text: `${PROGRESS_BLOCK_HEADER}\n正在解析 PDF…\n處理完成；正在回傳模型結果…` },
      { type: 'thinking', thinking: 'model thought', signature: 'sig' },
      { type: 'text', text: '真正答案' },
    ],
  }];
  const result = stripProgressHistory(messages);
  assert.deepEqual(result[0].content, [
    { type: 'thinking', thinking: 'model thought', signature: 'sig' },
    { type: 'text', text: '真正答案' },
  ]);
});

test('hasProgressHistory detects the dedicated V0.2.3 progress block', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: `${PROGRESS_BLOCK_HEADER}\n正在解析 PDF…` }] }];
  assert.equal(hasProgressHistory(messages), true);
});

test('stripProgressHistory removes V0.2.2 invisible sentinel region for backward compatibility', () => {
  const start = '\u2063VLLMCCP:v1:abc123:start\u2063';
  const end = '\u2063VLLMCCP:v1:abc123:end\u2063';
  const messages = [{
    role: 'assistant',
    content: [{ type: 'text', text: `${start}正在解析 PDF…${end}\n\n真正答案` }],
  }];
  const result = stripProgressHistory(messages);
  assert.equal(result[0].content[0].text, '\n\n真正答案');
});

test('stripProgressHistory removes V0.2.2 markers even when invisible separators were normalized away', () => {
  const messages = [{
    role: 'assistant',
    content: [{ type: 'text', text: 'VLLMCCP:v1:abc123:start處理完成；正在回傳模型結果…VLLMCCP:v1:abc123:end\n真正答案' }],
  }];
  const result = stripProgressHistory(messages);
  assert.equal(result[0].content[0].text, '\n真正答案');
});

test('stripProgressHistory preserves ordinary assistant text', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: '正在解析 PDF，但這是模型答案。' }] }];
  assert.deepEqual(stripProgressHistory(messages), messages);
  assert.equal(hasProgressHistory(messages), false);
});
