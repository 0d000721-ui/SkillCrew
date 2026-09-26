import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, setRunPlan, freezeRun, hashTree, loadRun, saveRun } from '../dist/run-store.js';
import { submitReview } from '../dist/runner.js';

const template = fileURLToPath(new URL('../templates/react-todo/', import.meta.url));
const checks = ['install','typecheck','build','unit','browser'].map(id => ({ id, passed: true, exitCode: 0, count: id === 'unit' ? 6 : id === 'browser' ? 2 : 0 }));
async function setup() {
  const temp = await mkdtemp(join(tmpdir(),'crew-next-')), root = join(temp,'state');
  const run = await createRun(root,'做一个待办应用',join(temp,'app'));
  await setRunPlan(root,run.id,{summary:'待办',acceptanceMapping:Object.fromEntries(run.plan.acceptanceIds.map(id=>[id,'按接口验收']))});
  await freezeRun(root,run.id,template);
  return { root, id:run.id, output:run.outputDir };
}
async function workflow() {
  const module = await import('../dist/workflow.js').catch(()=>({}));
  assert.equal(typeof module.continueWorkflow,'function','next version must provide the complete workflow');
  return module.continueWorkflow;
}
const worker = async (owner,cwd,prompt) => {
  await writeFile(join(cwd,owner === 'gemini' ? 'src/ui/AppView.tsx' : 'src/core/store.ts'),prompt.includes('REPAIR TASK')?'repaired code':'initial code');
  return { result:{ provider:owner === 'gemini'?'agy':'codex',complete:true,summary:'done',model:null,usage:null,eventCount:2 }, output:'{}',stderr:'' };
};
const reviewer = async (root,id) => submitReview(root,id,{sourceHash:(await loadRun(root,id)).sourceHash,issues:[]});

test('failed checks repair only the responsible owner and recheck before fresh review',async()=>{
  const run = await setup(), execute = await workflow(), calls = [], progress = [];
  let verification = 0, reviews = 0;
  const deps = { preflight:async()=>{}, worker:async(...args)=>{calls.push(args[0]);return worker(...args);},
    verifier:async dir=>({sourceHash:await hashTree(dir),passed:++verification>1,checks:verification>1?checks:[{id:'typecheck',passed:false,exitCode:1,output:'src/core/store.ts error'}]}),
    reviewer:async(...args)=>{reviews++;return reviewer(...args);},
    triage:async()=>({action:'repair',reason:'逻辑类型错误',tasks:[{owner:'codex',instructions:'修复 src/core/store.ts 类型错误'}]}),
    onProgress:(stage)=>progress.push(stage) };
  const result = await execute(run.root,run.id,{maxRepairRounds:2},deps);
  assert.equal(result.status,'ready');
  assert.deepEqual(calls.slice(0,2).sort(),['codex','gemini']);
  assert.equal(calls[2],'codex');
  assert.equal(reviews,1);
  assert.equal(verification,2);
  assert.equal(result.execution.history.length,1);
  assert.ok(progress.includes('repair'));
  const again = await execute(run.root,run.id,{},deps);
  assert.equal(again.status,'ready');
  assert.equal(calls.length,3);
});

test('repair limit persists across resume and leaves actionable evidence',async()=>{
  const run = await setup(), execute = await workflow();
  let calls=0;
  const deps = { preflight:async()=>{},worker:async(...args)=>{calls++;return worker(...args);},
    verifier:async dir=>({sourceHash:await hashTree(dir),passed:false,checks:[{id:'unit',passed:false,exitCode:1,output:'wrong order'}]}),reviewer,
    triage:async()=>({action:'repair',reason:'排序错误',tasks:[{owner:'codex',instructions:'修复排序'}]}) };
  // Every repair must make a real change; encode the invocation count in the file.
  deps.worker=async(owner,cwd,prompt)=>{calls++;const result=await worker(owner,cwd,prompt);await writeFile(join(cwd,owner==='gemini'?'src/ui/AppView.tsx':'src/core/store.ts'),'version '+calls);return result;};
  const result=await execute(run.root,run.id,{maxRepairRounds:2},deps);
  assert.equal(result.status,'blocked');
  assert.equal(result.execution.cycle.round,2);
  assert.match(result.error,/修复.*上限/);
  await execute(run.root,run.id,{},deps);
  assert.equal(calls,4);
  await assert.rejects(execute(run.root,run.id,{maxRepairRounds:1},deps),/不能更改/);
});

test('dependency installation failure does not spend model calls repairing code',async()=>{
  const run=await setup(),execute=await workflow();
  const result=await execute(run.root,run.id,{}, {preflight:async()=>{},worker,
    verifier:async dir=>({sourceHash:await hashTree(dir),passed:false,checks:[{id:'install',passed:false,exitCode:1,output:'network offline'}]}),
    triage:async()=>{throw new Error('must not call a model for install failure');},reviewer});
  assert.equal(result.status,'blocked');
  assert.match(result.error,/环境/);
  assert.equal(result.execution.cycle.round,0);
});

test('a high review issue goes to its file owner and gets a new review',async()=>{
  const run=await setup(),execute=await workflow();let reviews=0;
  const result=await execute(run.root,run.id,{}, {preflight:async()=>{},worker,
    verifier:async dir=>({sourceHash:await hashTree(dir),passed:true,checks}),
    reviewer:async(root,id)=>{reviews++;return submitReview(root,id,{sourceHash:(await loadRun(root,id)).sourceHash,issues:reviews===1?[{severity:'high',file:'src/ui/AppView.tsx',acceptanceId:'AC-CRUD',expected:'显示错误',observed:'不显示',owner:'gemini',repro:'模拟失败',reproductionStatus:'proposed'}]:[]});},
    triage:async()=>({action:'repair',reason:'界面错误提示缺失',tasks:[{owner:'gemini',instructions:'补充错误提示'}]})});
  assert.equal(result.status,'ready');assert.equal(reviews,2);
  assert.equal(await readFile(join(run.output,'src/core/store.ts'),'utf8'),'initial code');
});

test('a separate request field cannot change what a frozen run asks models to do',async()=>{
  const run=await setup(),execute=await workflow(),state=await loadRun(run.root,run.id);
  state.request='changed after freeze';await saveRun(run.root,state);
  const result=await execute(run.root,run.id,{}, {worker:async()=>{throw new Error('must not invoke');}});
  assert.equal(result.status,'blocked');assert.match(result.error,/冻结计划不一致/);
});
