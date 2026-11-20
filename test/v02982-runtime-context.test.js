import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeClockRegistry,
  RUNTIME_CONTEXT_MARKER,
  formatRuntimeClockReminder,
  injectRuntimeClockReminder,
} from '../src/proxy/runtime-clock.js';

function at(iso) { return new Date(iso); }
function textMessage(text) { return { role: 'user', content: [{ type: 'text', text }] }; }
function toolResult(id, text = 'ok') {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] };
}
function toolUse(id, name = 'Bash') {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] };
}
function final(text = 'done') { return { role: 'assistant', content: [{ type: 'text', text }] }; }
function markers(request) {
  const out = [];
  for (let mi = 0; mi < (request.messages || []).length; mi++) {
    const content = request.messages[mi]?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'text' && String(block.text || '').startsWith(RUNTIME_CONTEXT_MARKER)) {
        out.push({ messageIndex: mi, text: block.text });
      }
    }
  }
  return out;
}

const T1 = '2026-11-21T00:40:12+08:00';
const T2 = '2026-11-21T00:48:31+08:00';

test('V0.29.82 runtime metadata is one neutral cache-stable line', () => {
  const line = formatRuntimeClockReminder(at('2026-11-20T16:40:12Z'), 'Asia/Taipei');
  assert.equal(line, `[VCC_CONTEXT_META_V1 local_time=${T1} timezone=Asia/Taipei]`);
  assert.equal(line.includes('\n'), false);
  assert.equal(line.includes('system-reminder'), false);
  assert.equal(line.includes('authoritative'), false);
});

test('V0.29.82 one visible user interaction keeps one timestamp across tool-result HTTP continuations', () => {
  const registry = new RuntimeClockRegistry();
  const first = injectRuntimeClockReminder({ model: 'm', messages: [textMessage('run tests')] }, {
    sessionId: 's1', registry, now: at('2026-11-20T16:40:12Z'), timeZone: 'Asia/Taipei',
  });
  assert.deepEqual(markers(first), [{ messageIndex: 0, text: `[VCC_CONTEXT_META_V1 local_time=${T1} timezone=Asia/Taipei]` }]);

  const continuation = injectRuntimeClockReminder({ model: 'm', messages: [
    textMessage('run tests'), toolUse('t1'), toolResult('t1', 'passed'),
  ] }, {
    sessionId: 's1', registry, continuation: true,
    now: at('2026-11-20T16:45:00Z'), timeZone: 'Asia/Taipei',
  });
  assert.deepEqual(markers(continuation), [{ messageIndex: 0, text: `[VCC_CONTEXT_META_V1 local_time=${T1} timezone=Asia/Taipei]` }]);
});

test('V0.29.82 next visible user turn restores old timestamp in place and appends one new timestamp', () => {
  const registry = new RuntimeClockRegistry();
  injectRuntimeClockReminder({ messages: [textMessage('run tests')] }, {
    sessionId: 's1', registry, now: at('2026-11-20T16:40:12Z'), timeZone: 'Asia/Taipei',
  });

  const next = injectRuntimeClockReminder({ messages: [
    textMessage('run tests'), final('all passed'), textMessage('check README'),
  ] }, {
    sessionId: 's1', registry, now: at('2026-11-20T16:48:31Z'), timeZone: 'Asia/Taipei',
  });
  assert.deepEqual(markers(next), [
    { messageIndex: 0, text: `[VCC_CONTEXT_META_V1 local_time=${T1} timezone=Asia/Taipei]` },
    { messageIndex: 2, text: `[VCC_CONTEXT_META_V1 local_time=${T2} timezone=Asia/Taipei]` },
  ]);
});

test('V0.29.82 retry and count/inference duplicate of the same visible turn reuses its timestamp', () => {
  const registry = new RuntimeClockRegistry();
  const body = { messages: [textMessage('same turn')] };
  const count = injectRuntimeClockReminder(body, {
    sessionId: 's1', registry, now: at('2026-11-20T16:40:12Z'), timeZone: 'Asia/Taipei',
  });
  const inference = injectRuntimeClockReminder(body, {
    sessionId: 's1', registry, now: at('2026-11-20T16:41:12Z'), timeZone: 'Asia/Taipei',
  });
  assert.deepEqual(markers(inference), markers(count));
});

test('V0.29.82 a continuation without stable session state never invents a fresh historical timestamp', () => {
  const registry = new RuntimeClockRegistry();
  const continuation = injectRuntimeClockReminder({ messages: [
    textMessage('old question'), toolUse('t1'), toolResult('t1'),
  ] }, {
    sessionId: '', registry, continuation: true,
    now: at('2026-11-20T16:45:00Z'), timeZone: 'Asia/Taipei',
  });
  assert.deepEqual(markers(continuation), []);
});

test('V0.29.82 existing runtime metadata is immutable and never duplicated', () => {
  const registry = new RuntimeClockRegistry();
  const existing = `[VCC_CONTEXT_META_V1 local_time=${T1} timezone=Asia/Taipei]`;
  const req = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: existing }] }] };
  const once = injectRuntimeClockReminder(req, {
    sessionId: 's1', registry, now: at('2026-11-20T16:48:31Z'), timeZone: 'Asia/Taipei',
  });
  assert.deepEqual(markers(once), [{ messageIndex: 0, text: existing }]);
});
