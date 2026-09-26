import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, setRunPlan, freezeRun, hashTree, loadRun, saveRun } from '../dist/run-store.js';
import { executeRun, recheckRun, submitReview } from '../dist/runner.js';
import { publicationDirectory } from '../dist/checkpoints.js';

const template = fileURLToPath(new URL('../templates/react-todo/', import.meta.url));

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-flow-'));
  const stateRoot = join(root, 'state');
  const output = join(root, 'app');
  const run = await createRun(stateRoot, '做一个支持拖拽、分类和本地保存的待办应用', output);
  await setRunPlan(stateRoot, run.id, { summary: '本地待办应用', acceptanceMapping: {
    'AC-CRUD': '增删改完成', 'AC-CATEGORY': '分类', 'AC-DRAG': '拖拽', 'AC-PERSIST': '保存', 'AC-RECOVER': '恢复',
  } });
  await freezeRun(stateRoot, run.id, template);
  return { stateRoot, output, id: run.id };
}

const worker = async (provider, cwd) => {
  const path = provider === 'gemini' ? 'src/ui/AppView.tsx' : 'src/core/store.ts';
  await writeFile(join(cwd, path), provider === 'gemini' ? 'export const ui = true;' : 'export const logic = true;');
  return { result: { provider, complete: true, summary: 'produced', usage: null, model: null, eventCount: 2 }, output: '{}', stderr: '' };
};

const allChecks = [
  { id: 'install', exitCode: 0, count: 0, passed: true },
  { id: 'typecheck', exitCode: 0, count: 0, passed: true },
  { id: 'build', exitCode: 0, count: 0, passed: true },
  { id: 'unit', exitCode: 0, count: 6, passed: true },
  { id: 'browser', exitCode: 0, count: 2, passed: true },
];

test('environment failure can be rechecked without generating or modifying code', async () => {
  const { stateRoot, output, id } = await setup();
  const failed = await executeRun(stateRoot, id, { worker, preflight: async () => {},
    verifier: async dir => ({passed:false,sourceHash:await hashTree(dir),checks:[]}),
  });
  const checked = await recheckRun(stateRoot, id, async dir => ({passed:true,sourceHash:await hashTree(dir),checks:allChecks}));
  assert.equal(checked.verificationPassed,true);
  assert.equal(checked.status,'needs_review');
  assert.equal(checked.sourceHash,failed.sourceHash);
  await writeFile(join(output,'src/core/store.ts'),'modified after verification');
  await assert.rejects(recheckRun(stateRoot,id), /源码已改变/);
});

test('integrates two real isolated file changes and waits for review', async () => {
  const { stateRoot, output, id } = await setup();
  const result = await executeRun(stateRoot, id, {
    worker,
    preflight: async () => {},
    verifier: async dir => ({ passed: true, sourceHash: await hashTree(dir), checks: allChecks }),
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(await readFile(join(output, 'src', 'ui', 'AppView.tsx'), 'utf8'), 'export const ui = true;');
  assert.equal(await readFile(join(output, 'src', 'core', 'store.ts'), 'utf8'), 'export const logic = true;');
  assert.equal(result.workerResults.gemini.status, 'accepted');
  assert.equal(result.workerResults.codex.status, 'accepted');
  const ready = await submitReview(stateRoot, id, { sourceHash: result.sourceHash, issues: [] });
  assert.equal(ready.status, 'ready');
});

test('unauthorized worker edit blocks integration without changing output', async () => {
  const { stateRoot, output, id } = await setup();
  const original = await readFile(join(output, 'src', 'contracts', 'index.ts'), 'utf8');
  const malicious = async (provider, cwd) => {
    const result = await worker(provider, cwd);
    if (provider === 'gemini') await writeFile(join(cwd, 'src', 'contracts', 'index.ts'), 'changed contract');
    return result;
  };
  const result = await executeRun(stateRoot, id, { worker: malicious, preflight: async () => {}, verifier: async () => { throw new Error('should not verify'); } });
  assert.equal(result.status, 'blocked');
  assert.match(result.error, /越权路径/);
  assert.equal(await readFile(join(output, 'src', 'contracts', 'index.ts'), 'utf8'), original);
});

test('machine failure cannot be erased by an empty reviewer report', async () => {
  const { stateRoot, id } = await setup();
  const result = await executeRun(stateRoot, id, {
    worker, preflight: async () => {},
    verifier: async dir => ({ passed: false, sourceHash: await hashTree(dir), checks: [{ id: 'unit', exitCode: 1, count: 6, passed: false }] }),
  });
  assert.equal(result.status, 'needs_review');
  const reviewed = await submitReview(stateRoot, id, { sourceHash: result.sourceHash, issues: [] });
  assert.equal(reviewed.status, 'blocked');
});

test('zero or missing required checks cannot become ready', async () => {
  const { stateRoot, id } = await setup();
  const result = await executeRun(stateRoot, id, {
    worker, preflight: async () => {},
    verifier: async dir => ({ passed: true, sourceHash: await hashTree(dir), checks: [{ id: 'unit', exitCode: 0, count: 0, passed: true }] }),
  });
  const reviewed = await submitReview(stateRoot, id, { sourceHash: result.sourceHash, issues: [] });
  assert.equal(reviewed.status, 'blocked');
});

test('worker question is answered by primary and retried from a clean baseline', async () => {
  const { stateRoot, id } = await setup();
  let geminiCalls = 0;
  const askingWorker = async (provider, cwd, prompt) => {
    if (provider === 'gemini' && geminiCalls++ === 0) {
      await writeFile(join(cwd, 'src', 'ui', 'AppView.tsx'), 'partial, discarded');
      return { result: { provider, complete: true, summary: JSON.stringify({ status: 'needs_clarification', question: '空分类如何放置任务？' }), usage: null, model: null, eventCount: 2 }, output: '{}', stderr: '' };
    }
    if (provider === 'gemini') assert.match(prompt, /可放到空分类末尾/);
    return worker(provider, cwd);
  };
  const result = await executeRun(stateRoot, id, {
    worker: askingWorker, preflight: async () => {},
    arbiter: async question => ({ answer: '可放到空分类末尾，遵循冻结接口。', scopeChange: false, observedModel: 'claude-opus-4-6-thinking' }),
    verifier: async dir => ({ passed: true, sourceHash: await hashTree(dir), checks: allChecks }),
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.dialogue.length, 1);
  assert.equal(result.dialogue[0].provider, 'gemini');
  assert.equal(geminiCalls, 2);
});

test('resume reuses an accepted peer after a worker failure', async () => {
  const { stateRoot, id } = await setup();
  const calls = { gemini: 0, codex: 0 };
  const unstable = async (provider, cwd) => {
    calls[provider]++;
    if (provider === 'codex' && calls.codex === 1) throw new Error('temporary connection failure');
    return worker(provider, cwd);
  };
  const deps = { worker: unstable, preflight: async () => {}, verifier: async dir => ({ passed: true, sourceHash: await hashTree(dir), checks: allChecks }) };
  assert.equal((await executeRun(stateRoot, id, deps)).status, 'failed');
  assert.equal((await loadRun(stateRoot, id)).workerResults.gemini.status, 'checkpointed');
  const resumed = await executeRun(stateRoot, id, deps);
  assert.equal(resumed.status, 'needs_review');
  assert.deepEqual(calls, { gemini: 1, codex: 2 });
  assert.equal(resumed.execution.reusedWorkers, 1);
});

test('a verifier exception resumes checks without rerunning workers', async () => {
  const { stateRoot, id } = await setup();
  let calls = 0, checks = 0;
  const deps = { preflight: async () => {}, worker: async (...args) => { calls++; return worker(...args); }, verifier: async dir => {
    if (++checks === 1) throw new Error('verifier interrupted');
    return { passed: true, sourceHash: await hashTree(dir), checks: allChecks };
  } };
  assert.equal((await executeRun(stateRoot, id, deps)).status, 'failed');
  assert.equal((await executeRun(stateRoot, id, deps)).status, 'needs_review');
  assert.equal(calls, 2);
});

test('resume never overwrites user edits after a worker failed', async () => {
  const { stateRoot, output, id } = await setup();
  await executeRun(stateRoot, id, { worker: async () => { throw new Error('offline'); }, preflight: async () => {} });
  await writeFile(join(output, 'src/core/store.ts'), 'user changes');
  const state = await executeRun(stateRoot, id, { worker, preflight: async () => {} });
  assert.equal(state.status, 'blocked');
  assert.equal(await readFile(join(output, 'src/core/store.ts'), 'utf8'), 'user changes');
});

test('tampered worker checkpoint is blocked before reuse',async()=>{
  const {stateRoot,id}=await setup();
  const state=await executeRun(stateRoot,id,{preflight:async()=>{},worker:async(owner,...args)=>{
    if(owner==='codex')throw new Error('offline');return worker(owner,...args);
  }});
  const checkpoint=state.execution.cycle.checkpoints.gemini;
  await writeFile(join(stateRoot,'runs',id,'cycles','0','gemini',checkpoint.directoryName,'src/ui/AppView.tsx'),'tampered');
  const resumed=await executeRun(stateRoot,id,{preflight:async()=>{},worker});
  assert.equal(resumed.status,'blocked');assert.match(resumed.error,/检查点内容已改变/);
});

test('interrupted output rename recovers from journal without calling models',async()=>{
  const {stateRoot,id,output}=await setup();
  const result=await executeRun(stateRoot,id,{preflight:async()=>{},worker,verifier:async()=>{throw new Error('killed');}});
  // Emulate a process dying after output -> previous-output, before candidate -> output.
  await rename(output,join(publicationDirectory(result),'candidate'));
  result.execution.phase='workers';result.status='running';result.sourceHash=null;
  await saveRun(stateRoot,result);
  const recovered=await executeRun(stateRoot,id,{preflight:async()=>{},worker:async()=>{throw new Error('must not regenerate');},
    verifier:async dir=>({sourceHash:await hashTree(dir),passed:true,checks:allChecks})});
  assert.equal(recovered.status,'needs_review');assert.equal(await readFile(join(output,'src/core/store.ts'),'utf8'),'export const logic = true;');
});

test('review cannot approve a modified frozen plan even if source did not change',async()=>{
  const {stateRoot,id}=await setup();
  const state=await executeRun(stateRoot,id,{preflight:async()=>{},worker,verifier:async dir=>({sourceHash:await hashTree(dir),passed:true,checks:allChecks})});
  state.plan.summary='silently changed after freezing';await saveRun(stateRoot,state);
  await assert.rejects(submitReview(stateRoot,id,{sourceHash:state.sourceHash,issues:[]}),/哈希/);
});

test('user git metadata added during generation is preserved and blocks replacement',async()=>{
  const {stateRoot,id,output}=await setup();
  const result=await executeRun(stateRoot,id,{preflight:async()=>{},worker:async(...args)=>{
    if(args[0]==='gemini'){await mkdir(join(output,'.git'));await writeFile(join(output,'.git','user-history'),'keep me');}
    return worker(...args);
  }});
  assert.equal(result.status,'blocked');assert.match(result.error,/不管理/);
  assert.equal(await readFile(join(output,'.git','user-history'),'utf8'),'keep me');
});
