# Workflow boundaries

Read `locale` at invocation startup. Follow its effective language for dialogue, choices, progress and report explanations; pass an explicit user preference with `--lang`. New runs preserve their model response language in the frozen plan. Presentation changes must not rewrite requests, evidence, JSON protocol fields or old planning checkpoints.

Order: plan → freeze → parallel workers → integrate → checks → independent review → ready. Code failures/high review issues go through primary triage → owner-specific repair → full checks → fresh review. Default repair limit is two; resume cannot reset it.

Resolve the user's automatic/manual model preference once per conversation, reusing existing instructions. Auto is the CLI default: choose a capable primary and a distinct co-lead, falling back to single only when the latter is unavailable. Explicit choices take priority; contradictory or unavailable choices fail. Show actual assignments before inference calls and keep them frozen on resume.

Advisors propose at most five structured notes each; the primary answers every note. The co-lead adds an independent critical opinion, while the primary retains final authority. Each worker may ask one clarification per round. Interface/scope changes stop automation.

UI slot `gemini` permits `src/ui/**` and `src/styles/**`; logic slot `codex` permits `src/core/**`. Providers are configured separately. Models receive source and selected Skill snapshots and return structured full-file contents. The executor checks actual differences. Dependencies, contracts and tests remain protected. Reserved paths, traversal, symlinks and oversized changes are rejected.

Planning caches bind route, prompt, phase and output digest. Worker checkpoints bind route, contract, input and delivery hash. A failed peer does not invalidate accepted checkpoints. Publication journals bind an output-adjacent candidate and rollback copy; verify hashes before transitions. Human changes and `.git` metadata cannot be silently overwritten.

Machine gates: install, typecheck, build, six unit tests and two browser tests. Docker is default. Explicit local mode runs fixed commands in a temporary copy as ordinary host processes. Environment errors stop without asking models to rewrite code.

Review uses a new session, source snapshot, fixed acceptance, review Skill and machine evidence. Unexecuted reproductions are `proposed`. Recheck source and frozen plan before accepting a review; missing/failed machine checks cannot become success through model prose.

Read reports for unresolved issues and repair history. Prior examples do not guarantee future runs; every delivery needs its own gates. Scope remains a new React todo app.
