import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFileDelivery, runWorker } from '../dist/structured-worker.js';

const delivered = files => ({ status:'completed', summary:'done', question:null, files });
test('structured code becomes real files in the assigned workspace', async () => {
  const root = await mkdtemp(join(tmpdir(),'crew-delivery-'));
  await applyFileDelivery('gemini',root,delivered([{path:'src/ui/AppView.tsx',content:'export const view = 1;'}]));
  assert.equal(await readFile(join(root,'src/ui/AppView.tsx'),'utf8'),'export const view = 1;');
});
test('an invalid second file rejects the entire delivery before the first write', async () => {
  const root = await mkdtemp(join(tmpdir(),'crew-invalid-'));
  for (const path of ['src/core/store.ts','src/ui/../../escape.ts','src/ui/a.ts:stream','src\\ui\\a.ts','src/ui/dist/hidden.ts','src/ui/node_modules/hidden.ts','src/ui/NUL']) {
    await assert.rejects(applyFileDelivery('gemini',root,delivered([
      {path:'src/ui/AppView.tsx',content:'valid'}, {path,content:'bad'},
    ])), /越权|路径无效/);
    await assert.rejects(access(join(root,'src/ui/AppView.tsx')));
  }
});
test('clarification cannot smuggle a partial implementation', async () => {
  const root = await mkdtemp(join(tmpdir(),'crew-question-'));
  await assert.rejects(applyFileDelivery('gemini',root,{
    status:'needs_clarification',summary:'question',question:'where?',files:[{path:'src/ui/App.tsx',content:'partial'}],
  }), /不能夹带文件/);
});

test('a UI owner can use Codex transport and receives existing helper source',async()=>{
  const root=await mkdtemp(join(tmpdir(),'crew-route-worker-'));
  await applyFileDelivery('gemini',root,delivered([{path:'src/ui/helper.ts',content:'export const important = 7;'}]));
  const files=delivered([{path:'src/ui/AppView.tsx',content:'export const view = 1;'}]);
  const result=await runWorker('gemini',root,'UI task','gpt-6-sol',{provider:'codex',model:'gpt-6-sol',role:'ui'},async(route,prompt)=>{
    assert.equal(route.provider,'codex');assert.match(prompt,/important = 7/);
    return {value:files,observedModel:null,output:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(files)}})+'\n'+JSON.stringify({type:'turn.completed',usage:{}}),stderr:''};
  });
  assert.equal(result.result.provider,'codex');
  assert.equal(await readFile(join(root,'src/ui/AppView.tsx'),'utf8'),'export const view = 1;');
});
