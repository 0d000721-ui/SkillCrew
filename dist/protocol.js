import { createHash } from 'node:crypto';
const ACCEPTANCE = ['AC-CRUD', 'AC-CATEGORY', 'AC-DRAG', 'AC-PERSIST', 'AC-RECOVER'];
const UNSUPPORTED = ['账号登录', '账号', '登录', '注册', '支付', '后端', '服务器', '数据库', '云同步', '多人协作', '电商'];
export function parseRequest(request) {
    const text = String(request ?? '').trim();
    if (!text || text.length > 500)
        throw new Error('需求长度须在 1 到 500 字符之间。');
    if (!/(待办|任务清单|to-?do)/i.test(text)) {
        throw new Error('v0.1 只支持新建本地 React 待办应用。');
    }
    const outside = UNSUPPORTED.find(word => text.includes(word));
    if (outside)
        throw new Error(`需求包含未支持的“${outside}”；v0.1 仅支持本地待办应用。`);
    return {
        schemaVersion: 1,
        projectType: 'react-todo',
        request: text,
        assumptions: ['新建项目', '数据仅保存在当前浏览器', '单用户使用', 'React + TypeScript + Vite 固定技术栈'],
        features: ['添加、编辑、删除和完成待办', '创建和管理分类', '分类内及跨分类拖拽排序', '刷新后保留数据', '异常存储恢复'],
        acceptanceIds: [...ACCEPTANCE],
    };
}
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
export function freezePlan(plan, contract, templateHash) {
    if (!plan.summary || !plan.acceptanceMapping ||
        plan.acceptanceIds.some(id => !plan.acceptanceMapping?.[id]?.trim())) {
        throw new Error('计划缺少完整的验收映射，不能冻结接口。');
    }
    return createHash('sha256').update(canonical({ plan, contract, templateHash })).digest('hex');
}
export function assertContractHash(digest, plan, contract, templateHash) {
    if (freezePlan(plan, contract, templateHash) !== digest)
        throw new Error('接口哈希不匹配；旧产物不能继续集成。');
}
const DEPENDENCIES = {
    plan: [], freeze: ['plan'], ui: ['freeze'], logic: ['freeze'], integrate: ['ui', 'logic'],
    check: ['integrate'], review: ['check'], ready: ['review'],
};
export function readyStages(completed) {
    const done = new Set(completed);
    return Object.entries(DEPENDENCIES)
        .filter(([stage, needs]) => !done.has(stage) && needs.every(need => done.has(need)))
        .map(([stage]) => stage);
}
