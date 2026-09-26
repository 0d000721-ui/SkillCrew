---
name: skillcrew
description: 使用 agycli 与 Codex 构建 React 待办应用，提供默认自动双主模型或手动选择，协调阶段 Skill、冻结接口、断点恢复、实际测试和最多两轮定向修复。
argument-hint: '"待办需求" | status <run-id> | resume <run-id> | doctor'
disable-model-invocation: true
---

# SkillCrew 0.2

Use these installer-filled paths without searching other directories:

- Runtime: `{{SKILLCREW_RUNTIME}}`
- Skill directory: `{{SKILLCREW_SKILL_DIR}}`

Requires Node.js 24+. agycli's executable is `agy`; Gemini CLI is unnecessary. If placeholders remain, install with `scripts/install.mjs` first.

## Model choice

Before the first build in a conversation, offer one choice: **默认自动分配（推荐）** or **手动指定模型**. Explain briefly: automatic mode prefers two distinct capable leads for planning and independent architectural advice, with suitable supporting models for implementation. Use the host's choice UI if available. This is a preference question, not an extra execution approval.

- Reuse a preference already expressed in the user's request or conversation. Do not ask again on every build, status check or resume. The CLI itself is noninteractive; without model options it uses automatic selection.
- If the user chooses automatic, or explicitly skips the optional choice, use `--lead-mode auto` (the default). Never treat silence as a manual model choice. If manual selection was requested, obtain the missing role/model choices before starting inference calls; offer available IDs, never invent one. Roles the user elects to leave automatic remain automatic.
- Inspect `route` first. Show a concise table of the primary, co-lead, UI worker, logic worker and independent reviewer, plus any availability fallback. Announce the assignment and proceed once the preference is resolved; do not add another confirmation step.
- Default catalog preferences are Codex Astra primary, agy Opus co-lead, agy Flash UI and Codex Sol logic. The review uses a fresh independent Opus session. Selection depends on available configured candidates, role preferences and any dated evaluation evidence. Do not describe this as a live global ranking.
- Auto mode falls back to one lead only when no distinct co-lead candidate exists, with an explanation. Explicit `--lead-mode dual` or manual model choices must not be silently downgraded. Use `--lead-mode single` when the user wants a single lead.

## Build

1. Save the user's exact request in a JSON file `{"request":"..."}` using a file tool. Never interpolate it into shell text. Scope: a new local React todo app.
2. Resolve the model preference as above, then inspect `node <runtime> route` with the selected routing options. Availability and explicit choices take priority. Pass the same options to build. If the inventory changes between preview and build, show the actual saved assignment printed at build startup.
3. Run `node <runtime> build --request-file <file> --out <new-directory> --state-dir <state-directory>`. Docker is default; use `--verification local` when selected by the user's session. `--lead-mode auto` is default; `single` forces one lead and `dual` requires two. Options include `--primary-model provider/model`, `--ui-model`, `--logic-model`, `--co-lead-model`, `--routing-file`, `--inventory-file`, `--skills-file`, `--max-repairs 0|1|2`.
4. Preserve the Run ID printed at startup. The executor plans, 冻结接口, dispatches workers, checks files, runs tests, reviews independently and performs bounded repair. Do not start another overlapping coordinator.
5. Report status, output, actual check counts, repair count, checkpoint reuse, unresolved problems and report path. Only `ready` means passed. Progress is on stderr; final JSON is on stdout.

## Resume

- `resume <id> --state-dir <directory>` continues with saved planning and worker checkpoints. Keep the state directory and output-adjacent `.skillcrew-<id>-<round>` transaction folders.
- For a failed worker network call, resume after the error clears. Do not regenerate successful peers or change frozen routes.
- `status <id>` and `report <id>` show persisted evidence. For verification environment failures, fix the environment, run `check <id>` with the original verification mode, then resume.
- Hash mismatches, ownership violations, scope changes and repair limits are real blocks. Never edit state JSON, tests or interfaces to bypass them.
- Same-host dead process locks can be recovered; live or unverifiable locks cannot be automatically removed.
- Cached availability does not prove entitlement. Requested/observed IDs remain separate; Codex observed ID is unknown.
- Role Skills are instruction snapshots; attached scripts are not automatically executed. Load only a manifest explicitly selected by the user.

See [workflow.md](references/workflow.md).
