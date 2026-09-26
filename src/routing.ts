export type LeadMode = 'single' | 'dual';
export type LeadPreference = 'auto' | LeadMode;

// Availability takes precedence over a leaderboard: these IDs were listed by agy models.
export const RANKING_SNAPSHOT = {
  checkedAt: '2026-09-26',
  primaryBasis: 'agy models (1.2.11); user-selected available model pool',
  webDevBasis: 'https://arena.ai/leaderboard/code/webdev',
  rationale: 'Use available Opus 4.6 for planning and critical decisions, Flash 3.8 for UI; rankings are references, not availability guarantees.',
} as const;

export interface Route {
  provider: 'agy' | 'codex';
  model: string;
  effort?: 'max';
  role: 'primary' | 'co_lead' | 'ui' | 'logic' | 'review';
}

export interface RoutingPolicy {
  mode: LeadMode;
  requestedMode?: LeadPreference;
  notices?: string[];
  selection: 'available_models' | 'user_override' | 'capability_catalog';
  snapshot: { checkedAt: string; primaryBasis: string; webDevBasis: string; rationale: string };
  decisions?: Record<string, string>;
  inventory?: { agy: string[]; codex: string[]; notes?: string[] };
  primary: Route;
  coLead: Route | null;
  ui: Route;
  logic: Route;
  reviewer: Route;
}

export interface RouteOverrides { primary?: string; coLead?: string; ui?: string; logic?: string }

export function routingAssignments(routing: RoutingPolicy): { label: string; route: Route | null; work: string }[] {
  return [
    { label: '主模型', route: routing.primary, work: '规划、关键澄清与最终裁决' },
    { label: '第二主模型', route: routing.coLead, work: '独立检查架构与验收遗漏，向主模型提出意见' },
    { label: 'UI 副模型', route: routing.ui, work: '页面、样式与交互' },
    { label: '逻辑副模型', route: routing.logic, work: '状态、存储与业务逻辑' },
    { label: '独立审查', route: routing.reviewer, work: '新会话检查交付与验收证据' },
  ];
}

export function routingSummary(routing: RoutingPolicy): string {
  const method = routing.selection === 'user_override' ? '手动指定角色，其余自动分配' : routing.requestedMode === 'auto' ? '默认自动分配' : '已保存的模型分工';
  const lines = [`[模型分工] ${method} · ${routing.mode === 'dual' ? '双主模型' : '单主模型'}`];
  for (const { label, route, work } of routingAssignments(routing)) {
    lines.push(`  ${label}：${route ? `${route.provider}/${route.model}${route.effort ? ` (${route.effort})` : ''}；${work}` : '未启用'}`);
  }
  if (routing.selection === 'capability_catalog' || routing.selection === 'user_override') {
    lines.push('  选择依据：可用候选、已配置的角色能力与有效评测；详细依据见运行报告。');
  }
  for (const notice of routing.notices ?? []) lines.push(`  说明：${notice}`);
  return lines.join('\n') + '\n';
}

// Offline compatibility for older programmatic callers. User-facing CLI commands
// select from an inventory through selectRouting instead of using this legacy fallback.
export function defaultRouting(mode: LeadMode = 'single', overrides: RouteOverrides = {}): RoutingPolicy {
  if (mode !== 'single' && mode !== 'dual') throw new Error('主模型模式只支持 single 或 dual。');
  for (const model of Object.values(overrides)) {
    if (model !== undefined && !/^[a-zA-Z0-9_.:-]{2,80}$/.test(model)) throw new Error('模型 ID 格式无效。');
  }
  return {
    mode,
    selection: Object.values(overrides).some(Boolean) ? 'user_override' : 'available_models',
    snapshot: RANKING_SNAPSHOT,
    primary: { provider: 'agy', model: overrides.primary ?? 'claude-opus-4-6-thinking', role: 'primary' },
    coLead: mode === 'dual' ? { provider: 'codex', model: overrides.coLead ?? 'gpt-6-astra', effort: 'max', role: 'co_lead' } : null,
    ui: { provider: 'agy', model: overrides.ui ?? 'gemini-3.8-flash-high', role: 'ui' },
    logic: { provider: 'codex', model: overrides.logic ?? 'gpt-6-sol', role: 'logic' },
    reviewer: { provider: 'agy', model: overrides.primary ?? 'claude-opus-4-6-thinking', role: 'review' },
  };
}
