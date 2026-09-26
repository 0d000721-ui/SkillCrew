# System language support

## Scope

Agent dialogue, CLI messages and report headings follow the system display language by default. The user confirmed all three surfaces. The initial bundled translations are Simplified Chinese and English; unsupported languages fall back to English. Model IDs, commands, JSON keys/enums, user requests and saved evidence retain their original values.

## Design

- Resolve `--lang` first, then `SKILLCREW_LANG`. `--lang auto` bypasses the environment override and enables system detection. Windows/macOS use the operating system UI language before terminal locale hints, because a host may inject `LC_ALL=C` while the desktop uses another language. Windows reads the preferred UI language (or UI culture); macOS reads AppleLanguages. Linux reads `LC_ALL`, `LC_MESSAGES`, `LANGUAGE`, then `LANG` before the default Intl locale. Failed detection falls back to English.
- Use an async context for one command's display language. Translate at the presentation boundary, with a shared catalog for labels and existing runtime diagnostics. Rendering a report in another language must not mutate the saved plan or hashes.
- Store the language for new model-generated explanations in the frozen plan. Add language instructions to planning, implementation, repair and review prompts. Existing runs keep their original prompts/cache behavior; changing display language does not invalidate their checkpoints.
- Add `locale` for the hosting Agent to discover the current language and localized model-choice labels without invoking any models. The installed Skill describes how to use that information and reuse explicit user preferences.
- Localize installer messages and installed Skill metadata. Skill metadata is static text read by the host; runtime dialogue and CLI language are re-detected on each invocation.

## Implementation and verification

- [x] Locale resolver/context/catalog; tests for precedence, locale normalization, system failures, unsupported language fallback and concurrent contexts.
- [x] CLI, routing, report and diagnostic presentation; tests for both languages, asynchronous errors, stable machine output, raw evidence preservation and unchanged hashes.
- [x] Model prompt language, host Skill and installer; verify planning/worker/repair/review prompts with injected responses, legacy planning cache reuse and a standalone installed runtime. Host conversation behavior is specified by the Skill and has not been tested in a new interactive host session.
- [x] TypeScript compilation, full regression suite (85 passing tests), independent review and documentation. Actual Windows detection and bilingual resume of an existing ready run also passed. See [validation](../VALIDATION.md#alpha3-系统语言验证) for evidence and platform/host limitations.

## Review focus

An English Windows UI with Chinese regional formats; an explicit language set before the command; malformed language tags; system detection failure; rendering an older frozen run in a different display language; model-supplied or user text that resembles a translated label.
