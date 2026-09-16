import test from 'node:test';
import assert from 'node:assert/strict';
import { clientImageTools, validClientImageCall, isCompleteEvidence } from '../src/visual/visual-recovery-context.js';
const read={name:'Read',input_schema:{type:'object',properties:{file_path:{type:'string'}},required:['file_path']}};
const call={type:'tool_use',id:'r',name:'Read',input:{file_path:'/invented.png'}};
test('V0.30.7 image acquisition never invents a Read path without source metadata',()=>{
  assert.equal(validClientImageCall(call,[read],[]),false);
});
test('V0.30.7 mentioning Read in another tool description does not authorize image acquisition',()=>{
  assert.deepEqual(clientImageTools([{name:'Write',description:'Read this description before overwriting a file.'},{name:'Bash',description:'Use Read for image files.'},read]),[read]);
});
test('V0.30.7 multi-source evidence is not reused as a single remapped source',()=>{
  assert.equal(isCompleteEvidence({plan:{source_ids:['img_01','img_02'],questions:[{id:'q'}]},perception:{status:'complete',answers:[{question_id:'q',answer:'Compared both'}],source_results:[]}}),false);
});

test('V0.30.7 screenshot and attachment tools must address the recorded source target',()=>{
  const tool={name:'browser_screenshot',input_schema:{type:'object',properties:{target:{type:'string'}},required:['target']}};
  const hints=[{locator:{toolName:'browser_screenshot',input:{target:'requested-tab'}}}];
  assert.equal(validClientImageCall({type:'tool_use',id:'s',name:tool.name,input:{target:'other-tab'}},[tool],hints),false);
  assert.equal(validClientImageCall({type:'tool_use',id:'s',name:tool.name,input:{target:'requested-tab'}},[tool],hints),true);
});
