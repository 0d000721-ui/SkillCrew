import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { executable } from './process.js';
import { RANKING_SNAPSHOT } from './routing.js';
// Relative product preferences, not benchmark scores. Fresh user-supplied evaluation
// evidence can change ordering; unavailable entries never enter the candidate set.
export const DEFAULT_CATALOG = { schemaVersion: 1, models: [
        { provider: 'agy', model: 'claude-opus-4-6-thinking', roles: { primary: 95, co_lead: 100, ui: 65, logic: 85, review: 100 } },
        { provider: 'agy', model: 'gemini-3.8-flash-high', roles: { ui: 100, logic: 55 } },
        { provider: 'codex', model: 'gpt-6-astra', roles: { primary: 100, co_lead: 100, ui: 85, logic: 95, review: 95 } },
        { provider: 'codex', model: 'gpt-6-sol', roles: { primary: 80, co_lead: 80, ui: 80, logic: 100, review: 80 } },
    ] };
const roles = ['primary', 'co_lead', 'ui', 'logic', 'review'];
const identity = (model) => `${model.provider}/${model.model}`;
function validScores(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).length > 0 &&
        Object.entries(value).every(([role, score]) => roles.includes(role) && typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100);
}
export function validateCatalog(value) {
    const catalog = value;
    if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.models) || !catalog.models.length || catalog.models.length > 100)
        throw new Error('模型目录格式无效。');
    const ids = new Set();
    for (const model of catalog.models) {
        if (!model || !['agy', 'codex'].includes(model.provider) || !/^[a-zA-Z0-9_.:-]{2,80}$/.test(model.model) || !validScores(model.roles) || ids.has(identity(model)))
            throw new Error('模型目录包含无效或重复条目。');
        ids.add(identity(model));
        const evidence = model.benchmark;
        if (evidence && (!/^https:\/\//.test(evidence.source) || !Number.isFinite(Date.parse(evidence.checkedAt)) ||
            Date.parse(evidence.checkedAt) > Date.now() + 86_400_000 || !validScores(evidence.scores)))
            throw new Error('榜单证据必须包含 HTTPS 来源、有效日期和角色评分。');
        if (model.reliability && (!Number.isInteger(model.reliability.attempts) || !Number.isInteger(model.reliability.accepted) || model.reliability.attempts < 0 || model.reliability.accepted < 0 || model.reliability.accepted > model.reliability.attempts))
            throw new Error('本地交付统计无效。');
    }
    return structuredClone(catalog);
}
export async function readCatalog(file) {
    return validateCatalog(file ? JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) : DEFAULT_CATALOG);
}
export async function discoverModels() {
    const inventory = { agy: [], codex: [], notes: [] };
    await Promise.all([
        (async () => {
            try {
                const command = executable('agy');
                const { stdout } = await promisify(execFile)(command.file, [...command.prefix, 'models'], { timeout: 30_000, windowsHide: true });
                inventory.agy = stdout.split(/\r?\n/).map(line => line.match(/^([a-z0-9][a-z0-9_.:-]+)\s+/)?.[1]).filter((id) => !!id);
                inventory.notes.push('agy: live model listing');
            }
            catch (error) {
                inventory.notes.push(`agy discovery unavailable: ${error.message.slice(0, 200)}`);
            }
        })(),
        (async () => {
            try {
                const command = executable('codex');
                await promisify(execFile)(command.file, [...command.prefix, '--version'], { timeout: 8000, windowsHide: true });
                const cache = JSON.parse(await readFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
                inventory.codex = (cache.models ?? []).filter((model) => typeof model.slug === 'string' && model.visibility !== 'hide').map((model) => model.slug);
                inventory.notes.push('codex: installed CLI model cache; may be stale; served model remains unknown in JSONL');
            }
            catch {
                inventory.notes.push('codex: model cache unavailable; refresh Codex or supply an explicit --inventory-file');
            }
        })(),
    ]);
    return inventory;
}
export async function withLocalReliability(catalog, root) {
    const result = structuredClone(catalog);
    for (const model of result.models)
        delete model.reliability;
    let entries;
    try {
        entries = await readdir(join(root, 'runs'), { withFileTypes: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return result;
        throw error;
    }
    for (const entry of entries.filter(item => item.isDirectory() && /^[a-f0-9-]{36}$/.test(item.name))) {
        try {
            const state = JSON.parse(await readFile(join(root, 'runs', entry.name, 'state.json'), 'utf8'));
            for (const [owner, delivery] of Object.entries(state.workerResults ?? {})) {
                const route = owner === 'gemini' ? state.plan.routing?.ui : state.plan.routing?.logic;
                const profile = result.models.find(model => route && identity(model) === identity(route));
                if (!profile || !['accepted', 'checkpointed', 'failed'].includes(delivery.status))
                    continue;
                const stat = profile.reliability ??= { attempts: 0, accepted: 0 };
                stat.attempts++;
                if (delivery.status !== 'failed')
                    stat.accepted++;
            }
        }
        catch { /* Incomplete or older run records provide no reliable evidence. */ }
    }
    return result;
}
export function selectRouting(catalogValue, inventory, mode = 'auto', overrides = {}) {
    const catalog = validateCatalog(catalogValue);
    if (!['auto', 'single', 'dual'].includes(mode) || !inventory || !Array.isArray(inventory.agy) || !Array.isArray(inventory.codex) ||
        [...inventory.agy, ...inventory.codex].some(id => typeof id !== 'string'))
        throw new Error('模型清单或主模型模式无效。');
    if (mode === 'single' && overrides.coLead)
        throw new Error('--lead-mode single 不能同时指定 --co-lead-model。');
    const reasons = {};
    const notices = [];
    // The same model ID on another provider is still the same model for lead diversity.
    const available = (role, exclude) => catalog.models.filter(model => inventory[model.provider].includes(model.model) && model.roles[role] !== undefined && (!exclude || model.model !== exclude.model));
    const select = (role, override, exclude, requirePartner = false) => {
        let candidates = available(role, exclude).filter(model => !requirePartner || available('co_lead', model).length > 0);
        if (override) {
            candidates = candidates.filter(model => identity(model) === override || model.model === override);
            if (candidates.length !== 1)
                throw new Error(`${role} 指定模型不可用、不支持该角色或名称不唯一：${override}`);
        }
        const score = (model) => {
            const preference = model.roles[role];
            const evidence = model.benchmark;
            const fresh = evidence && Date.now() - Date.parse(evidence.checkedAt) <= 60 * 86_400_000;
            const benchmark = fresh ? evidence.scores[role] : undefined;
            const base = benchmark === undefined ? preference : 0.3 * preference + 0.7 * benchmark;
            const local = model.reliability;
            const penalty = ['ui', 'logic'].includes(role) && local && local.attempts >= 5 ? (1 - local.accepted / local.attempts) * 20 : 0;
            return base - penalty;
        };
        candidates.sort((a, b) => score(b) - score(a) || identity(a).localeCompare(identity(b)));
        const chosen = candidates[0];
        if (!chosen)
            throw new Error(`${role} 没有可用候选模型。请查看 route --discover 或提供 inventory 文件。`);
        reasons[role] = `${override ? 'explicit override; ' : ''}role preference=${chosen.roles[role]}; selection score=${score(chosen).toFixed(2)}; ${chosen.benchmark ? `evaluation ${chosen.benchmark.source} (${chosen.benchmark.checkedAt}; older than 60 days is ignored)` : 'no benchmark score supplied; preference is not a leaderboard claim'}; delivery reliability=${chosen.reliability ? `${chosen.reliability.accepted}/${chosen.reliability.attempts}` : 'no observations'}`;
        return { provider: chosen.provider, model: chosen.model, role, ...(chosen.provider === 'codex' && ['primary', 'co_lead'].includes(role) ? { effort: 'max' } : {}) };
    };
    // Reserve a manually chosen co-lead before automatically choosing the primary.
    // Explicit choices must never be silently dropped or assigned twice as leaders.
    const reservedCoLead = overrides.coLead ? select('co_lead', overrides.coLead) : null;
    let primary = select('primary', overrides.primary, reservedCoLead ?? undefined);
    if (mode !== 'single' && !overrides.primary && !reservedCoLead && !available('co_lead', primary).length &&
        available('primary').some(model => available('co_lead', model).length > 0)) {
        primary = select('primary', undefined, undefined, true);
        notices.push('已从能够组成两个不同主模型的候选组合中选择主模型；角色支持范围影响最终分配。');
    }
    const coLead = mode === 'single' ? null : reservedCoLead ??
        (mode === 'dual' || available('co_lead', primary).length ? select('co_lead', undefined, primary) : null);
    if (mode === 'auto' && !coLead)
        notices.push(`${overrides.primary ? '保留指定主模型后，' : ''}当前候选池没有可配对的不同第二主模型，已自动使用单主模型。`);
    const ui = select('ui', overrides.ui), logic = select('logic', overrides.logic);
    for (const route of [ui, logic]) {
        if ([primary, coLead].some(lead => lead && lead.model === route.model)) {
            notices.push(`${route.role === 'ui' ? 'UI' : '逻辑'}任务按角色评分或手动指定使用 ${identity(route)}，与主模型共用型号，使用独立调用。`);
        }
    }
    return { mode: coLead ? 'dual' : 'single', requestedMode: mode, notices,
        selection: Object.values(overrides).some(Boolean) ? 'user_override' : 'capability_catalog',
        snapshot: { ...RANKING_SNAPSHOT, checkedAt: new Date().toISOString(), primaryBasis: 'available candidates + configured role preferences + dated evaluation evidence', rationale: 'Preferences are explicit configuration, not independently measured global rankings.' },
        primary, coLead, ui, logic, reviewer: select('review'), decisions: reasons, inventory };
}
