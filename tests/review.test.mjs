import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, hashTree, saveRun, loadRun, setRunPlan, freezeRun } from '../dist/run-store.js';
import { autoReview } from '../dist/review.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-review-'));
  const stateRoot = join(root, 'state');
  let run = await createRun(stateRoot, '做一个待办应用', join(root, 'app'));
  await setRunPlan(stateRoot,run.id,{summary:'待办',acceptanceMapping:Object.fromEntries(run.plan.acceptanceIds.map(id=>[id,'实现要求']))});
  run = await freezeRun(stateRoot,run.id,fileURLToPath(new URL('../templates/react-todo/',import.meta.url)));
  await writeFile(join(run.outputDir, 'app.ts'), 'export const task = 1;');
  run.sourceHash = await hashTree(run.outputDir);
  run.status = 'needs_review';
  run.verificationPassed = false;
  await saveRun(stateRoot, run);
  return { stateRoot, run };
}

test('independent agy review contains source evidence and cannot override failed tests', async () => {
  const { stateRoot, run } = await setup();
  const reviewed = await autoReview(stateRoot, run.id, async (route, prompt) => {
    assert.equal(route.provider, 'agy');
    assert.equal(route.role, 'review');
    assert.match(prompt, /export const task = 1/);
    return { value: { sourceHash: run.sourceHash, issues: [] }, observedModel: route.model };
  });
  assert.equal(reviewed.status, 'blocked');
  assert.equal(reviewed.review.observedModel, 'claude-opus-4-6-thinking');
});

test('source changes during the model review invalidate that review', async () => {
  const { stateRoot, run } = await setup();
  await assert.rejects(autoReview(stateRoot, run.id, async route => {
    await writeFile(join(run.outputDir, 'app.ts'), 'export const task = 2;');
    return { value: { sourceHash: run.sourceHash, issues: [] }, observedModel: route.model };
  }), /源码哈希不匹配/);
  assert.equal((await loadRun(stateRoot, run.id)).status, 'needs_review');
});
