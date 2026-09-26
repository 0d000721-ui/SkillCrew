import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunState } from './run-store.js';
import { routingAssignments } from './routing.js';
import { diagnostic, text } from './i18n.js';

const safe = (value: unknown) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderReport(state: RunState): string {
  const lines = [
    `# ${text('SkillCrew 运行报告 {id}', { id: state.id })}`,
    '',
    `- ${text('状态')}: **${state.status}**`,
    `- ${text('需求')}: ${safe(state.request)}`,
    `- ${text('项目')}: ${safe(state.outputDir)}`,
    `- ${text('冻结接口')}: ${state.contractHash ?? text('未冻结')}`,
    `- ${text('交付源码')}: ${state.sourceHash ?? text('未集成')}`,
    `- ${text('主模型模式')}: ${state.plan.routing?.mode ?? text('未记录')}`,
    `- ${text('路由依据')}: ${safe(state.plan.routing?.selection ?? text('未记录'))} (${state.plan.routing?.snapshot.checkedAt ?? text('未记录')})`,
    `- ${text('规划模型（请求 / 实际）')}: ${safe(state.plan.planner?.requestedModel ?? text('未调用'))} / ${safe(state.plan.planner?.observedModel ?? text('未知'))}`,
    '',
    '## ' + text('规划交流'),
    '',
  ];
  const collaboration = state.plan.collaboration;
  if (!collaboration) lines.push(text('未执行结构化副模型咨询。'));
  else {
    lines.push(text('副模型建议 {notes} 条，主模型回复 {decisions} 条。', { notes: collaboration.notes.length, decisions: collaboration.decisions.length }));
    for (const note of collaboration.notes) {
      const decision = collaboration.decisions.find(entry => entry.noteId === note.id);
      lines.push(`- ${safe(note.id)} ${safe(note.text)} → ${safe(decision?.disposition ?? text('未回复'))}: ${safe(decision?.reason ?? '')}`);
    }
    if (collaboration.coLeadOpinion) lines.push(`- ${text('第二主模型意见')}: ${safe(collaboration.coLeadOpinion)}`);
  }
  lines.push('', '## ' + text('模型与 Skill 分工'), '');
  if (state.plan.routing) {
    lines.push(`| ${text('角色')} | ${text('模型')} | ${text('工作')} |`, '| --- | --- | --- |');
    for (const { label, route, work } of routingAssignments(state.plan.routing)) {
      lines.push(`| ${label} | ${route ? safe(`${route.provider}/${route.model}`) : text('未启用')} | ${route ? work : '—'} |`);
    }
    lines.push('');
    for (const notice of state.plan.routing.notices ?? []) lines.push(`- ${safe(diagnostic(notice))}`);
  }
  for (const [role, reason] of Object.entries(state.plan.routing?.decisions ?? {})) lines.push(`- ${role}: ${safe(reason)}`);
  for (const skill of state.plan.skills ?? []) lines.push(`- Skill ${skill.id}：${skill.roles.join('/')} · ${skill.phases.join('/')} · ${skill.sha256.slice(0, 12)}`);
  if (state.execution) {
    lines.push('', '## ' + text('恢复与修复'), '', `- ${text('自动修复')}: ${state.execution.cycle.round} / ${state.workflow?.maxRepairRounds ?? state.execution.maxRepairRounds}`, `- ${text('复用 worker 检查点')}: ${state.execution.reusedWorkers}`);
    for (const round of state.execution.history) {
      lines.push('- ' + text('第 {round} 轮交付 {hash}：{reason}', { round: round.round, hash: round.sourceHash, reason: safe(round.decision.reason) }));
      for (const check of round.checks.filter(check => check.passed !== true)) lines.push('  - ' + text('失败检查 {id}，退出码 {code}', { id: safe(check.id), code: safe(check.exitCode) }));
      for (const task of round.decision.tasks) lines.push(`  - ${task.owner}：${safe(task.instructions)}`);
    }
  }
  lines.push('', '## ' + text('实施澄清'), '');
  if (!state.dialogue?.length) lines.push(text('无实施阶段澄清。'));
  else for (const item of state.dialogue) lines.push(`- ${safe(item.provider)}: ${safe(item.question)} → ${safe(item.answer)} (${text('主模型')} ${safe(item.observedModel ?? text('未知'))})`);
  lines.push('',
    '## ' + text('Worker 交付'),
    '',
    `| Worker | ${text('状态')} | ${text('请求 / 实际模型')} | ${text('实际改动')} |`,
    '| --- | --- | --- | --- |',
  );
  for (const provider of ['gemini', 'codex']) {
    const result = state.workerResults[provider] as Record<string, unknown> | undefined;
    const changes = Array.isArray(result?.changes) ? result.changes.map((change: { path: string }) => change.path).join(', ') : text('无');
    lines.push(`| ${provider === 'gemini' ? 'UI' : text('逻辑')} | ${safe(result?.status ?? text('未调用'))} | ${safe(result?.requestedModel ?? text('未知'))} / ${safe(result?.model ?? text('未知'))} | ${safe(changes)} |`);
  }
  lines.push('', '## ' + text('机器验收'), '', `| ${text('检查')} | ${text('退出码')} | ${text('执行数量')} | ${text('通过')} |`, '| --- | ---: | ---: | --- |');
  for (const check of state.checks) {
    lines.push(`| ${safe(check.id)} | ${safe(check.exitCode)} | ${safe(check.count)} | ${text(check.passed === true ? '是' : '否')} |`);
  }
  if (!state.checks.length) lines.push(text('未执行机器验收。'));
  lines.push('', '## ' + text('独立审查'), '');
  const review = state.review as { issues?: Record<string, unknown>[] } | null;
  if (!review) lines.push(text('未提交独立审查；不能标记 ready。'));
  else if (!review.issues?.length) lines.push(text('审查报告未列出问题。'));
  else for (const issue of review.issues) lines.push(`- ${safe(issue.severity)} · ${safe(issue.file)} · ${safe(issue.observed)} · ${text('复现')}: ${safe(issue.repro)} (${safe(issue.reproductionStatus)})`);
  if (state.error) lines.push('', '## ' + text('阻塞原因'), '', diagnostic(state.error));
  lines.push('', '## ' + text('事件'), '');
  for (const entry of state.events) lines.push(`- ${entry.time} ${entry.stage}: ${diagnostic(entry.message)}`);
  lines.push('', text('验收环境：{mode}。local 在临时副本内执行固定命令，属于普通本机进程；docker 在容器内执行。文件归属门禁控制进入结果的补丁，CLI sandbox 的隔离能力取决于各 CLI 实现。', { mode: safe(state.checks[0]?.mode ?? text('未记录')) }), '');
  return lines.join('\n');
}

export async function saveReport(root: string, state: RunState): Promise<string> {
  const path = join(root, 'runs', state.id, 'report.md');
  await mkdir(join(root, 'runs', state.id), { recursive: true });
  await writeFile(path, renderReport(state));
  return path;
}
