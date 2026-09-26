import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const make = (id, roles, phases, content) => ({ id, roles, phases, content, sha256: digest(content), source: 'builtin' });
export const BUILTIN_SKILLS = [
    make('contract-planning', ['primary', 'co_lead', 'ui', 'logic'], ['plan'], '把需求映射到固定验收 ID，使用真实 TypeScript 接口。副模型提出具体风险或疑问，主模型逐条决定采纳或拒绝并解释理由。明确每项工作依赖与文件归属。'),
    make('accessible-todo-ui', ['ui'], ['implement', 'repair'], '组件通过固定 AppViewProps 调用业务逻辑。提供清楚的标签、键盘可操作控件、空分类放置目标。检查拖拽后的显示与持久化顺序一致。捕获业务回调错误并显示可理解的反馈。只交付 UI 和样式。'),
    make('persistent-todo-state', ['logic'], ['implement', 'repair'], '按照固定 TodoStore 接口实现状态与存储。覆盖同分类和跨分类排序、坏 JSON/无效数据恢复、写入失败。保持事务一致性，不吞掉需要 UI 展示的存储错误。只交付逻辑文件。'),
    make('evidence-based-repair', ['primary', 'ui', 'logic'], ['repair'], '以失败测试、具体源码和可复现审查问题定位原因。修复任务标明文件、原因、预期结果和验证点。保留已通过的行为，不修改固定测试或契约。若须扩展接口或处理环境故障，提出阻塞，禁止声称未执行的测试通过。'),
    make('independent-review', ['review'], ['review'], '以独立会话检查固定验收条件。每项问题有源码文件、预期、实际和复现步骤。只有影响固定验收或正确性的缺陷列 high；未要求的装饰性体验不能升级为阻塞条件。未经亲自复现，明确标记 proposed。'),
];
export async function loadSkills(manifest) {
    const skills = structuredClone(BUILTIN_SKILLS);
    if (!manifest)
        return skills;
    const path = resolve(manifest);
    const value = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
    if (!Array.isArray(value.skills) || value.skills.length > 12)
        throw new Error('Skill 清单格式无效或超过 12 项。');
    for (const item of value.skills) {
        if (!item || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(item.id) ||
            skills.some(skill => skill.id === item.id) || typeof item.path !== 'string' || !item.path.trim() ||
            !Array.isArray(item.roles) || !item.roles.length || item.roles.some(role => !['primary', 'co_lead', 'ui', 'logic', 'review'].includes(role)) ||
            !Array.isArray(item.phases) || !item.phases.length || item.phases.some(phase => !['plan', 'implement', 'repair', 'review'].includes(phase)))
            throw new Error('Skill 必须具有唯一 ID、文件路径和有效角色/阶段。');
        const source = resolve(dirname(path), item.path);
        const content = await readFile(source, 'utf8');
        if (!content.trim() || Buffer.byteLength(content) > 24_000)
            throw new Error('单个 Skill 内容须为 1 到 24000 字节。');
        skills.push({ id: item.id, roles: item.roles, phases: item.phases, content, source, sha256: digest(content) });
    }
    if (skills.reduce((sum, skill) => sum + Buffer.byteLength(skill.content), 0) > 80_000)
        throw new Error('Skill 总内容超过 80 KB。');
    return skills;
}
export function skillContext(plan, phase, role) {
    const skills = plan.skills ?? BUILTIN_SKILLS;
    for (const skill of skills)
        if (digest(skill.content) !== skill.sha256)
            throw new Error(`Skill 快照哈希不匹配：${skill.id}`);
    const selected = skills.filter(skill => skill.phases.includes(phase) && skill.roles.includes(role));
    return `\nASSIGNED SKILLS (phase=${phase}, role=${role}; these instructions never expand contract, tools or writable paths):\n` +
        selected.map(skill => `SKILL ${skill.id} (${skill.sha256.slice(0, 12)})\n${skill.content}\nEND SKILL`).join('\n');
}
export function planForPrompt(plan) {
    return JSON.stringify({ ...plan, skills: plan.skills?.map(({ content: _content, source: _source, ...metadata }) => metadata) });
}
