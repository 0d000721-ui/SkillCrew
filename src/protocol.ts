import { createHash } from 'node:crypto';
import type { RoutingPolicy } from './routing.js';
import type { SkillSnapshot } from './skills.js';
import type { DisplayLanguage } from './i18n.js';

export interface AdvisorNote {
  id: string;
  provider: 'gemini' | 'codex';
  kind: 'question' | 'risk' | 'suggestion';
  text: string;
  acceptanceId: string | null;
}
export interface LeadDecision {
  noteId: string;
  disposition: 'adopt' | 'decline';
  reason: string;
}
export interface CollaborationRecord {
  notes: AdvisorNote[];
  decisions: LeadDecision[];
  coLeadOpinion: string | null;
  calls: { role: string; provider: string; requestedModel: string; observedModel: string | null }[];
}

export interface Plan {
  schemaVersion: 1;
  projectType: 'react-todo';
  request: string;
  responseLanguage?: DisplayLanguage;
  assumptions: string[];
  features: string[];
  acceptanceIds: string[];
  summary?: string;
  acceptanceMapping?: Record<string, string>;
  planner?: { provider: 'agy' | 'codex'; requestedModel: string; observedModel: string | null; effort: 'max' | null; basis: string };
  routing?: RoutingPolicy;
  skills?: SkillSnapshot[];
  collaboration?: CollaborationRecord;
}

const ACCEPTANCE = ['AC-CRUD', 'AC-CATEGORY', 'AC-DRAG', 'AC-PERSIST', 'AC-RECOVER'];
const UNSUPPORTED = ['账号登录', '账号', '登录', '注册', '支付', '后端', '服务器', '数据库', '云同步', '多人协作', '电商'];

export function parseRequest(request: string): Plan {
  const text = String(request ?? '').trim();
  if (!text || text.length > 500) throw new Error('需求长度须在 1 到 500 字符之间。');
  if (!/(待办|任务清单|to-?do)/i.test(text)) {
    throw new Error('v0.1 只支持新建本地 React 待办应用。');
  }
  const outside = UNSUPPORTED.find(word => text.includes(word));
  if (outside) throw new Error(`需求包含未支持的“${outside}”；v0.1 仅支持本地待办应用。`);
  return {
    schemaVersion: 1,
    projectType: 'react-todo',
    request: text,
    assumptions: ['新建项目', '数据仅保存在当前浏览器', '单用户使用', 'React + TypeScript + Vite 固定技术栈'],
    features: ['添加、编辑、删除和完成待办', '创建和管理分类', '分类内及跨分类拖拽排序', '刷新后保留数据', '异常存储恢复'],
    acceptanceIds: [...ACCEPTANCE],
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function freezePlan(plan: Plan, contract: unknown, templateHash: string): string {
  if (!plan.summary || !plan.acceptanceMapping ||
      plan.acceptanceIds.some(id => !plan.acceptanceMapping?.[id]?.trim())) {
    throw new Error('计划缺少完整的验收映射，不能冻结接口。');
  }
  return createHash('sha256').update(canonical({ plan, contract, templateHash })).digest('hex');
}

export function assertContractHash(digest: string, plan: Plan, contract: unknown, templateHash: string): void {
  if (freezePlan(plan, contract, templateHash) !== digest) throw new Error('接口哈希不匹配；旧产物不能继续集成。');
}

const DEPENDENCIES: Record<string, string[]> = {
  plan: [], freeze: ['plan'], ui: ['freeze'], logic: ['freeze'], integrate: ['ui', 'logic'],
  check: ['integrate'], review: ['check'], ready: ['review'],
};

export function readyStages(completed: string[]): string[] {
  const done = new Set(completed);
  return Object.entries(DEPENDENCIES)
    .filter(([stage, needs]) => !done.has(stage) && needs.every(need => done.has(need)))
    .map(([stage]) => stage);
}
