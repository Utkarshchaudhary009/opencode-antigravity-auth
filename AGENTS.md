# AGENTS.md — opencode-antigravity-auth

## Philosophy

I focus on building complex things as simple as possible. Please prioritize reducing complexity when solving problems. Match your tone to mine. We are working together, so maintain a professional yet concise tone.

When in doubt, pick the simpler approach. If a solution needs a paragraph to explain, it is probably too complicated.

## What This Project Is

An OpenCode custom-provider plugin (not MCP) for Antigravity auth, multi-account management, quota inspection, runtime metadata extraction, and bridge support. It registers Google OAuth login, account rotation, quota tooling, and a TUI slash-command UI (`/ag-accounts`).

The plugin stays as close as possible to the real installed Antigravity app rather than hardcoding brittle request behavior.

## Tech Stack

- **TypeScript 5** (strict, ESM)
- **Node.js >= 20**
- **Bun** — used for running CLI helpers (`bun run account`)
- **vitest** — test framework (`vitest.config.ts`)
- **zod v4** — runtime schema validation
- **google-auth-library** — OAuth token management
- **@opencode-ai/plugin** — OpenCode plugin SDK

## Project Structure

```
src/
  plugin.ts                # Main server plugin entry (provider, auth, events)
  tui.ts                   # TUI plugin entry (slash commands, account UI)
  plugin/                  # Core plugin logic
    accounts.ts            # Multi-account storage, rotation, selection
    auth.ts                # OAuth flow, token handling
    token.ts               # Token refresh, validation
    quota.ts               # Quota inspection and reporting
    request.ts             # Request helpers, rate-limit handling
    rotation.ts            # Account rotation and load balancing
    config/                # Config schema, loader, updater
      schema.ts            # Zod schema for antigravity.json
      loader.ts            # Config file discovery and loading
      updater.ts           # Writes model defs into opencode.json
    recovery/              # Session recovery module
    cache/                 # Response caching
    stores/                # Persistent state stores
    core/                  # Core utilities
    transform/             # Response transformers
    ui/                    # TUI dialog components
    storage.ts             # Account file persistence (v4 format)
    debug.ts               # Debug logging
    logger.ts              # Structured logger
    errors.ts              # Custom error types
    version.ts             # Antigravity version detection
    verification.ts        # Account verification probes
    fingerprint.ts         # Request fingerprinting
    cloud-code.ts          # Cloud Code API client
    model-catalog.ts       # Model discovery + static fallback catalog
    cli.ts                 # Standalone CLI entry
    cli-login-flow.ts      # CLI OAuth login
  bridge/                  # Antigravity language server bridge
    connect.ts             # LS connection management
    proxy.ts               # Bridge HTTP proxy server
    headless.ts            # Headless bridge fallback
    models.ts              # Bridge model discovery
    auth.ts                # Bridge auth
    pool.ts                # Bridge connection pooling
    options.ts             # Bridge config resolution
  hooks/
    auto-update-checker/   # Plugin self-update detection
  antigravity/             # Antigravity app runtime extraction
  cli/                     # CLI account helper entry
  constants.ts             # Shared constants

index.ts                   # Server plugin export (./dist/index.js)
tui.ts                     # TUI plugin export (./dist/tui.js)
script/                    # Build and test scripts
  build-schema.ts          # Generates assets/antigravity.schema.json
  test-models.ts           # E2E model tests
  test-regression.ts       # E2E regression tests
assets/
  antigravity.schema.json  # Generated JSON schema
docs/
  HANDOFF.md               # Architecture and developer handoff doc
```

## Build and Test

```powershell
# Build
npm run build

# Typecheck only
npm run typecheck

# Run all tests
npm test

# Run specific tests
npm test -- --run src/plugin/token.test.ts src/plugin/quota.test.ts

# Regenerate JSON schema
npm run build:schema
```

Always run `npm run typecheck` after changes. Run `npm test` before committing.

## Config Layers

There are two config layers — do not confuse them:

1. **OpenCode tuple options** — live in `opencode.json`, control plugin registration and bridge runtime (`app_dir`, `force_headless`, `cleanup_on_exit`, `debug`, etc.)
2. **`antigravity.json`** — plugin's own runtime config (`keep_thinking`, `session_recovery`, `account_selection_strategy`, `scheduling_mode`, etc.)

## Coding Standards

### TypeScript
- Strict mode. Avoid `any` — use `unknown` and narrow.
- Use `zod` schemas for runtime validation. The config schema lives in `src/plugin/config/schema.ts`.
- ESM only (`"type": "module"` in package.json). No CommonJS require().

### Testing
- vitest with `globals: true` and `node` environment.
- Tests live next to source files as `*.test.ts`.
- Mock external I/O (filesystem, network) — never hit real APIs in unit tests.
- Use `vi.mock()` for module mocking, `vi.spyOn()` for partial mocks.

### Error Handling
- Use custom error classes from `src/plugin/errors.ts`.
- Fail open when possible (e.g., missing quota data should not crash the plugin).
- Rate-limit handling uses grace periods and retry logic — do not simplify these away without understanding the failure modes in `docs/HANDOFF.md`.

### File Organization
- Keep modules focused. One concern per file.
- Config-related code goes in `src/plugin/config/`.
- Bridge-related code goes in `src/bridge/`.
- TUI-related code goes in `src/plugin/ui/` and `src/tui.ts`.

## Key Design Decisions

- The plugin reads runtime metadata from the locally installed Antigravity app first, then falls back to static values. Do not remove fallback paths.
- Bridge mode uses the installed Antigravity language server binaries. This is intentional — it matches IDE behavior more closely than direct request emulation.
- `reference/antigravity-proxy-tools` is a local clone of the upstream repo `ethan-w20/antigravity-proxy-tools`. It is kept as a reference for proxy/bridge behavior — consult it before reimplementing proxy logic.
- The reference folder is excluded from builds and tests via `.gitignore` and is not part of the shipped plugin.
- Multi-account rotation uses health scores, LRU hybrid selection, and token buckets. Changes to rotation logic should be tested against the scenarios in `docs/HANDOFF.md` section 12.
- The package name `opencode-antigravity-auth` is referenced throughout source code (plugin IDs, config writers, auto-updater). Do not rename it without updating all internal references.

## Workflow

1. Read the relevant source before changing anything. Start with `docs/HANDOFF.md` for architecture context.
2. Make the smallest change that solves the problem.
3. Run `npm run typecheck` and `npm test` after every change.
4. Keep commits focused — one concern per commit.
