import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPatch, applyPatch, GateError } from '../dist/patch-gate.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-gate-'));
  const baseline = join(root, 'base');
  const worker = join(root, 'worker');
  const integrated = join(root, 'integrated');
  for (const dir of [baseline, worker, integrated]) {
    await mkdir(join(dir, 'src', 'ui'), { recursive: true });
    await mkdir(join(dir, 'src', 'core'), { recursive: true });
    await writeFile(join(dir, 'src', 'ui', 'AppView.tsx'), 'baseline');
    await writeFile(join(dir, 'src', 'core', 'useTodoApp.ts'), 'baseline');
  }
  return { baseline, worker, integrated };
}

test('accepts a real change in the assigned UI file', async () => {
  const { baseline, worker, integrated } = await fixture();
  await writeFile(join(worker, 'src', 'ui', 'AppView.tsx'), 'new interface');
  const patch = await inspectPatch(baseline, worker, ['src/ui/**']);
  assert.deepEqual(patch.changes.map(change => change.path), ['src/ui/AppView.tsx']);
  await applyPatch(patch, integrated);
  assert.equal(await readFile(join(integrated, 'src', 'ui', 'AppView.tsx'), 'utf8'), 'new interface');
});

test('rejects the whole task if one file is outside ownership', async () => {
  const { baseline, worker, integrated } = await fixture();
  await writeFile(join(worker, 'src', 'ui', 'AppView.tsx'), 'allowed');
  await writeFile(join(worker, 'src', 'core', 'useTodoApp.ts'), 'forbidden');
  await assert.rejects(inspectPatch(baseline, worker, ['src/ui/**']), error => error instanceof GateError && /src\/core\/useTodoApp.ts/.test(error.message));
  assert.equal(await readFile(join(integrated, 'src', 'ui', 'AppView.tsx'), 'utf8'), 'baseline');
});

test('rejects a symlink even inside an owned directory', async () => {
  const { baseline, worker } = await fixture();
  await symlink(join(worker, 'src', 'core', 'useTodoApp.ts'), join(worker, 'src', 'ui', 'linked.tsx'));
  await assert.rejects(inspectPatch(baseline, worker, ['src/ui/**']), /符号链接/);
});

test('rejects deletion of a protected file', async () => {
  const { baseline, worker } = await fixture();
  const { rm } = await import('node:fs/promises');
  await rm(join(worker, 'src', 'core', 'useTodoApp.ts'));
  await assert.rejects(inspectPatch(baseline, worker, ['src/ui/**']), /src\/core\/useTodoApp.ts/);
});
