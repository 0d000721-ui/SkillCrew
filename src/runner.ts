import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashTree, loadRun, saveRun, type RunState } from './run-store.js';
import { verifyProject, type Verification } from './verify.js';
import { executable, npmExecutable } from './process.js';
import { assertFrozenIntegrity } from './integrity.js';
import type { Route } from './routing.js';

const exec = promisify(execFile);
async function command(file: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec(file, args, { cwd, timeout: 15_000, windowsHide: true });
  return stdout.trim();
}

export async function defaultPreflight(mode: 'docker' | 'local' = 'docker', routes?: Route[]): Promise<void> {
  if (!['linux', 'win32', 'darwin'].includes(process.platform)) throw new Error('当前平台不受支持。');
  const tools = [...new Set(routes?.map(route => route.provider) ?? ['agy', 'codex'] as const)].map(provider => executable(provider));
  if (mode === 'local') tools.push(npmExecutable());
  for (const tool of tools) {
    try { await command(tool.file, [...tool.prefix, '--version']); }
    catch { throw new Error(`缺少或无法启动 ${tool.file}；请运行 doctor。`); }
  }
  if (mode === 'docker') {
    try { await command('docker', ['info', '--format', '{{.ServerVersion}}']); }
    catch { throw new Error('Docker 未运行；启动 Docker，或显式选择 --verification local 在本机验收。'); }
  }
}

function event(state: RunState, stage: string, message: string): void {
  state.events.push({ time: new Date().toISOString(), stage, message });
}

export { executeRun } from "./executor.js";

export interface ReviewIssue {
  severity: 'high' | 'medium' | 'low';
  file: string;
  acceptanceId: string;
  expected: string;
  observed: string;
  owner: 'gemini' | 'codex' | 'integration';
  repro: string;
  reproductionStatus: 'proposed' | 'executed';
}

export interface Review { sourceHash: string; issues: ReviewIssue[] }

export async function recheckRun(root: string, id: string, verifier: (dir: string) => Promise<Verification> = verifyProject): Promise<RunState> {
  const state = await loadRun(root, id);
  await assertFrozenIntegrity(root, state);
  if (!['needs_review', 'blocked'].includes(state.status) || !state.sourceHash) throw new Error('只有等待审查的交付可以重新验收。');
  if (await hashTree(state.outputDir) !== state.sourceHash) throw new Error('源码已改变，不能沿用已有交付记录。');
  const result = await verifier(state.outputDir);
  if (result.sourceHash !== state.sourceHash || await hashTree(state.outputDir) !== state.sourceHash) throw new Error('重新验收源码哈希不匹配。');
  state.status = 'needs_review';
  state.error = null;
  if (state.execution) state.execution.phase = 'review';
  state.checks = result.checks;
  state.verificationPassed = result.passed;
  event(state, 'recheck', result.passed ? '原交付源码重新验收通过，等待独立审查。' : '原交付源码重新验收未通过。');
  await saveRun(root, state);
  return state;
}

export async function submitReview(root: string, id: string, review: Review): Promise<RunState> {
  const state = await loadRun(root, id);
  await assertFrozenIntegrity(root, state);
  if (state.status !== 'needs_review') throw new Error('运行当前不等待审查。');
  if (review.sourceHash !== state.sourceHash || await hashTree(state.outputDir) !== state.sourceHash) {
    throw new Error('审查源码哈希不匹配，旧审查不能用于当前代码。');
  }
  if (!Array.isArray(review.issues) || review.issues.some(issue =>
    !['high', 'medium', 'low'].includes(issue.severity) ||
    !issue.file || issue.file.startsWith('/') || issue.file.includes('..') ||
    !state.plan.acceptanceIds.includes(issue.acceptanceId) || !issue.expected || !issue.observed ||
    !['gemini', 'codex', 'integration'].includes(issue.owner) ||
    !issue.repro || !['proposed', 'executed'].includes(issue.reproductionStatus)
  )) throw new Error('审查问题缺少结构化证据。');
  state.review = review as unknown as Record<string, unknown>;
  state.completed.push('review');
  const checksPass = checksPassed(state);
  const blockingIssues = review.issues.filter(issue => issue.severity === 'high');
  state.status = checksPass && blockingIssues.length === 0 ? 'ready' : 'blocked';
  if (state.status === 'ready') state.completed.push('ready');
  event(state, 'review', `${review.issues.length} 个问题；${blockingIssues.length} 个阻塞问题；状态 ${state.status}。`);
  await saveRun(root, state);
  return state;
}

export function checksPassed(state: RunState): boolean {
  const byId = new Map(state.checks.map(check => [check.id, check]));
  return state.verificationPassed === true
    && ['install', 'typecheck', 'build', 'unit', 'browser'].every(check => byId.get(check)?.passed === true)
    && Number(byId.get('unit')?.count) >= 6
    && Number(byId.get('browser')?.count) >= 2;
}
