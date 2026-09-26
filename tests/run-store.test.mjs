import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, setRunPlan, freezeRun, loadRun, hashTree, withRunLock, saveRun } from '../dist/run-store.js';

const proposal = {
  summary: '本地待办看板，支持排序与分类。',
  acceptanceMapping: {
    'AC-CRUD': '添加编辑删除和完成',
    'AC-CATEGORY': '分类管理',
    'AC-DRAG': '拖拽排序',
    'AC-PERSIST': '刷新保存',
    'AC-RECOVER': '坏数据恢复',
  },
};

test('creates a persisted plan and freezes a template before workers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-run-'));
  const stateRoot = join(root, 'state');
  const output = join(root, 'app');
  const template = fileURLToPath(new URL('../templates/react-todo/', import.meta.url));
  const run = await createRun(stateRoot, '做一个待办应用', output);
  assert.equal(run.status, 'planned');
  assert.equal((await loadRun(stateRoot, run.id)).plan.projectType, 'react-todo');
  await setRunPlan(stateRoot, run.id, proposal);
  const frozen = await freezeRun(stateRoot, run.id, template);
  assert.equal(frozen.status, 'frozen');
  assert.match(frozen.contractHash, /^[a-f0-9]{64}$/);
  assert.equal((await readFile(join(output, 'src', 'contracts', 'index.ts'), 'utf8')).includes('AppViewProps'), true);
  assert.equal((await stat(join(stateRoot, 'runs', run.id, 'baseline', 'CONTRACT.md'))).isFile(), true);
  assert.equal(JSON.parse(await readFile(join(stateRoot, 'runs', run.id, 'plan.json'), 'utf8')).summary, proposal.summary);
  assert.equal(JSON.parse(await readFile(join(stateRoot, 'runs', run.id, 'manifest.json'), 'utf8')).contractHash, frozen.contractHash);
});

test('planner cannot omit a required acceptance ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-plan-'));
  const run = await createRun(join(root, 'state'), '做一个待办应用', join(root, 'app'));
  await assert.rejects(setRunPlan(join(root, 'state'), run.id, { summary: '待办', acceptanceMapping: { 'AC-CRUD': 'only one' } }), /验收映射/);
});

test('template content hash changes on a real file change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-hash-'));
  const file = join(root, 'a.txt');
  await writeFile(file, 'one');
  const before = await hashTree(root);
  await writeFile(file, 'two');
  assert.notEqual(await hashTree(root), before);
});

test('refuses to overwrite an existing output directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-output-'));
  await assert.rejects(createRun(join(root, 'state'), '做一个待办应用', root), /已经存在/);
});

test('a second operation on the same run is rejected while the first holds the lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-lock-'));
  const stateRoot = join(root, 'state');
  const run = await createRun(stateRoot, '做一个待办应用', join(root, 'app'));
  let release;
  const held = withRunLock(stateRoot, run.id, () => new Promise(resolve => { release = resolve; }));
  for (let i = 0; i < 20 && !release; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(withRunLock(stateRoot, run.id, async () => {}), /已有操作/);
  release();
  await held;
  await withRunLock(stateRoot, run.id, async () => {});
});

test('a dead process lock can be recovered without removing a live lock',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'crew-dead-lock-')),root=join(temp,'state');
  const run=await createRun(root,'做一个待办应用',join(temp,'app'));
  const pid=Number(spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'}).stdout);
  const path=join(root,'runs',run.id,'operation.lock');
  await writeFile(path,JSON.stringify({pid,host:hostname(),startedAt:new Date().toISOString()}));
  assert.equal(await withRunLock(root,run.id,async()=>42),42);
  await writeFile(path,JSON.stringify({pid:process.pid,host:hostname(),startedAt:new Date().toISOString()}));
  await assert.rejects(withRunLock(root,run.id,async()=>{}),/已有操作/);
});

test('a crash while recovering a dead lock is itself recoverable',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'crew-recovery-lock-')),root=join(temp,'state');
  const run=await createRun(root,'做一个待办应用',join(temp,'app'));
  const pid=Number(spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'}).stdout);
  const folder=join(root,'runs',run.id);
  for(const name of ['operation.lock','recovery.lock'])await writeFile(join(folder,name),JSON.stringify({pid,host:hostname(),startedAt:new Date().toISOString()}));
  assert.equal(await withRunLock(root,run.id,async()=>7),7);
});

test('freeze can finish after directories were published but final state was interrupted',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'crew-freeze-resume-')),root=join(temp,'state');
  const run=await createRun(root,'做一个待办应用',join(temp,'app'));
  await setRunPlan(root,run.id,proposal);
  const template=fileURLToPath(new URL('../templates/react-todo/',import.meta.url));
  const frozen=await freezeRun(root,run.id,template);
  frozen.status='planned';frozen.completed=frozen.completed.filter(stage=>stage!=='freeze');
  frozen.contractHash=null;frozen.templateHash=null;
  await saveRun(root,frozen);
  assert.equal((await freezeRun(root,run.id,template)).status,'frozen');
});

test('nested source named dist remains part of the source hash',async()=>{
  const root=await mkdtemp(join(tmpdir(),'crew-nested-source-'));
  const folder=join(root,'src/core/dist');await mkdir(folder,{recursive:true});
  await writeFile(join(folder,'helper.ts'),'one');const before=await hashTree(root);
  await writeFile(join(folder,'helper.ts'),'two');assert.notEqual(await hashTree(root),before);
});
