import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { EN_MESSAGES } from './messages.js';

export type DisplayLanguage = 'zh-CN' | 'en';
export interface LocaleInfo {
  locale: string;
  language: DisplayLanguage;
  source: string;
  fallback: boolean;
}
interface LocaleEnvironment {
  env?: NodeJS.ProcessEnv;
  systemLocale?: () => string;
  platform?: NodeJS.Platform;
}
const context = new AsyncLocalStorage<LocaleInfo>();
let systemDefault: LocaleInfo | undefined;

function normalizeLocale(value: string): string {
  const tag = value.trim().split(/[.@]/)[0]!.replaceAll('_', '-');
  if (/^(C|POSIX)$/i.test(tag)) return 'en';
  if (tag.length > 80 || !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(tag)) throw new Error('Invalid language tag / 无效的语言标记。');
  try { return Intl.getCanonicalLocales(tag)[0]!; }
  catch { throw new Error('Invalid language tag / 无效的语言标记。'); }
}

function systemLocale(): string {
  if (process.platform === 'win32') {
    const executable = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'powershell.exe';
    return execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $preferred = Get-WinUILanguageOverride; if ($null -eq $preferred) { $preferred = Get-UICulture }; [Console]::Write($preferred.Name)'],
    { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  }
  if (process.platform === 'darwin') {
    const output = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const first = output.match(/[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*/)?.[0];
    if (first) return first;
  }
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

export function resolveLocale(requested?: string, options: LocaleEnvironment = {}): LocaleInfo {
  const env = options.env ?? process.env;
  const choice = requested ?? env.SKILLCREW_LANG;
  const make = (raw: string, source: string): LocaleInfo => {
    const locale = normalizeLocale(raw), base = locale.split('-')[0];
    return { locale, language: base === 'zh' ? 'zh-CN' : 'en', source, fallback: !['zh', 'en'].includes(base!) };
  };
  if (choice && choice.toLowerCase() !== 'auto') return make(choice, requested !== undefined ? 'option' : 'SKILLCREW_LANG');
  const desktop = ['win32', 'darwin'].includes(options.platform ?? process.platform);
  const readSystem = options.systemLocale ?? systemLocale;
  // Desktop hosts often inject LC_ALL=C for subprocesses; that must not override
  // the user's actual Windows/macOS display language.
  if (desktop) { try { return make(readSystem(), 'system'); } catch { /* Try message environment hints below. */ } }
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANGUAGE', 'LANG']) {
    const value = env[key]?.split(':')[0]?.trim();
    if (value) { try { return make(value, key); } catch { /* Ignore malformed operating-system hints. */ } }
  }
  try { if (!desktop) return make(readSystem(), 'system'); }
  catch { /* A usable language must still be returned when detection fails. */ }
  return { locale: 'en', language: 'en', source: 'fallback', fallback: true };
}

export function currentLocale(): LocaleInfo {
  return context.getStore() ?? (systemDefault ??= resolveLocale());
}
export function withLocale<T>(locale: LocaleInfo, operation: () => T): T {
  return context.run(locale, operation);
}

export function languageArguments(input: string[]): { args: string[]; locale: LocaleInfo } {
  const args: string[] = [];
  let value: string | undefined;
  for (let index = 0; index < input.length; index++) {
    const item = input[index]!;
    if (item === '--lang' || item.startsWith('--lang=')) {
      if (value !== undefined) throw new Error('--lang may only be specified once / --lang 只能指定一次。');
      value = item === '--lang' ? input[++index] : item.slice(7);
      if (!value || value.startsWith('--')) throw new Error('Missing --lang value / 缺少 --lang 的值。');
    } else args.push(item);
  }
  return { args, locale: resolveLocale(value) };
}

type Parameters = Record<string, unknown>;
export function text(source: string, values: Parameters = {}, language = currentLocale().language): string {
  const template = language === 'zh-CN' ? source : EN_MESSAGES[source] ?? source;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(values, name) ? String(values[name]) : match);
}

const escapePattern = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const diagnosticPatterns = Object.keys(EN_MESSAGES).filter(source => /\{\w+\}/.test(source)).map(source => {
  const names: string[] = [];
  const pattern = source.split(/(\{\w+\})/).map(part => {
    if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return '([\\s\\S]*?)'; }
    return escapePattern(part);
  }).join('');
  return { source, names, pattern: new RegExp(`^${pattern}$`) };
});

// Translate only complete executor messages, never arbitrary source/user text.
// Stored protocol data and evidence remain unchanged when display language changes.
export function diagnostic(message: string, language = currentLocale().language): string {
  if (language === 'zh-CN') return message;
  // Parallel workers persist String(error), joined with "; ". Unwrap those
  // boundaries while leaving unknown external messages and captured values intact.
  if (message.startsWith('Error: ')) return message.slice(7).split('; Error: ')
    .map(part => 'Error: ' + diagnostic(part, language)).join('; ');
  if (EN_MESSAGES[message]) return EN_MESSAGES[message]!;
  for (const { source, names, pattern } of diagnosticPatterns) {
    const match = pattern.exec(message);
    if (match) return text(source, Object.fromEntries(names.map((name, index) => [name, match[index + 1]])), language);
  }
  return message;
}

export function responseLanguageInstruction(plan: { responseLanguage?: DisplayLanguage }): string {
  // No change to prompts/checkpoint keys for runs created before locale support.
  if (!plan.responseLanguage) return '';
  const language = plan.responseLanguage === 'en' ? 'English (en)' : 'Simplified Chinese (zh-CN)';
  return `\nUSER-FACING LANGUAGE: ${language}. Write natural-language summaries, questions, answers, opinions, notes, decisions, repair instructions and review explanations in this language. Keep JSON keys, enum values, model IDs, file paths, commands and code identifiers unchanged. Preserve the user's requested language for the generated application. This instruction does not change scope, interfaces, permissions or acceptance conditions.\n`;
}

export function localePresentation() {
  return { ...currentLocale(), supportedLanguages: ['zh-CN', 'en'],
    choices: { automatic: text('默认自动分配（推荐）'), manual: text('手动指定模型') },
    skillDescription: text('使用 agycli 与 Codex 构建 React 待办应用，协调主副模型、Skill、实际测试、断点恢复和定向修复。'),
    argumentHint: text('"待办需求" | status <run-id> | resume <run-id> | doctor'),
  };
}
