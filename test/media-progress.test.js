import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaProgressTracker } from '../src/proxy/media-progress.js';

test('media progress resolves Read tool filename and hides the full local path', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/home/master/workspace-claude/GW305_N101_20260519-board.pdf' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'y' } },
    ] }] },
  ];
  const tracker = createMediaProgressTracker(messages);
  const rendered = tracker.render('正在使用視覺模型分析圖片…', {
    phase: 'image_vision', path: ['messages', 1, 'content', 0, 'content', 1],
  });
  assert.match(rendered, /檔案：GW305_N101_20260519-board\.pdf/);
  assert.match(rendered, /圖片 2\/2/);
  assert.doesNotMatch(rendered, /\/home\/master/);
});

test('media progress renders PDF page, batch and percentage status', () => {
  const messages = [{ role: 'user', content: [{
    type: 'document', title: 'board.pdf',
    source: { type: 'base64', media_type: 'application/pdf', data: 'x', filename: '/tmp/private/board.pdf' },
  }] }];
  const tracker = createMediaProgressTracker(messages);
  const rendered = tracker.render('視覺模型已完成 8/15 頁…', {
    phase: 'pdf_visual_progress', path: ['messages', 0, 'content', 0], completed: 8, total: 15, batch: 2, batches: 4,
  });
  assert.equal(rendered, '檔案：board.pdf｜頁面 8/15（53%）｜批次 2/4｜狀態：視覺模型已完成 8/15 頁…');
});

test('media progress distinguishes split document segments with one filename', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: '/work/manual.pdf' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'a' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'b' } },
    ] }] },
  ];
  const tracker = createMediaProgressTracker(messages);
  const rendered = tracker.render('正在解析 PDF…', { phase: 'pdf_start', path: ['messages', 1, 'content', 0, 'content', 1] });
  assert.match(rendered, /檔案：manual\.pdf/);
  assert.match(rendered, /區段 2\/2/);
});

test('media ready summary names the current file and heartbeat keeps the last status', () => {
  const messages = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x', filename: 'panel.png' } }] }];
  let now = 1000;
  const tracker = createMediaProgressTracker(messages, { now: () => now });
  tracker.render('正在使用視覺模型分析圖片…', { phase: 'image_vision', path: ['messages', 0, 'content', 0] });
  assert.equal(tracker.renderMediaReady(), '檔案：panel.png｜處理進度 1/1（100%）｜狀態：文件與圖片內容已就緒；正在交給主模型分析…');
  now = 31_000;
  assert.match(tracker.renderHeartbeat(), /主模型仍在處理本輪請求，已執行 30 秒/);
});

test('unnamed media fallback numbering does not skip named media', () => {
  const messages = [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a', filename: 'named.png' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'b' } },
  ] }];
  const tracker = createMediaProgressTracker(messages);
  const rendered = tracker.render('正在準備圖片…', { phase: 'image_start', path: ['messages', 0, 'content', 1] });
  assert.match(rendered, /檔案 2\/2：圖片 #1/);
});

test('V0.2.23 media progress localizes labels and heartbeat while preserving filenames', () => {
  const messages = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x', filename: 'panel.png' } }] }];
  let now = 1000;
  const tracker = createMediaProgressTracker(messages, { locale: 'en-US', now: () => now });
  const rendered = tracker.render('Analyzing image with the visual model…', { phase: 'image_vision', path: ['messages', 0, 'content', 0] });
  assert.equal(rendered, 'File: panel.png | Image 1/1 | Status: Analyzing image with the visual model…');
  assert.equal(tracker.renderMediaReady(), 'File: panel.png | Progress 1/1 (100%) | Status: Document and image content is ready; handing it to the main model for analysis…');
  now = 31_000;
  assert.match(tracker.renderHeartbeat(), /The main model is still processing this request\. Running for 30s…/);
});

test('V0.2.27.2 correlates Read.pages with the returned PDF tool_result', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-focused', name: 'Read', input: { file_path: '/work/board.pdf', pages: '42' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-focused', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'pdf' } },
    ] }] },
  ];
  const tracker = createMediaProgressTracker(messages);
  const context = tracker.contextForPath(['messages', 1, 'content', 0, 'content', 0]);
  assert.equal(context.filename, 'board.pdf');
  assert.deepEqual(context.pageScope, { pages: [42], canonical: '42' });
  assert.equal(context.readSourceRef?.length, 64);
  assert.doesNotMatch(JSON.stringify(context), /\/work\/board\.pdf/);
});

test('V0.2.28.20 media progress descriptor scan bounds deep content', () => {
  let nested = { type: 'text', text: 'leaf' };
  for (let i = 0; i < 140; i += 1) nested = { type: 'tool_result', content: [nested] };
  assert.throws(
    () => createMediaProgressTracker([{ role: 'user', content: [nested] }]),
    (error) => error?.code === 'request_structure_too_deep' && error?.status === 422,
  );
});
