import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunState } from './run-store.js';
import { routingAssignments } from './routing.js';

const safe = (value: unknown) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderReport(state: RunState): string {
  const lines = [
    `# SkillCrew 运行报告 ${state.id}`,
    '',
    `- 状态：**${state.status}**`,
    `- 需求：${safe(state.request)}`,
    `- 项目：${safe(state.outputDir)}`,
    `- 冻结接口：${state.contractHash ?? '未冻结'}`,
    `- 交付源码：${state.sourceHash ?? '未集成'}`,
    `- 主模型模式：${state.plan.routing?.mode ?? '未记录'}`,
    `- 路由依据：${safe(state.plan.routing?.selection ?? '未记录')}（${state.plan.routing?.snapshot.checkedAt ?? '未记录'}）`,
    `- 规划模型（请求 / 实际）：${safe(state.plan.planner?.requestedModel ?? '未调用')} / ${safe(state.plan.planner?.observedModel ?? '未知')}`,
    '',
    '## 规划交流',
    '',
  ];
  const collaboration = state.plan.collaboration;
  if (!collaboration) lines.push('未执行结构化副模型咨询。');
  else {
    lines.push(`副模型建议 ${collaboration.notes.length} 条，主模型回复 ${collaboration.decisions.length} 条。`);
    for (const note of collaboration.notes) {
      const decision = collaboration.decisions.find(entry => entry.noteId === note.id);
      lines.push(`- ${safe(note.id)} ${safe(note.text)} → ${safe(decision?.disposition ?? '未回复')}：${safe(decision?.reason ?? '')}`);
    }
    if (collaboration.coLeadOpinion) lines.push(`- 第二主模型意见：${safe(collaboration.coLeadOpinion)}`);
  }
  lines.push('', '## 模型与 Skill 分工', '');
  if (state.plan.routing) {
    lines.push('| 角色 | 模型 | 工作 |', '| --- | --- | --- |');
    for (const { label, route, work } of routingAssignments(state.plan.routing)) {
      lines.push(`| ${label} | ${route ? safe(`${route.provider}/${route.model}`) : '未启用'} | ${route ? work : '—'} |`);
    }
    lines.push('');
    for (const notice of state.plan.routing.notices ?? []) lines.push(`- ${safe(notice)}`);
  }
  for (const [role, reason] of Object.entries(state.plan.routing?.decisions ?? {})) lines.push(`- ${role}: ${safe(reason)}`);
  for (const skill of state.plan.skills ?? []) lines.push(`- Skill ${skill.id}：${skill.roles.join('/')} · ${skill.phases.join('/')} · ${skill.sha256.slice(0, 12)}`);
  if (state.execution) {
    lines.push('', '## 恢复与修复', '', `- 自动修复：${state.execution.cycle.round} / ${state.workflow?.maxRepairRounds ?? state.execution.maxRepairRounds} 轮`, `- 复用 worker 检查点：${state.execution.reusedWorkers} 次`);
    for (const round of state.execution.history) {
      lines.push(`- 第 ${round.round} 轮交付 ${round.sourceHash}：${safe(round.decision.reason)}`);
      for (const check of round.checks.filter(check => check.passed !== true)) lines.push(`  - 失败检查 ${safe(check.id)}，退出码 ${safe(check.exitCode)}`);
      for (const task of round.decision.tasks) lines.push(`  - ${task.owner}：${safe(task.instructions)}`);
    }
  }
  lines.push('', '## 实施澄清', '');
  if (!state.dialogue?.length) lines.push('无实施阶段澄清。');
  else for (const item of state.dialogue) lines.push(`- ${safe(item.provider)}：${safe(item.question)} → ${safe(item.answer)}（主模型 ${safe(item.observedModel ?? '未知')}）`);
  lines.push('',
    '## Worker 交付',
    '',
    '| Worker | 状态 | 请求 / 实际模型 | 实际改动 |',
    '| --- | --- | --- | --- |',
  );
  for (const provider of ['gemini', 'codex']) {
    const result = state.workerResults[provider] as Record<string, unknown> | undefined;
    const changes = Array.isArray(result?.changes) ? result.changes.map((change: { path: string }) => change.path).join(', ') : '无';
    lines.push(`| ${provider === 'gemini' ? 'UI' : '逻辑'} | ${safe(result?.status ?? '未调用')} | ${safe(result?.requestedModel ?? '未知')} / ${safe(result?.model ?? '未知')} | ${safe(changes)} |`);
  }
  lines.push('', '## 机器验收', '', '| 检查 | 退出码 | 执行数量 | 通过 |', '| --- | ---: | ---: | --- |');
  for (const check of state.checks) {
    lines.push(`| ${safe(check.id)} | ${safe(check.exitCode)} | ${safe(check.count)} | ${check.passed === true ? '是' : '否'} |`);
  }
  if (!state.checks.length) lines.push('未执行机器验收。');
  lines.push('', '## 独立审查', '');
  const review = state.review as { issues?: Record<string, unknown>[] } | null;
  if (!review) lines.push('未提交独立审查；不能标记 ready。');
  else if (!review.issues?.length) lines.push('审查报告未列出问题。');
  else for (const issue of review.issues) lines.push(`- ${safe(issue.severity)} · ${safe(issue.file)} · ${safe(issue.observed)} · 复现：${safe(issue.repro)}（${safe(issue.reproductionStatus)}）`);
  if (state.error) lines.push('', '## 阻塞原因', '', state.error);
  lines.push('', '## 事件', '');
  for (const entry of state.events) lines.push(`- ${entry.time} ${entry.stage}: ${entry.message}`);
  lines.push('', `验收环境：${safe(state.checks[0]?.mode ?? '未记录')}。local 在临时副本内执行固定命令，属于普通本机进程；docker 在容器内执行。文件归属门禁控制进入结果的补丁，CLI sandbox 的隔离能力取决于各 CLI 实现。`, '');
  return lines.join('\n');
}

export async function saveReport(root: string, state: RunState): Promise<string> {
  const path = join(root, 'runs', state.id, 'report.md');
  await mkdir(join(root, 'runs', state.id), { recursive: true });
  await writeFile(path, renderReport(state));
  return path;
}
