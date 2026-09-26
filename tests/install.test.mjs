import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));

test('agy project installer copies a standalone skill/runtime without overwriting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-install-'));
  const install = spawnSync(process.execPath, [installer, '--project', root], { encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const skillRoot = join(root, '.agents', 'skills', 'skillcrew');
  const runtime = join(skillRoot, 'runtime', 'bin', 'skillcrew.mjs');
  assert.ok((await stat(runtime)).isFile());
  assert.equal(JSON.parse(install.stdout).agent, null);
  assert.equal(JSON.parse(install.stdout).host, 'agy');
  const instructions = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
  assert.ok(instructions.includes(runtime.replaceAll('\\','/')));
  assert.ok(!instructions.includes('{{SKILLCREW_RUNTIME}}'));
  const inventory = join(root, 'inventory.json');
  await writeFile(inventory, JSON.stringify({ agy: ['claude-opus-4-6-thinking', 'gemini-3.8-flash-high'], codex: ['gpt-6-astra', 'gpt-6-sol'] }));
  const route = spawnSync(process.execPath, [runtime, 'route', '--inventory-file', inventory], { encoding: 'utf8' });
  assert.equal(route.status, 0, route.stderr);
  assert.equal(JSON.parse(route.stdout).primary.model, 'gpt-6-astra');
  assert.equal(JSON.parse(route.stdout).coLead.model, 'claude-opus-4-6-thinking');
  const request = join(root, 'request.json');
  const plan = join(root, 'plan.json');
  const state = join(root, 'state');
  await writeFile(request, JSON.stringify({ request: '做一个待办应用' }));
  await writeFile(plan, JSON.stringify({ summary: '待办', acceptanceMapping: {
    'AC-CRUD': '操作', 'AC-CATEGORY': '分类', 'AC-DRAG': '拖动', 'AC-PERSIST': '持久化', 'AC-RECOVER': '恢复',
  } }));
  const init = spawnSync(process.execPath, [runtime, 'init', '--request-file', request, '--out', join(root, 'generated'), '--state-dir', state, '--inventory-file', inventory], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const runId = JSON.parse(init.stdout).id;
  assert.equal(spawnSync(process.execPath, [runtime, 'set-plan', runId, '--file', plan, '--state-dir', state], { encoding: 'utf8' }).status, 0);
  const frozen = spawnSync(process.execPath, [runtime, 'freeze', runId, '--state-dir', state], { encoding: 'utf8' });
  assert.equal(frozen.status, 0, frozen.stderr);
  assert.ok((await stat(join(root, 'generated', 'CONTRACT.md'))).isFile());
  const repeat = spawnSync(process.execPath, [installer, '--project', root], { encoding: 'utf8' });
  assert.equal(repeat.status, 2);
  assert.ok((await stat(runtime)).isFile());
  assert.match(await readFile(join(skillRoot, 'SKILL.md'), 'utf8'), /冻结接口/);
});

test('optional Claude host remains installable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillcrew-claude-install-'));
  const install = spawnSync(process.execPath, [installer, '--project', root, '--host', 'claude'], { encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  assert.match(await readFile(join(root, '.claude', 'agents', 'skillcrew-reviewer.md'), 'utf8'), /model: opus/);
});
