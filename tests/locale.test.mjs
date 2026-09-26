import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRouting, routingSummary } from '../dist/routing.js';
import { createRun, setRunPlan, loadRun, saveRun, freezeRun, hashTree } from '../dist/run-store.js';
import { renderReport } from '../dist/report.js';
import { freezePlan } from '../dist/protocol.js';
import { runPlanning } from '../dist/planning.js';
import { continueWorkflow } from '../dist/workflow.js';
import { autoReview } from '../dist/review.js';

const cli = fileURLToPath(new URL('../bin/skillcrew.mjs', import.meta.url));
const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, SKILLCREW_LANG: 'zh-CN' } });
const inventory = { agy: ['claude-opus-4-6-thinking', 'gemini-3.8-flash-high'], codex: ['gpt-6-astra', 'gpt-6-sol'] };
const mapping = { 'AC-CRUD': 'CRUD', 'AC-CATEGORY': 'Categories', 'AC-DRAG': 'Drag', 'AC-PERSIST': 'Save', 'AC-RECOVER': 'Recover' };
async function api() {
  const module = await import('../dist/i18n.js').catch(() => ({}));
  assert.equal(typeof module.resolveLocale, 'function', 'system locale resolver must be available');
  return module;
}

test('locale precedence, POSIX variants and unavailable system language have deterministic fallbacks', async () => {
  const { resolveLocale } = await api();
  const context = { platform: 'linux', env: { SKILLCREW_LANG: 'zh_CN.UTF-8', LC_ALL: 'en_GB.UTF-8', LANG: 'zh_CN' }, systemLocale: () => 'zh-CN' };
  assert.equal(resolveLocale('en-US', context).language, 'en');
  assert.equal(resolveLocale(undefined, context).language, 'zh-CN');
  assert.equal(resolveLocale('auto', context).language, 'en');
  assert.equal(resolveLocale(undefined, { platform: 'linux', env: { LC_ALL: 'C', LANG: 'zh_CN' }, systemLocale: () => 'zh-CN' }).language, 'en');
  assert.equal(resolveLocale(undefined, { env: {}, systemLocale: () => 'zh-Hans-HK' }).language, 'zh-CN');
  const unsupported = resolveLocale(undefined, { env: {}, systemLocale: () => 'ja-JP' });
  assert.equal(unsupported.language, 'en'); assert.equal(unsupported.fallback, true);
  assert.equal(resolveLocale(undefined, { env: {}, systemLocale: () => { throw new Error('unavailable'); } }).language, 'en');
  assert.throws(() => resolveLocale('en/../../file', context), /language|语言/i);
});

test('desktop UI language takes priority over a terminal C locale', async () => {
  const { resolveLocale } = await api();
  for (const platform of ['win32', 'darwin']) {
    const context = { platform, env: { LC_ALL: 'C.UTF-8', LANG: 'en_US.UTF-8' }, systemLocale: () => 'zh-CN' };
    assert.equal(resolveLocale('auto', context).language, 'zh-CN');
    assert.equal(resolveLocale('en', context).language, 'en');
    assert.equal(resolveLocale(undefined, { ...context, systemLocale: () => { throw new Error('not available'); } }).language, 'en');
  }
});

test('language contexts stay separate across concurrent commands', async () => {
  const { resolveLocale, withLocale } = await api();
  const route = defaultRouting();
  const [english, chinese] = await Promise.all(['en', 'zh-CN'].map(language => withLocale(resolveLocale(language), async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return routingSummary(route);
  })));
  assert.match(english, /Primary model/); assert.doesNotMatch(english, /主模型/);
  assert.match(chinese, /主模型/); assert.doesNotMatch(chinese, /Primary model/);
});

test('CLI language flag works before a command and overrides the environment for help and errors', () => {
  const english = invoke('--lang', 'en-US', '--help');
  assert.equal(english.status, 0, english.stderr); assert.match(english.stdout, /Options:/);
  const chinese = invoke('--help', '--lang=zh-CN');
  assert.equal(chinese.status, 0, chinese.stderr); assert.match(chinese.stdout, /选项/);
  const invalid = invoke('--lang', 'en', 'init');
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Missing/); assert.doesNotMatch(invalid.stderr, /缺少|路径/);
  const locale = invoke('locale', '--lang', 'en');
  assert.equal(locale.status, 0, locale.stderr);
  const info = JSON.parse(locale.stdout);
  assert.equal(info.language, 'en'); assert.match(info.choices.automatic, /Automatic/);
});

test('asynchronous CLI failures retain the selected language', () => {
  for (const command of ['resume', 'check', 'review-auto', 'run']) {
    const result = invoke(command, 'invalid', '--lang', 'en');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid run ID/);
    assert.doesNotMatch(result.stderr, /[\u3400-\u9fff]/);
  }
});

test('routing presentation changes language while the machine route stays stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crew-locale-cli-')), file = join(root, 'inventory.json');
  await writeFile(file, JSON.stringify(inventory));
  const en = invoke('route', '--inventory-file', file, '--lang', 'en');
  const zh = invoke('route', '--inventory-file', file, '--lang', 'zh-CN');
  assert.equal(en.status, 0, en.stderr); assert.equal(zh.status, 0, zh.stderr);
  assert.match(en.stderr, /Primary model/); assert.doesNotMatch(en.stderr, /[\u3400-\u9fff]/);
  assert.match(zh.stderr, /主模型/);
  for (const key of ['mode', 'primary', 'coLead', 'ui', 'logic']) assert.deepEqual(JSON.parse(en.stdout)[key], JSON.parse(zh.stdout)[key]);
  await writeFile(file, JSON.stringify({ agy: inventory.agy, codex: [] }));
  const fallback = invoke('route', '--inventory-file', file, '--lang', 'en');
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stderr, /using one lead/);
  assert.match(fallback.stderr, /Logic work/);
  assert.doesNotMatch(fallback.stderr, /[\u3400-\u9fff]/);
});

test('wrapped worker failures translate known messages while preserving paths and external details', async () => {
  const { diagnostic } = await api();
  assert.equal(diagnostic('Error: 代码交付格式无效。; Error: 主模型的修复裁决无效。', 'en'),
    'Error: Invalid code delivery format.; Error: The primary returned an invalid repair decision.');
  assert.equal(diagnostic('Error: agy 调用失败（1）：远端原始消息', 'en'), 'Error: agy call failed (1): 远端原始消息');
  assert.equal(diagnostic('输出目录已经存在：C:\\用户\\未冻结', 'en'), 'Output directory already exists: C:\\用户\\未冻结');
  assert.equal(diagnostic('用户自己写的原始说明：主模型', 'en'), '用户自己写的原始说明：主模型');
});

test('reports translate presentation and known diagnostics without changing saved evidence or hashes', async () => {
  const { resolveLocale, withLocale } = await api();
  const temporary = await mkdtemp(join(tmpdir(), 'crew-locale-report-')), root = join(temporary, 'state');
  const state = await createRun(root, '做一个待办应用，保留原始需求。', join(temporary, 'app'));
  const planned = await setRunPlan(root, state.id, { summary: '原始模型摘要', acceptanceMapping: mapping });
  planned.error = '源码已改变，不能沿用已有交付记录。';
  const saved = JSON.stringify(planned), hash = freezePlan(planned.plan, {}, 'fixture');
  const report = withLocale(resolveLocale('en'), () => renderReport(planned));
  assert.match(report, /SkillCrew run report/); assert.match(report, /Source has changed/);
  assert.ok(report.includes('做一个待办应用，保留原始需求。'));
  assert.doesNotMatch(report, /运行报告|模型与 Skill 分工|阻塞原因/);
  assert.equal(JSON.stringify(planned), saved); assert.equal(freezePlan(planned.plan, {}, 'fixture'), hash);
});

test('new model explanations keep their creation language when display language changes', async () => {
  const { resolveLocale, withLocale } = await api();
  const temporary = await mkdtemp(join(tmpdir(), 'crew-locale-plan-')), root = join(temporary, 'state');
  const state = await withLocale(resolveLocale('en'), () => createRun(root, 'Build a todo app', join(temporary, 'app')));
  assert.equal(state.plan.responseLanguage, 'en');
  await withLocale(resolveLocale('zh-CN'), () => runPlanning(root, state.id, { call: async (route, prompt, phase) => {
    assert.match(prompt, /USER-FACING LANGUAGE: English/);
    return { observedModel: route.model, value: phase === 'consult' ? { notes: [] } : { summary: 'Todo app', acceptanceMapping: mapping, decisions: [] } };
  } }));
  assert.equal((await loadRun(root, state.id)).plan.responseLanguage, 'en');
});

test('legacy planning checkpoints survive a display-language change without new prompt instructions', async () => {
  const { resolveLocale, withLocale } = await api();
  const temporary = await mkdtemp(join(tmpdir(), 'crew-locale-legacy-')), root = join(temporary, 'state');
  const state = await createRun(root, 'Build a todo app', join(temporary, 'app'));
  delete state.plan.responseLanguage;
  await saveRun(root, state);
  const calls = { draft: 0, ui: 0, logic: 0, final: 0 };
  const call = async (route, prompt, phase) => {
    assert.doesNotMatch(prompt, /USER-FACING LANGUAGE/);
    const key = phase === 'consult' ? route.role : phase;
    calls[key]++;
    if (key === 'logic' && calls.logic === 1) throw new Error('temporary failure');
    return { observedModel: route.model, value: phase === 'consult' ? { notes: [] } : { summary: 'Todo', acceptanceMapping: mapping, decisions: [] } };
  };
  await assert.rejects(withLocale(resolveLocale('en'), () => runPlanning(root, state.id, { call })), /temporary failure/);
  await withLocale(resolveLocale('zh-CN'), () => runPlanning(root, state.id, { call }));
  assert.deepEqual(calls, { draft: 1, ui: 1, logic: 2, final: 1 });
});

test('worker, repair and independent review calls use the frozen response language', async () => {
  const { resolveLocale, withLocale } = await api();
  const temporary = await mkdtemp(join(tmpdir(), 'crew-locale-workflow-')), root = join(temporary, 'state');
  const state = await withLocale(resolveLocale('en'), () => createRun(root, 'Build a todo app', join(temporary, 'app')));
  await setRunPlan(root, state.id, { summary: 'Todo', acceptanceMapping: mapping });
  await freezeRun(root, state.id, fileURLToPath(new URL('../templates/react-todo/', import.meta.url)));
  let checks = 0, workers = 0, reviews = 0;
  const result = await withLocale(resolveLocale('zh-CN'), () => continueWorkflow(root, state.id, {}, {
    preflight: async () => {},
    worker: async (owner, cwd, prompt) => {
      assert.match(prompt, /USER-FACING LANGUAGE: English/);
      workers++;
      await writeFile(join(cwd, owner === 'gemini' ? 'src/ui/AppView.tsx' : 'src/core/store.ts'),
        prompt.includes('REPAIR TASK') ? 'repaired fixture' : 'initial fixture');
      return { result: { provider: owner === 'gemini' ? 'agy' : 'codex', complete: true, summary: 'fixture', model: null, usage: null, eventCount: 2 }, output: '{}', stderr: '' };
    },
    // Verification is injected: this test checks language propagation, not app correctness.
    verifier: async cwd => ({ sourceHash: await hashTree(cwd), passed: ++checks > 1,
      checks: checks > 1 ? ['install', 'typecheck', 'build', 'unit', 'browser'].map(id =>
        ({ id, passed: true, exitCode: 0, count: id === 'unit' ? 6 : id === 'browser' ? 2 : 0 })) :
        [{ id: 'typecheck', passed: false, exitCode: 1, output: 'fixture failure' }] }),
    triage: async () => ({ action: 'repair', reason: 'Fixture failure', tasks: [{ owner: 'codex', instructions: 'Fix the fixture' }] }),
    reviewer: (root, id) => autoReview(root, id, async (route, prompt) => {
      reviews++;
      assert.match(prompt, /USER-FACING LANGUAGE: English/);
      return { observedModel: route.model, value: { sourceHash: (await loadRun(root, id)).sourceHash, issues: [] } };
    }),
  }));
  assert.equal(result.status, 'ready'); assert.equal(workers, 3); assert.equal(reviews, 1);
});

test('installed skill metadata and standalone runtime honor the selected language', async () => {
  const project = await mkdtemp(join(tmpdir(), 'crew-locale-install-'));
  const result = spawnSync(process.execPath, [installer, '--project', project, '--lang', 'en'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const skill = join(project, '.agents/skills/skillcrew');
  const document = await readFile(join(skill, 'SKILL.md'), 'utf8');
  assert.match(document, /description:.*Build React todo apps/);
  const runtime = spawnSync(process.execPath, [join(skill, 'runtime/bin/skillcrew.mjs'), 'locale', '--lang', 'zh-CN'], { encoding: 'utf8' });
  assert.equal(runtime.status, 0, runtime.stderr);
  assert.equal(JSON.parse(runtime.stdout).language, 'zh-CN');
});
