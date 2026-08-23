# AGENTS.md — opencode-antigravity-auth

## What This Is

An OpenCode provider plugin (not MCP) for Antigravity: Google OAuth login, multi-account rotation, quota inspection, runtime metadata extraction from the locally installed app, language-server bridge support, and a `/ag-accounts` TUI. Design rule: mirror the installed app — never hardcode brittle request behavior.

## Principles

- **Simplest solution wins.** If it takes a paragraph to explain, redesign it.
- **Fail open.** Degraded data must never crash the plugin.
- **Read on demand.** Load only the files a task needs; `docs/HANDOFF.md` is a deep-dive reference, not required reading.

## Stack

TypeScript 5 (strict, ESM-only) · Node ≥20 · Bun (CLI helpers) · vitest (colocated `*.test.ts`) · zod v4 (runtime validation) · google-auth-library · @opencode-ai/plugin SDK

## Layout

```
src/
  plugin.ts / tui.ts       # server + TUI plugin entries
  plugin/
    accounts|auth|token|quota|request|rotation   # core auth/quota mechanics
    config/                # zod schema, loader, opencode.json writer
    recovery/ cache/ stores/ transform/ ui/
    storage.ts debug.ts logger.ts errors.ts version.ts verification.ts
    fingerprint.ts cloud-code.ts model-catalog.ts cli.ts cli-login-flow.ts
  bridge/                  # LS connection, proxy, headless, pooling
  hooks/auto-update-checker/
  antigravity/             # runtime metadata extraction
  cli/ constants.ts
schema/                    # endpoint response schemas (weekly limits)
index.ts tui.ts            # dist exports
script/                    # build-schema, e2e tests
assets/ docs/HANDOFF.md
```

## Config Layers — never conflate

1. `opencode.json` — OpenCode tuple options, bridge runtime (`app_dir`, `force_headless`, …)
2. `antigravity.json` — plugin runtime config (`keep_thinking`, `session_recovery`, `account_selection_strategy`, …); zod schema in `src/plugin/config/schema.ts`

## Invariants

- Metadata resolution: installed app first, static fallback second — never remove fallbacks.
- `opencode-antigravity-auth` is load-bearing (plugin IDs, config writers, auto-updater) — renaming means updating every reference.
- Rate-limit handling = grace periods + retry; don't simplify without reading HANDOFF's failure-mode notes. Rotation changes: validate against HANDOFF's rotation scenarios.
- `reference/antigravity-proxy-tools` = upstream proxy reference; consult it, never reimplement; excluded from builds/tests.

## Conventions

- **TS:** strict, no `any` (`unknown` → narrow), ESM imports only, one concern per module.
- **Errors:** custom classes from `src/plugin/errors.ts`.
- **Placement:** config → `plugin/config/`, bridge → `bridge/`, TUI → `plugin/ui/` + `tui.ts`.
- **Commits:** conventional style (`feat(quota): …`), one concern each.
- **Tests:** colocated, mocked external I/O — never real APIs; `vi.mock()` for modules, `vi.spyOn()` for partials.

## Commands

```powershell
npm run build            # compile
npm run typecheck        # types only
npm test                 # all tests
npm test -- --run <file> # targeted
npm run build:schema     # regenerate assets/antigravity.schema.json
```

## Workflow

1. Read the files the task needs.
2. Implement the smallest change that solves it.
3. **Gates:** typecheck, test, lint green before any commit.
4. Local review subagent over the diff; fix what it flags.
5. Commit + PR. Large sequential work → **stack** instead: one concern per layer, dependencies point downward, every layer passes the gates alone. `gh stack init/add/push/submit`; land via `gh stack merge` (plain `gh pr merge` fails on stacks).
6. After ~10 min, address GitHub bot reviews: fix in the **lowest layer owning the issue**, then `gh stack rebase --upstack` if stacked; commit.
7. Merge to `main`.
