import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const user = args.includes('--user'), project = option('--project'), host = option('--host') ?? 'agy';
const exists = async path => { try { await stat(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } };
if (user === Boolean(project) || !['agy', 'claude'].includes(host)) {
  process.stderr.write('用法：node scripts/install.mjs --project PATH | --user [--host agy|claude] [--dry-run]\n');
  process.exitCode = 1;
} else {
  const base = user ? homedir() : resolve(project);
  const customization = host === 'claude' ? join(base, '.claude') : user ? join(base, '.gemini', 'config') : join(base, '.agents');
  const skill = join(customization, 'skills', 'skillcrew');
  const agent = host === 'claude' ? join(customization, 'agents', 'skillcrew-reviewer.md') : null;
  const stagedSkill = skill + '.installing', stagedAgent = agent ? agent + '.installing' : null;
  const targets = [skill, agent, stagedSkill, stagedAgent].filter(Boolean);
  if ((await Promise.all(targets.map(exists))).some(Boolean)) {
    process.stderr.write('目标或暂存目录已存在：不会覆盖同名 Skill 或代理。\n');
    process.exitCode = 2;
  } else if (args.includes('--dry-run')) {
    process.stdout.write(JSON.stringify({ host, skill, agent }, null, 2) + '\n');
  } else {
    const created = [];
    try {
      await mkdir(dirname(stagedSkill), { recursive: true });
      await cp(join(packageRoot, 'skills', 'skillcrew'), stagedSkill, { recursive: true, errorOnExist: true, force: false });
      created.push(stagedSkill);
      await cp(join(packageRoot, 'LICENSE'), join(stagedSkill, 'LICENSE'), { errorOnExist: true, force: false });
      const entry = join(stagedSkill, 'SKILL.md');
      const instructions = (await readFile(entry, 'utf8'))
        .replaceAll('{{SKILLCREW_RUNTIME}}', join(skill, 'runtime', 'bin', 'skillcrew.mjs').replaceAll('\\', '/'))
        .replaceAll('{{SKILLCREW_SKILL_DIR}}', skill.replaceAll('\\', '/'));
      await writeFile(entry, instructions);
      await mkdir(join(stagedSkill, 'runtime'), { recursive: true });
      for (const name of ['bin', 'dist', 'templates', 'prompts']) {
        await cp(join(packageRoot, name), join(stagedSkill, 'runtime', name), { recursive: true, errorOnExist: true, force: false });
      }
      await cp(join(packageRoot, 'package.json'), join(stagedSkill, 'runtime', 'package.json'), { errorOnExist: true, force: false });
      await cp(join(packageRoot, 'LICENSE'), join(stagedSkill, 'runtime', 'LICENSE'), { errorOnExist: true, force: false });
      if (agent) {
        await mkdir(dirname(agent), { recursive: true });
        await cp(join(packageRoot, 'agents', 'skillcrew-reviewer.md'), stagedAgent, { errorOnExist: true, force: false });
        created.push(stagedAgent);
      }
      await rename(stagedSkill, skill);
      created.push(skill);
      if (agent) { await rename(stagedAgent, agent); created.push(agent); }
      process.stdout.write(JSON.stringify({ host, skill, agent }, null, 2) + '\n');
    } catch (error) {
      for (const path of created.reverse()) await rm(path, { recursive: true, force: true });
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
