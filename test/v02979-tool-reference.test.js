import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareToolReferenceCompatibility } from '../src/proxy/tool-reference-compat.js';

const a = { name: 'mcp__comfyui__get_image', description: 'Fetch and save a generated image.',
  input_schema: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] }, defer_loading: true };
const b = { name: 'mcp__github__list_issues', description: 'List repository issues.',
  input_schema: { type: 'object', properties: { repo: { type: 'string' } } }, defer_loading: true };
const searchTool = { name: 'ToolSearch', description: 'Search tools', input_schema: { type: 'object' } };
const ref = (...args) => ({ type: 'tool_reference', tool_name: args.length ? args[0] : a.name });
const toolResult = (parts, id = 'toolu_search_1') => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: parts }] });
const request = (parts = [ref()]) => ({ model: 'claude-opus-5-5', stream: true,
  tools: [searchTool, a, b], messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_search_1', name: 'ToolSearch', input: { query: 'picture' } }] },
    toolResult(parts),
  ] });
const adapt = (r, mode = 'compat', protocol = 'anthropic') => prepareToolReferenceCompatibility(r, { mode, protocol });

function assertError(run, code) { assert.throws(run, error => error?.status === 400 && error.code === code && !/mcp__/.test(error.message)); }

test('v0.29.79 resolved reference has callable exact schema and no defer_loading', () => {
  const input = request(), before = structuredClone(input);
  const result = adapt(input);
  assert.equal(result.changed, true); assert.equal(result.referenceCount, 1); assert.equal(result.materializedCount, 1);
  assert.equal(result.request.tools[1].defer_loading, false);
  assert.deepEqual(result.request.tools[1].input_schema, a.input_schema);
  assert.equal(result.request.tools[2].defer_loading, true);
  assert.equal(result.request.messages[1].content[0].tool_use_id, 'toolu_search_1');
  const item = result.request.messages[1].content[0].content[0];
  assert.equal(item.type, 'text'); assert.match(item.text, /mcp__comfyui__get_image/);
  assert.match(item.text, /complete input JSON Schema/);
  assert.deepEqual(input, before, 'request and definitions must not be mutated');
});

test('v0.29.79 mixed image/text/reference preserves original order, tool id and extra flags', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const r = request([{type:'text',text:'Found:'},image,ref(),{type:'text',text:'Done'}]);
  r.messages[1].content[0].is_error = false;
  const result = adapt(r).request.messages[1].content[0];
  assert.equal(result.tool_use_id, 'toolu_search_1'); assert.equal(result.is_error,false);
  assert.deepEqual(result.content.map(x => x.type), ['text','image','text','text']);
  assert.deepEqual(result.content[1],image);
});

test('v0.29.79 repeated references are allowed, corresponding schemas materialize only once', () => {
  const r = request([ref(a.name),ref(b.name),ref(a.name)]);
  const out = adapt(r); assert.equal(out.referenceCount,3); assert.equal(out.materializedCount,2);
  assert.equal(out.request.tools[1].defer_loading,false); assert.equal(out.request.tools[2].defer_loading,false);
});

for (const bad of ['', null, undefined, '\ncommand', 'bad,tool', 123, 'a'.repeat(257)]) {
  test(`v0.29.79 invalid reference tool_name ${JSON.stringify(bad)}`, () => {
    assertError(() => adapt(request([ref(bad)])), 'tool_reference_invalid');
  });
}

test('v0.29.79 missing definition fails closed and never invents schema', () => {
  assertError(() => adapt(request([ref('mcp__unknown__delete_files')])), 'tool_reference_missing_definition');
});

test('v0.29.79 duplicate exact names fail closed instead of picking one', () => {
  const r=request(); r.tools.push({...a});
  assertError(() => adapt(r), 'tool_reference_ambiguous_definition');
});

for (const definition of [
  {...a, input_schema:null}, {...a, input_schema:[]}, {...a, input_schema:{type:'array'}},
  {...a, type:'web_search_20260318'}, {...a, description: {nested:true}},
]) {
  test(`v0.29.79 tool schema/type is checked (${JSON.stringify(definition).slice(0,85)})`, () => {
    const r=request();r.tools[1]=definition;
    assertError(() => adapt(r),definition.type && definition.type!=='custom'?'tool_reference_not_client_tool':'tool_reference_invalid_schema');
  });
}

test('v0.29.79 native Anthropic passthrough is byte-for-byte semantically unchanged', () => {
  const r=request();const out=adapt(r,'passthrough','anthropic');
  assert.equal(out.changed,false);assert.strictEqual(out.request,r);
});

test('v0.29.79 OpenAI cannot silently lose refs when passthrough requested', () => {
  assertError(()=>adapt(request(),'passthrough','openai'),'tool_reference_passthrough_openai');
});

test('v0.29.79 ordinary user tool_result without refs remains identical', () => {
  const r=request([{type:'text',text:'OK'}]); const out=adapt(r);
  assert.equal(out.changed,false);assert.strictEqual(out.request,r);
});

test('v0.29.79 server Tool Search result is validated and converted to text + callable schemas', () => {
  const r={model:'claude-opus-5-5',tools:[a,b],messages:[
    {role:'assistant',content:[
      {type:'text',text:'Searching'},
      {type:'server_tool_use',id:'srvtoolu_x',name:'tool_search_tool_bm25',input:{query:'image'}},
      {type:'tool_search_tool_result',tool_use_id:'srvtoolu_x',content:{type:'tool_search_tool_search_result',tool_references:[ref(a.name),ref(b.name)]}},
      {type:'text',text:'Done'},
    ]},
  ]};
  const out=adapt(r);assert.equal(out.referenceCount,2);
  assert.deepEqual(out.request.messages[0].content.map(x=>x.type),['text','text','text','text']);
  assert.match(out.request.messages[0].content[2].text,/mcp__comfyui__get_image/);
  assert.equal(out.request.tools[0].defer_loading,false);assert.equal(out.request.tools[1].defer_loading,false);
  assert.deepEqual(r.messages[0].content[2].content.tool_references,[ref(a.name),ref(b.name)]);
});

test('v0.29.79 empty search returns bounded readable result (no phantom tools)', () => {
  const r={tools:[a],messages:[{role:'assistant',content:[
    {type:'server_tool_use',id:'s1',name:'tool_search_tool_regex',input:{pattern:'x'}},
    {type:'tool_search_tool_result',tool_use_id:'s1',content:{type:'tool_search_tool_search_result',tool_references:[]}},
  ]}]};
  const out=adapt(r);assert.equal(out.materializedCount,0);assert.match(out.request.messages[0].content[1].text,/no tools matched/);
});

test('v0.29.79 orphan server result cannot bypass identity check', () => {
  const r={tools:[a],messages:[{role:'assistant',content:[
    {type:'tool_search_tool_result',tool_use_id:'missing',content:{type:'tool_search_tool_search_result',tool_references:[ref()]}}
  ]}]};
  assertError(()=>adapt(r),'tool_reference_invalid_history');
});

test('v0.29.79 unknown tool_result parts are preserved rather than rewritten or swallowed', () => {
  const part={type:'document',source:{type:'base64',media_type:'application/pdf',data:'AA=='}};
  const r=request([part,ref()]);const out=adapt(r);
  assert.deepEqual(out.request.messages[1].content[0].content[0],part);
});

test('v0.29.79 rejects more than the bounded number of references', () => {
  assertError(()=>adapt(request(Array.from({length:257},()=>ref()))),'tool_reference_limit');
});

test('v0.29.79 all request-local definitions stay request local', () => {
  const r1=request();const r2=request([ref(b.name)]);
  const [a1,a2]=[adapt(r1),adapt(r2)];
  assert.deepEqual(a1.request.tools.map(x=>x.defer_loading),[undefined,false,true]);
  assert.deepEqual(a2.request.tools.map(x=>x.defer_loading),[undefined,true,false]);
});

test('v0.29.79 invalid top-level tool_reference location fails closed', () => {
  assertError(()=>adapt({tools:[a],messages:[{role:'user',content:[ref()]}]}),'tool_reference_invalid_location');
});
test('v0.29.79 unpaired server search call fails closed', () => {
  const r={tools:[a],messages:[{role:'assistant',content:[
    {type:'server_tool_use',id:'s1',name:'tool_search_tool_regex',input:{pattern:'x'}}
  ]}]};
  assertError(()=>adapt(r),'tool_reference_invalid_history');
});

test('v0.29.79 TensorFold-compatible parser sees text not tool_reference', () => {
  const normalized=adapt(request([{type:'text',text:'Found tools:'},ref(a.name),ref(b.name)]));
  const parts=normalized.request.messages[1].content[0].content;
  assert.ok(parts.every(part=>['text','image','document'].includes(part.type)));
  assert.deepEqual(normalized.request.tools.filter(t=>t.defer_loading===false).map(t=>t.name),[a.name,b.name]);
});

test('v0.29.79 OpenAI adapter explicitly rejects raw references, accepts normalized references', async () => {
  const { toOpenAIRequest } = await import('../src/services/openai-upstream-adapter.js');
  const r=request();
  assert.throws(()=>toOpenAIRequest(r),e=>e.status===400 && e.code==='tool_reference_unconverted');
  const converted=toOpenAIRequest(adapt(r,'compat','openai').request);
  const toolResult=converted.messages.find(x=>x.role==='tool' && x.tool_call_id==='toolu_search_1');
  assert.ok(toolResult && toolResult.content.includes(a.name));
  assert.ok(converted.tools.some(x=>x.function?.name===a.name && x.function?.parameters?.type==='object'));
});
