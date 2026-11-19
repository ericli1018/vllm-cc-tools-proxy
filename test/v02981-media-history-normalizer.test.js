import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMediaProvenance, collectToolMediaContexts } from '../src/proxy/media-provenance.js';
import { normalizeMediaHistory } from '../src/proxy/media-history-normalizer.js';

const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
function image(label, extraSource = {}) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.concat([PNG, Buffer.from(label)]).toString('base64'), ...extraSource } };
}
function readPair(id, filePath, label, extra = {}) {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: filePath, ...extra } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `read ${label}` }, image(label)] }] },
  ];
}
function screenshotPair(id, toolName, input, label, resultText = '') {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: toolName, input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [
      ...(resultText ? [{ type: 'text', text: resultText }] : []), image(label),
    ] }] },
  ];
}
function imagesIn(messages) {
  const output = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(walk);
    if (value.type === 'image') output.push(value);
    if (Array.isArray(value.content)) walk(value.content);
  };
  walk(messages); return output;
}
function releasedMarkers(messages) {
  const output = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(walk);
    if (value.type === 'text' && /^\[Image released: media_id=m_[0-9a-f]{32}; path=.+\]$/.test(value.text || '')) output.push(value.text);
    if (Array.isArray(value.content)) walk(value.content);
  };
  walk(messages); return output;
}
const options = { enabled: true, maxPathImages: 4, maxDecodedBytes: 1024 * 1024 };

test('V0.29.81 keeps the latest four PATH-backed image occurrences and releases older images in place', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'pathless-before' }, image('pasted-user') ] },
    ...readPair('r1', '/work/one.png', 'one'),
    ...readPair('r2', '/work/two.png', 'two'),
    ...readPair('r3', '/work/three.png', 'three'),
    ...readPair('r4', '/work/four.png', 'four'),
    ...readPair('r5', '/work/five.png', 'five'),
    ...readPair('r6', '/work/six.png', 'six'),
  ];
  const before = structuredClone(messages);
  const result = normalizeMediaHistory(messages, options);
  assert.equal(result.changed, true);
  assert.deepEqual(result.summary, {
    totalImages: 7, pathBackedImages: 6, pathlessImages: 1,
    retainedPathImages: 4, releasedPathImages: 2,
    releasedDecodedBytes: PNG.length + 3 + PNG.length + 3,
  });
  assert.equal(imagesIn(result.messages).length, 5, 'one pathless plus latest four Read images');
  assert.deepEqual(imagesIn(result.messages).map(x => Buffer.from(x.source.data, 'base64').subarray(PNG.length).toString()), ['pasted-user','three','four','five','six']);
  const markers = releasedMarkers(result.messages);
  assert.equal(markers.length, 2);
  assert.match(markers[0], /path=\/work\/one\.png\]$/);
  assert.match(markers[1], /path=\/work\/two\.png\]$/);
  assert.deepEqual(messages, before, 'normalizer must not mutate the client request');
  assert.equal(result.messages[2].content[0].tool_use_id, 'r1');
  assert.equal(result.messages[2].content[0].content[0].text, 'read one');
  assert.equal(result.messages[2].content[0].content[1].type, 'text');
});

test('V0.29.81 produces byte-stable markers and changes media_id when bytes at the same path change', () => {
  const a = [...readPair('r1', '/work/same.png', 'A'), ...readPair('r2','/work/2.png','2'), ...readPair('r3','/work/3.png','3'), ...readPair('r4','/work/4.png','4'), ...readPair('r5','/work/5.png','5')];
  const first = normalizeMediaHistory(a, options);
  const second = normalizeMediaHistory(structuredClone(a), options);
  assert.equal(JSON.stringify(first.messages), JSON.stringify(second.messages));
  const oldId = /media_id=(m_[0-9a-f]{32})/.exec(releasedMarkers(first.messages)[0])[1];
  const changed = structuredClone(a);
  changed[1].content[0].content[1] = image('B');
  const newId = /media_id=(m_[0-9a-f]{32})/.exec(releasedMarkers(normalizeMediaHistory(changed, options).messages)[0])[1];
  assert.notEqual(oldId, newId);
});

test('V0.29.81 counts multiple images in one Read result by occurrence and preserves tool_result shape/order', () => {
  const messages = [
    { role:'assistant', content:[{type:'tool_use', id:'multi', name:'Read', input:{file_path:'/work/multi.png'}}]},
    { role:'user', content:[{type:'tool_result',tool_use_id:'multi',is_error:false,content:[image('1'),{type:'text',text:'middle'},image('2'),image('3'),image('4'),image('5')]}]},
  ];
  const result = normalizeMediaHistory(messages, options);
  const content = result.messages[1].content[0].content;
  assert.equal(content.length, 6);
  assert.match(content[0].text, /^\[Image released:/);
  assert.equal(content[1].text, 'middle');
  assert.deepEqual(content.slice(2).map(x=>x.type), ['image','image','image','image']);
  assert.equal(result.messages[1].content[0].tool_use_id, 'multi');
  assert.equal(result.messages[1].content[0].is_error, false);
});

test('V0.29.81 trusts structured Read and Screenshot paths but not arbitrary Saved-to text or basename-only screenshot names', () => {
  const messages = [
    ...screenshotPair('shot1','mcp__playwright__browser_take_screenshot',{filename:'/tmp/full.png'},'full'),
    ...screenshotPair('shot2','Screenshot',{output_path:'C:\\captures\\screen.png'},'win'),
    ...screenshotPair('shot3','Screenshot',{filename:'basename.png'},'basename'),
    ...screenshotPair('fake','mcp__comfyui__get_image',{filename:'remote.png'},'fake','Saved to: /tmp/pretend.png'),
    ...readPair('read-relative','relative/image.png','relative'),
  ];
  const contexts = collectToolMediaContexts(messages);
  assert.equal(contexts.get('shot1').originalPath, '/tmp/full.png');
  assert.equal(contexts.get('shot2').originalPath, 'C:/captures/screen.png');
  assert.equal(contexts.get('shot3').originalPath, '');
  assert.equal(contexts.get('fake').originalPath, '');
  assert.equal(contexts.get('read-relative').originalPath, 'relative/image.png');
  const occurrences = collectMediaProvenance(messages);
  assert.deepEqual(occurrences.map(x => Boolean(x.releasable)), [true,true,false,false,true]);
});

test('V0.29.81 includes PDF page scope in deterministic identity without changing the fixed marker format', () => {
  const history = [
    ...readPair('pdf1','/work/report.pdf','page1',{pages:'1'}),
    ...readPair('r2','/work/2.png','2'), ...readPair('r3','/work/3.png','3'), ...readPair('r4','/work/4.png','4'), ...readPair('r5','/work/5.png','5'),
  ];
  const page1 = releasedMarkers(normalizeMediaHistory(history, options).messages)[0];
  const page2History = structuredClone(history); page2History[0].content[0].input.pages = '2';
  const page2 = releasedMarkers(normalizeMediaHistory(page2History, options).messages)[0];
  assert.notEqual(page1, page2);
  assert.match(page1, /^\[Image released: media_id=m_[0-9a-f]{32}; path=\/work\/report\.pdf\]$/);
});

test('V0.29.81 disabled mode is a true no-op and max zero releases only PATH-backed images', () => {
  const messages = [...readPair('r1','/work/a.png','a'),{role:'user',content:[image('pasted')]}];
  const disabled = normalizeMediaHistory(messages,{...options,enabled:false});
  assert.equal(disabled.changed,false); assert.equal(disabled.messages,messages);
  const zero = normalizeMediaHistory(messages,{...options,maxPathImages:0});
  assert.equal(releasedMarkers(zero.messages).length,1); assert.equal(imagesIn(zero.messages).length,1);
});

test('V0.29.81 rejects malformed or oversized PATH-backed image data instead of releasing it silently', () => {
  const malformed = [...readPair('r1','/work/a.png','a')]; malformed[1].content[0].content[1].source.data='not-base64';
  assert.throws(()=>normalizeMediaHistory(malformed,{...options,maxPathImages:0}),error=>error.code==='invalid_base64');
  const large = [...readPair('r1','/work/a.png','large')];
  assert.throws(()=>normalizeMediaHistory(large,{...options,maxPathImages:0,maxDecodedBytes:8}),error=>error.code==='media_too_large');
});

import { createMediaProgressTracker } from '../src/proxy/media-progress.js';
import { observeImagePayloads } from '../src/proxy/image-payload-observer.js';

test('V0.29.81 media diagnostics share Screenshot provenance with the normalizer', () => {
  const messages = screenshotPair('shot','mcp__playwright__browser_take_screenshot',{filename:'/tmp/captures/home.png'},'shot');
  const tracker = createMediaProgressTracker(messages);
  assert.equal(tracker.descriptors.length, 1);
  assert.equal(tracker.descriptors[0].filename, 'home.png');
  assert.ok(tracker.descriptors[0].readSourceRef);
  const observed = observeImagePayloads(messages);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].filename, 'home.png');
  assert.ok(observed[0].readSourceRef);
  assert.equal(observed[0].toolName, 'mcp__playwright__browser_take_screenshot');
});

test('V0.29.81 path-backed but non-releasable images remain retained and are not mislabeled pathless', () => {
  const messages = readPair('pdf-invalid','/work/report.pdf','page',{pages:'not-a-page'});
  const result = normalizeMediaHistory(messages, {...options,maxPathImages:0});
  assert.equal(result.changed,false);
  assert.deepEqual(result.summary, {
    totalImages:1,pathBackedImages:1,pathlessImages:0,
    retainedPathImages:1,releasedPathImages:0,releasedDecodedBytes:0,
  });
  assert.equal(imagesIn(result.messages).length,1);
});

test('V0.29.81 duplicate tool_use IDs are ambiguous and never authorize image release', () => {
  const messages = [
    {role:'assistant',content:[{type:'tool_use',id:'dup',name:'Read',input:{file_path:'/work/a.png'}}]},
    {role:'assistant',content:[{type:'tool_use',id:'dup',name:'Read',input:{file_path:'/work/b.png'}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'dup',content:[image('ambiguous')]}]},
  ];
  const contexts=collectToolMediaContexts(messages);
  assert.equal(contexts.get('dup').ambiguous,true);
  assert.equal(contexts.get('dup').originalPath,'');
  const result=normalizeMediaHistory(messages,{...options,maxPathImages:0});
  assert.equal(result.changed,false);assert.equal(imagesIn(result.messages).length,1);
});

test('V0.29.81 Windows UNC Screenshot paths remain stable and reusable', () => {
  const messages=screenshotPair('unc','Screenshot',{output_path:'\\\\server\\share\\shots\\screen.png'},'unc');
  const context=collectToolMediaContexts(messages).get('unc');
  assert.equal(context.originalPath,'//server/share/shots/screen.png');
});
