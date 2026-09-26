import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, freezeRun, loadRun, setRunPlan, withRunLock } from './run-store.js';
import { runPlanning } from './planning.js';
import { routingSummary, type LeadPreference, type RouteOverrides } from './routing.js';
import { defaultPreflight, executeRun, recheckRun, submitReview } from './runner.js';
import { saveReport } from './report.js';
import { executable, npmExecutable } from './process.js';
import { verificationMode, verifyProject, type VerificationMode } from './verify.js';
import { autoReview } from './review.js';
import { continueWorkflow } from './workflow.js';
import { discoverModels, readCatalog, selectRouting, withLocalReliability, type ModelInventory } from './model-catalog.js';
import { loadSkills } from './skills.js';
import { diagnostic, languageArguments, localePresentation, text, withLocale } from './i18n.js';

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? required(args[index + 1], text('{name} 的值', { name })) : undefined;
}

function required(value: string | undefined, description: string): string {
  if (!value || value.startsWith('--')) throw new Error(text('缺少 {description}。', { description }));
  return value;
}

async function probe(name: string, file: string, args: string[]): Promise<{ name: string; ok: boolean; detail: string }> {
  try {
    const { stdout, stderr } = await exec(file, args, { timeout: 8_000, windowsHide: true });
    return { name, ok: true, detail: (stdout || stderr).trim().split(/\r?\n/)[0] ?? '' };
  } catch (error) {
    return { name, ok: false, detail: (error as Error).message.slice(0, 300) };
  }
}

export async function doctor(mode: VerificationMode = 'docker'): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }> {
  const agy = executable('agy'), codex = executable('codex');
  const checks = await Promise.all([
    Promise.resolve({ name: 'platform', ok: ['linux', 'win32', 'darwin'].includes(process.platform), detail: `${process.platform}; verification=${mode}` }),
    Promise.resolve({ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 24, detail: process.version }),
    probe('git', 'git', ['--version']),
    probe('agy', agy.file, [...agy.prefix, '--version']),
    probe('codex', codex.file, [...codex.prefix, '--version']),
  ]);
  if (mode === 'docker') checks.push(await probe('docker', 'docker', ['info', '--format', '{{.ServerVersion}}']));
  else {
    try { const npm = npmExecutable(); checks.push(await probe('npm', npm.file, [...npm.prefix, '--version'])); }
    catch (error) { checks.push({ name: 'npm', ok: false, detail: (error as Error).message }); }
  }
  return { ok: checks.every(check => check.ok), checks };
}

async function readRequest(path: string): Promise<string> {
  const raw = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
  try {
    const data = JSON.parse(raw) as { request?: unknown };
    if (typeof data.request === 'string') return data.request;
  } catch { /* Plain text request is accepted. */ }
  return raw;
}

export async function main(args: string[]): Promise<number> {
  try {
    const selected = languageArguments(args);
    return await withLocale(selected.locale, () => runMain(selected.args));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runMain(args: string[]): Promise<number> {
  try {
    const [command, id] = args;
    if (!command || ['help', '--help', '-h'].includes(command)) {
      process.stdout.write('SkillCrew 0.2\n  build --request-file PATH --out PATH [--verification local] [--max-repairs 0|1|2]\n  resume ID [--state-dir PATH]\n  route [--routing-file PATH] [--inventory-file PATH]\n  skills [--skills-file PATH]\n  locale [--lang auto|en|zh-CN]\n  doctor | init | plan | freeze | run | check | review-auto | status | report\n' +
        text('选项') + ': --lang auto|en|zh-CN --state-dir PATH --lead-mode auto|single|dual --primary-model PROVIDER/MODEL --co-lead-model PROVIDER/MODEL --ui-model PROVIDER/MODEL --logic-model PROVIDER/MODEL --skills-file PATH\n' +
        text('默认自动发现候选，优先安排两个不同主模型，并在调用前展示分工。') + '\n' +
        text('默认跟随系统语言；可用 --lang 或 SKILLCREW_LANG 覆盖。内置简体中文和英文，其他语言回退英文。') + '\n');
      return 0;
    }
    if (command === 'locale') { print(localePresentation()); return 0; }
    const stateRoot = resolve(option(args, '--state-dir') ?? join(process.cwd(), '.skillcrew'));
    const overrides: RouteOverrides = {
      primary: option(args, '--primary-model'), coLead: option(args, '--co-lead-model'),
      ui: option(args, '--ui-model'), logic: option(args, '--logic-model'),
    };
    const selectedRouting = async () => {
      const inventoryFile = option(args, '--inventory-file');
      const inventory: ModelInventory = inventoryFile
        ? JSON.parse((await readFile(inventoryFile, 'utf8')).replace(/^\uFEFF/, '')) : await discoverModels();
      const catalog = await withLocalReliability(await readCatalog(option(args, '--routing-file')), stateRoot);
      return selectRouting(catalog, inventory, (option(args, '--lead-mode') ?? 'auto') as LeadPreference, overrides);
    };
    if (command === 'skills') { print(await loadSkills(option(args, '--skills-file'))); return 0; }
    if (command === 'doctor') {
      const result = await doctor(verificationMode(option(args, '--verification')));
      print(result);
      return result.ok ? 0 : 2;
    }
    if (command === 'route') {
      const routing = await selectedRouting();
      process.stderr.write(routingSummary(routing));
      print(routing);
      return 0;
    }
    if (command === 'build') {
      const request = await readRequest(required(option(args, '--request-file'), '--request-file ' + text('路径')));
      const output = required(option(args, '--out'), '--out ' + text('路径'));
      const mode = verificationMode(option(args, '--verification'));
      const maxRepairRounds = Number(option(args, '--max-repairs') ?? 2);
      if (![0, 1, 2].includes(maxRepairRounds)) throw new Error('--max-repairs 只支持 0、1 或 2。');
      const routing = await selectedRouting();
      const state = await createRun(stateRoot, request, output, routing.mode, {}, { routing, skills: await loadSkills(option(args, '--skills-file')) });
      process.stderr.write(`${text('运行 ID')}: ${state.id}\n`);
      return await withRunLock(stateRoot, state.id, () => workflowCommand(stateRoot, state.id, mode, maxRepairRounds));
    }
    if (command === 'init') {
      const request = await readRequest(required(option(args, '--request-file'), '--request-file ' + text('路径')));
      const output = required(option(args, '--out'), '--out ' + text('路径'));
      const routing = await selectedRouting();
      const state = await createRun(stateRoot, request, output, routing.mode, {}, { routing, skills: await loadSkills(option(args, '--skills-file')) });
      process.stderr.write(routingSummary(routing));
      print(state);
      return 0;
    }
    const runId = required(id, text('运行 ID'));
    if (command === 'check') {
      const mode = verificationMode(option(args, '--verification'));
      return await withRunLock(stateRoot, runId, async () => {
        const state = await recheckRun(stateRoot, runId, dir => verifyProject(dir, mode));
        print({ id: state.id, status: state.status, verificationPassed: state.verificationPassed, report: await saveReport(stateRoot, state) });
        return state.verificationPassed ? 0 : 2;
      });
    }
    if (command === 'review-auto') {
      return await withRunLock(stateRoot, runId, async () => {
        const reviewed = await autoReview(stateRoot, runId);
        print({ state: reviewed, report: await saveReport(stateRoot, reviewed) });
        return reviewed.status === 'ready' ? 0 : 2;
      });
    }
    if (command === 'plan') {
      print(await withRunLock(stateRoot, runId, async () => {
        process.stderr.write(routingSummary((await loadRun(stateRoot, runId)).plan.routing!));
        return runPlanning(stateRoot, runId);
      }));
      return 0;
    }
    if (command === 'set-plan') {
      const file = required(option(args, '--file'), '--file ' + text('计划 JSON 路径'));
      const proposal = JSON.parse(await readFile(file, 'utf8'));
      print(await withRunLock(stateRoot, runId, () => setRunPlan(stateRoot, runId, proposal)));
      return 0;
    }
    if (command === 'freeze') {
      print(await withRunLock(stateRoot, runId, () => freezeRun(stateRoot, runId, join(packageRoot, 'templates', 'react-todo'))));
      return 0;
    }
    if (command === 'status') {
      print(await loadRun(stateRoot, runId));
      return 0;
    }
    if (command === 'resume') {
      return await withRunLock(stateRoot, runId, async () => {
        const state = await loadRun(stateRoot, runId);
        const mode = verificationMode(option(args, '--verification') ?? state.workflow?.verification);
        const limit = option(args, '--max-repairs');
        return workflowCommand(stateRoot, runId, mode, limit === undefined ? undefined : Number(limit));
      });
    }
    if (command === 'run') {
      return await withRunLock(stateRoot, runId, async () => {
        const current = await loadRun(stateRoot, runId);
        const mode = verificationMode(option(args, '--verification'));
        const routing = current.plan.routing!;
        const state = await executeRun(stateRoot, runId, { preflight: () => defaultPreflight(mode, [routing.primary, routing.ui, routing.logic]), verifier: dir => verifyProject(dir, mode) });
        const report = await saveReport(stateRoot, state);
        print({ id: state.id, status: state.status, report, error: state.error });
        return state.status === 'needs_review' ? 0 : 1;
      });
    }
    if (command === 'review') {
      const file = required(option(args, '--file'), '--file ' + text('审查 JSON 路径'));
      const review = JSON.parse(await readFile(file, 'utf8'));
      return await withRunLock(stateRoot, runId, async () => {
        const state = await submitReview(stateRoot, runId, review);
        const report = await saveReport(stateRoot, state);
        print({ id: state.id, status: state.status, report, issues: (state.review as { issues: unknown[] }).issues.length });
        return state.status === 'ready' ? 0 : 1;
      });
    }
    if (command === 'report') {
      const state = await loadRun(stateRoot, runId);
      print({ report: await saveReport(stateRoot, state), status: state.status });
      return 0;
    }
    process.stderr.write(text('用法') + ': skillcrew [--lang auto|en|zh-CN] doctor | locale | route | init --request-file PATH --out PATH | build --request-file PATH --out PATH | plan ID | set-plan ID --file PATH | freeze ID | run ID | check ID | status ID | resume ID | review-auto ID | review ID --file PATH | report ID\n');
    return 1;
  } catch (error) {
    process.stderr.write(diagnostic(error instanceof Error ? error.message : String(error)) + '\n');
    return 1;
  }
}

async function workflowCommand(root: string, id: string, mode: VerificationMode, maxRepairRounds?: number): Promise<number> {
  let stage = 'starting', last = Date.now();
  const timer = setInterval(() => process.stderr.write(text('[{stage}] 仍在执行，距最近进度 {seconds} 秒。', { stage, seconds: Math.round((Date.now() - last) / 1000) }) + '\n'), 20_000);
  try {
    const routing = (await loadRun(root, id)).plan.routing!;
    process.stderr.write(routingSummary(routing));
    const routes = [routing.primary, routing.ui, routing.logic, routing.reviewer, ...(routing.coLead ? [routing.coLead] : [])];
    const state = await continueWorkflow(root, id, { verification: mode, maxRepairRounds }, {
      preflight: () => defaultPreflight(mode, routes), verifier: dir => verifyProject(dir, mode),
      onProgress: (next, message) => { stage = next; last = Date.now(); process.stderr.write(`[${next}] ${diagnostic(message)}\n`); },
    });
    print({ id: state.id, status: state.status, output: state.outputDir, report: await saveReport(root, state),
      repairRounds: state.execution?.cycle.round ?? 0, reusedWorkers: state.execution?.reusedWorkers ?? 0,
      checks: state.checks.map(({ id, passed, count }) => ({ id, passed, count })), error: state.error });
    return state.status === 'ready' ? 0 : 2;
  } finally { clearInterval(timer); }
}
