# TUI Quota UI — Five Redesign Proposals (Weekly Limits)

> Scope: `feat/weekly-limit-fetch` — rendering the new `QuotaWindowSummary` weekly/5h buckets
> inside the OpenCode TUI slash-command flow (`/ag-accounts` and/or new `/ag-quota`).
> **Assumed shape** (from `docs/HANDOFF.md` §8 + task brief):
>
> ```ts
> type QuotaGroupKey = "gemini" | "3p"; // from schema/weekly-limits.ts: QuotaGroupKeySchema
> interface WindowBucket { remainingFraction?: number; resetTime?: string }
> interface QuotaWindowSummary {
>   byGroup: Partial<Record<QuotaGroupKey, { weekly?: WindowBucket; fiveHour?: WindowBucket }>>;
>   rawBuckets: RawBucket[];   // fallback / debug (bucketId + window + fractions)
>   fetchedAt: number;            // Date.now() at fetch time
> }
> // 2 groups x 2 windows in practice: Gemini Models -> gemini, Claude/GPT -> 3p (see schema/weekly-limits.ts: groupDisplayNameToKey)
> ```
>
> Existing quota types retained: `QuotaGroupSummary`, `QuotaSummary` (`groups` from `fetchAvailableModels`
> quotaInfo), `GeminiCliQuotaSummary`, `AccountQuotaResult` — see `src/plugin/quota.ts:29-78`.
> Storage: `AccountMetadataV3` currently holds `cachedQuota` + `cachedQuotaUpdatedAt`; new proposal adds
> `quotaSummary?: QuotaWindowSummary` + persisted via `AccountStorageV5` (handled by parallel agent).
> Account list: `AccountManager.getAccounts()` / `loadAccounts()` + `activeIndex` / `activeIndexByFamily`
> — see `src/plugin/accounts.ts`.

---

## Context: Current TUI Wiring

- **Slash commands registered in `src/tui.ts:1487-1505`**: `/ag-accounts` (`COMMAND_OPEN`) → `showAccountsDialog()`
  lists `buildOptions()` (`src/tui.ts:1309-1387`) with `Accounts` category (one `accountTitle` per
  `loadAccounts()` entry) + `Actions`/`Danger Zone`. Selecting an account → `showAccountActions(index)`
  (`src/tui.ts:1189-1307`) which renders `accountInfoOptions()` + `cachedQuotaOptions()` (both return
  `TuiDialogSelectOption<string>[]`) + actions (`quota:<index>`, `verify:<index>`, `set-current`, `delete`).
- **Quota display today** (`src/tui.ts:946-1084` `runQuotaCheck`): fetches `checkAccountsQuota()` (parallel
  `fetchAvailableModels` + `retrieveUserQuota`), then `showTextDialog()` with plain lines:
  `Claude: 55% (resets in 2h)` etc. No window breakdown. Uses `formatQuotaPercent` (`src/tui.ts:121-127`)
  + `formatRelativeTime` + `formatReset` (`src/tui.ts:352-357`).
- **Dialog primitives** (`src/plugin/ui/`): `select.ts` (`select()` + `MenuItem<T>`, ANSI-aware truncation,
  windowed scrolling), `confirm.ts` (`confirm()`), `ansi.ts` (`ANSI.*`, `parseKey`, `isTTY`). `auth-menu.ts`
  is the standalone CLI helper (TTY `select` loop) — not the OpenCode `api.ui.DialogSelect` path, but same
  rendering idioms. Test patterns: `ansi.test.ts:1-80` (parseKey + ANSI codes), `auth-menu.test.ts:1-101`
  (formatRelativeTime, getStatusBadge with ANSI color assertions).
- **New requirement**: each account may expose up to **4 window buckets** (2 groups x 2 windows), each with
  `remainingFraction` (clamped `[0,1]` or `undefined` = unknown/fail-open → render `n/a`) and `resetTime`
  (ISO string or `undefined`, parse via `Date.parse`). Must surface alongside legacy `cachedQuota`
  without duplicating or obscuring rate-limit / verification badges.

---

## Design 1 — Ledger Table (`ag-quota` full-width matrix)

**One-line concept:** A dense, spreadsheet-style `DialogSelect` table under a new `/ag-quota` command —
every account is a row, every `(group x window)` is a column, sorted by lowest weekly remaining.

### Wireframe

```
┌  Quota Overview — Window Limits  (fetched 2m ago) ──────────────────┐
│ Accounts: 3  ·  Weakest weekly: alice@…  12% (Claude)  ·  [R]efresh  │
├────┬────────────────────┬──────────┬──────────┬──────────┬──────────┤
│ #  │ Account            │ G Wk 5h  │ G Pro/Fla│ C Wk 5h  │ Status   │
├────┼────────────────────┼──────────┼──────────┼──────────┼──────────┤
│ 1  │ alice@gmail.com ●  │  12%     │  88%     │  45%     │ low-W    │
│    │  cur  3d 02h  4h 11m│  1d 18h  │  4h 10m  │  6h 02m  │          │
│ 2  │ bob@gmail.com      │  67%     │  100%    │  99%     │ ok       │
│    │       2d 14h  4h 50m│  2d 14h  │  4h 50m  │  3d 01h  │          │
│ 3  │ carol@…  [disabled]│  n/a     │  n/a     │  n/a     │ disabled │
├────┴────────────────────┴──────────┴──────────┴──────────┴──────────┤
│ Up/Down: row  Enter: detail  Esc: back  R: refresh all  F: filter  │
└────────────────────────────────────────────────────────────────────┘
Inner row rendering (single account drill via Enter):
┌  alice@gmail.com — Window Detail ──────────────────────────────────┐
│ Claude & GPT │ W  12% ███░░░░░░░ resets 1d 18h │ 5h  88% ████████░  │
│ Gemini       │ W  45% █████░░░░░ resets 3d 02h │ 5h  99% █████████░ │
└────────────────────────────────────────────────────────────────────┘
```

*Two-line per account: top line = percent cells, second line (dim) = reset durations.
G = `gemini` (Gemini Models), C = `3p` (Claude & GPT); Wk=weekly, 5h=fiveHour. `●` = current.*
*Copy-pastable plain variant (fallback when `stdout.columns < 80`):*
```
#  Account             G-Wk  G-5h  C-Wk  C-5h  next-reset      status
1* alice@gmail.com     12%   88%   45%   99%   1d 18h (C-Wk)   low-weekly
2  bob@gmail.com       67%  100%   99%  100%   4h 50m (G-5h)   ok
3  carol@… [disabled]  n/a   n/a   n/a   n/a   —               disabled
```

### Components needed

| Reuse | New |
|-------|-----|
| `src/tui.ts: showTextDialog` pattern + `formatQuotaPercent` + `formatReset` + `formatWaitTime` + `DialogSelect` via `api.ui.DialogSelect` | `buildQuotaLedgerOptions()` → `TuiDialogSelectOption<string>[]` with 2-line `title`/`description` trick; `truncateAnsi` already handles ANSI + width |
| `src/plugin/ui/select.ts: MenuItem.hint` for reset suffix | Small helper `renderLedgerCell(bucket?: WindowBucket): string` (percent + bar micro-char) |
| `ANSI.dim` / `ANSI.cyan` for status dimming (as in `auth-menu.ts:44-52`) | Optional key handler `R`/`F` via custom `help` string — no new key parsing |

### Data mapping

| Visual element | Field |
|----------------|-------|
| Row label `alice@gmail.com` + `● current` | `AccountMetadataV3.email ?? "Account N"` + `index === activeIndex` |
| `G-Wk 12%` cell (`Gemini`) | `quotaSummary.byGroup["gemini"].weekly.remainingFraction` → `formatQuotaPercent()` else `n/a` |
| `G-5h 88%` cell | `byGroup["gemini"].fiveHour.remainingFraction` (same group, other window) |
| `3P-Wk / 3P-5h` (`Claude & GPT`) | `byGroup["3p"].weekly / byGroup["3p"].fiveHour` |
| `1d 18h` reset | `WindowBucket.resetTime` → `Date.parse(resetTime) - Date.now()` → `formatWaitTime()` / `formatReset()`; `undefined` → `—` |
| `low-weekly` badge | `min(weekly.remainingFraction) < 0.2` |
| `fetched 2m ago` | `quotaSummary.fetchedAt` → `formatRelativeTime()` |
| Row dimming / `[disabled]` | `account.enabled === false` or `verificationRequired` |

### Pros / Cons

- **Pros:** Highest density — all accounts comparable at a glance; natural sort key (lowest weekly first) surfaces the next account to use; plain-text fallback works in narrow terminals; leverages existing `DialogSelect` windowing (`select.ts:139-145`) for large pools.
- **Cons:** 4 quota columns + resets crowd `80-col` terminals (requires truncation or second line); percent-only cells hide `rawBuckets` debug detail; no per-bucket progress visual except micro-bar.

### Implementation effort — **M** (Medium)

**Files to touch:** `src/tui.ts` (new `showQuotaLedgerDialog(api)` + `register` new `/ag-quota` slash command, `buildLedgerRows()`), `src/plugin/storage.ts` / parallel schema agent (read `quotaSummary`), optional `src/plugin/ui/ledger.ts` if extracting pure render helpers for unit tests. No schema changes here. Tests: mirror `auth-menu.test.ts` pattern — pure helper `renderLedgerCell` + `getLowWeeklyBadge`.

---

## Design 2 — Gauge Bar Cards (progress-bar dashboard)

**One-line concept:** Stacked per-group cards with horizontal ANSI progress bars (10-char) per window — instant
visual triage by bar fill + color thresholds, opened via `/ag-quota` or as a mode toggle inside `/ag-accounts`.

### Wireframe

```
┌  Quota — Gauge View  (bob@gmail.com  ●current  ·  fetched 12s ago) ─┐
│  Gemini Models  (group: gemini)                                      │
│  Weekly    [█████░░░░░]  45%  resets 3d 02h  (bucket: gemini-weekly) │
│  5-hour    [█████████░]  92%  resets 4h 11m  (gemini-5h)              │
│                                                                     │
│  Claude & GPT                                                       │
│  Weekly    [██░░░░░░░░]  18%  LOW  resets 1d 18h  (3p-weekly)       │
│  5-hour    [██████████] 100%  resets 4h 50m  (3p-5h)                 │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│  [R] Refresh  [←→] Switch account  [T] Table view  Esc Back        │
└─────────────────────────────────────────────────────────────────────┘
Multi-account picker (before card):
┌  Select account ────────────────────────────────────────────────────┐
│ ● 1. alice@gmail.com  — W min 12% (Claude)  5h 88%  [● current]     │
│   2. bob@gmail.com    — W min 18%            5h 100%                │
│   3. carol@gmail.com  — W min 67%            5h  99%                │
└─────────────────────────────────────────────────────────────────────┘
```

*Bar length = 10 chars: `█` filled, `░` empty. Fill = `round(remainingFraction * 10)`.
`LOW` tag when `<20%`. Color via `ANSI.green/yellow/red` threshold.*

*Micro variant for narrow width (≤60 cols):*
```
Gemini  W [█████░░░░░] 45% 3d02h | 5h [█████████░] 92% 4h11m
Claude  W [██░░░░░░░░] 18% 1d18h | 5h [██████████]100% 4h50m
```

### Components needed

| Reuse | New |
|-------|-----|
| `src/plugin/ui/ansi.ts: ANSI.green/yellow/red/dim/reset` (as in `auth-menu.test.ts:21-27`) | `renderBar(fraction?: number, width=10): string` — pure, testable |
| `src/tui.ts: formatQuotaPercent`, `formatReset`, `formatWaitTime`, `shortenId` | `getBarColor(fraction): ANSI.*` (≥50 green, 20-50 yellow, <20 red, undefined dim) |
| `api.ui.DialogSelect` single card as non-selectable `category: "Window Limits"` options | Optional `BarCard` component in `src/plugin/ui/bar.ts` (pure string builder; no TTY) |
| `src/plugin/ui/select.ts: MenuItem.color` for per-row tint | `buildGaugeOptions(account, summary)` → `TuiDialogSelectOption[]` |

### Data mapping

| Visual element | Field |
|----------------|-------|
| Card header `Gemini Models` | `byGroup["gemini"]` (`QuotaGroupKey` = `gemini`, display "Gemini Models") |
| Card header `Claude & GPT` | `byGroup["3p"]` (`QuotaGroupKey` = `3p`, display "Claude and GPT models") |
| Bar fill proportion | `WindowBucket.remainingFraction` → `Math.round(clamped * 10)` |
| Bar color | Same `remainingFraction` thresholds; `undefined` → `dim` |
| `45%` label | `formatQuotaPercent(remainingFraction)` |
| `resets 3d 02h` | `WindowBucket.resetTime` → `formatWaitTime(Date.parse(resetTime)-Date.now())` |
| `bucket: gemini-weekly` suffix (dim) | `WindowBucket.bucketId` |
| Account switcher `W min 12%` | `Math.min(...weekly fractions)` per account |
| `fetched 12s ago` | `quotaSummary.fetchedAt` |
| `[R] Refresh` action | `checkAccountsQuota([account])` for single account |

### Pros / Cons

- **Pros:** Best glanceability — bar length encodes depletion pre-attentively; color threshold matches existing `getStatusBadge` idiom; per-account card scales cleanly to 1-3 accounts without horizontal crowding; pure helper is highly testable (mirrors `ansi.test.ts` color assertions).
- **Cons:** Low density for large pools (one card = one account → paging); bar chars render unevenly in some fonts; loses cross-account ranking until picker aggregates `W min`.

### Implementation effort — **S/M** (Small-Medium)

**Files to touch:** `src/tui.ts` (new `showGaugeDialog`), new `src/plugin/ui/bar.ts` (optional pure helpers), no storage change. Tests: `bar.test.ts` with cases `undefined→n/a+dim`, `0→empty+red`, `1→full+green`, `0.18→LOW`, truncation. Smallest new-files footprint of all proposals.

---

## Design 3 — Split-Pane Account Dashboard (per-account cards, list + detail)

**One-line concept:** A two-pane layout simulated inside a single `DialogSelect` — top pane is the account roster
with compact `W/5h` badges; selecting an account replaces the dialog with a dedicated per-account dashboard
card showing stacked weekly vs 5h rows per group, plus `cachedQuota` legacy context.

### Wireframe

```
Pane A — Roster (/ag-accounts upgraded)             Pane B — Detail (after Enter)
┌  Antigravity Accounts  (3) ──────────┐  ┌  2. bob@gmail.com — Quota Detail ────────┐
│ Accounts                             │  │ ● current  ·  enabled  ·  proj 8f3a…c12e │
│ ● 1. alice@gmail.com  W12% 5h88% L   │  │ fetched 42s ago  ·  cooling: —          │
│   2. bob@gmail.com    W18% 5h100%    │  │                                          │
│   3. carol@gmail.com  — disabled —   │  │  Claude & GPT                            │
│                                      │  │  Weekly  18%  ██░░░░░░░░  1d 18h        │
│ Actions                              │  │  5-hour 100%  ██████████  4h 50m        │
│  › Check quotas  › Verify all         │  │  ModelQuota (legacy): 42% (2 models)   │
│                                      │  │                                          │
│  Enter: open detail  R: refresh all  │  │  Gemini Models                           │
│                                      │  │  Weekly  45%  █████░░░░░  3d 02h        │
│                                      │  │  5-hour  92%  █████████░  4h 11m        │
│                                      │  │  ModelQuota (legacy): 67% (5 models)   │
│                                      │  │                                          │
│                                      │  │  Gemini CLI (separate pool)              │
│                                      │  │  gemini-3-pro  88%  resets 2h  5m       │
│                                      │  │  ── Actions: [R]efresh  [V]erify  [B]ack│
└──────────────────────────────────────┘  └──────────────────────────────────────────┘
Compact badge legend:  W=weekly  5h=five-hour  L=low-weekly  ●=current
```

*Badges in roster use `W18%` = `Math.round(weekly*100)%` truncated to 3 chars.
Disabled row shows `— disabled —` (dim) instead of badges.*

### Components needed

| Reuse | New |
|-------|-----|
| `src/tui.ts: buildOptions()` (roster), `accountTitle()`, `accountSummary()`, `cachedQuotaOptions()` | Roster badge builder `formatWindowBadge(summary): string` → `"W45% 5h92%"` |
| `src/tui.ts: showAccountActions()` as detail shell | New `showQuotaDetailDialog(api, index)` — reuses `accountInfoOptions` + adds Window Limits block |
| `src/plugin/ui/select.ts: MenuItem.hint` for badges | Detail row builder `renderDetailRow(label, bucket)` (bar + percent + reset) |
| `ANSI.dim` / `ANSI.cyan` for roster hints | Optional `src/plugin/ui/dashboard.ts` for badge/bar helpers |

### Data mapping

| Visual element | Field |
|----------------|-------|
| Roster badge `W12%` | `quotaSummary.byGroup["gemini" | "3p"].weekly.remainingFraction` → `formatQuotaPercent` compact; `family` is `QuotaGroupKey` (`gemini` = Gemini Models, `3p` = Claude & GPT) |
| Roster badge `5h88%` | `byGroup["gemini" | "3p"].fiveHour.remainingFraction` |
| `L` low flag | any `weekly.remainingFraction < 0.2` (same as Design 1) |
| Detail card header `bob@gmail.com` | `AccountMetadataV3.email` + status badges from `accountStatus()` |
| Detail row `Weekly 18% ██░░… 1d 18h` | Per-group `weekly` bucket → percent + bar + reset |
| Detail row `5-hour 100%` | Per-group `fiveHour` bucket |
| `ModelQuota (legacy): 42%` | `cachedQuota["claude" | "gemini-pro" | "gemini-flash"].remainingFraction` — legacy `QuotaSummary` (`QuotaGroup`) shown underneath; window quotas above use `QuotaGroupKey` (`gemini`/`3p`) |
| `Gemini CLI …` | `geminiCliQuota.models[]` (unchanged, already rendered in `runQuotaCheck`) |
| `fetched 42s ago` | `quotaSummary.fetchedAt` → `formatRelativeTime` |

### Pros / Cons

- **Pros:** Best multi-account scale — roster fits 20+ accounts via `select.ts` windowing (`rows - fixedLines`); detail pane unclutters narrow terminals (no horizontal table); reuses existing navigation pattern (`showAccountActions` push/pop via `Back`); surfaces legacy vs window quotas together (great for debugging migration).
- **Cons:** Two-step navigation (roster → detail) slower than table for cross-account comparison; badge shorthand (`W12%`) is cryptic without legend; detail pane duplicates some `cachedQuotaOptions` info.

### Implementation effort — **M** (Medium)

**Files to touch:** `src/tui.ts` (extend `buildOptions` roster lines with window badges; new `showQuotaDetailDialog` or extend `showAccountActions`'s `cachedQuotaOptions` → `windowQuotaOptions` block), optional `src/plugin/ui/dashboard.ts` for badge helpers. No new slash command needed (enhances existing `/ag-accounts`), but could also expose `/ag-quota` as alias to detail view. Tests: `dashboard.test.ts` for `formatWindowBadge(undefined→"W—")` etc.

---

## Design 4 — Compact Inline Summary (single-line per account)

**One-line concept:** The smallest possible change — extend the existing `accountSummary` description line
(`src/tui.ts:160-172`) and `cachedQuotaOptions` titles to append a one-line `W/5h` suffix, so weekly limits
are visible everywhere without adding a new dialog.

### Wireframe

```
┌  Antigravity Accounts ───────────────────────────────────────────────┐
│ Accounts                                                             │
│ ● 1. alice@gmail.com                                                 │
│     current | active | quota 2m ago | W12%·1d18h 5h88%·4h11m  (C/G)  │
│   2. bob@gmail.com                                                   │
│     active | quota 12s ago | W45%·3d02h 5h92%·4h11m  (G) W18%·1d18h…  │
│   3. carol@gmail.com                                                 │
│     disabled | verification-required | W— 5h—                        │
│                                                                      │
│ Account detail (after Enter → showAccountActions)                    │
│ ┌ Cached quota ────────────────────────────────────────────────────┐ │
│ │ Claude: 42% (resets in 2h)    W 18% (1d18h) · 5h 100% (4h50m)    │ │
│ │ Gemini Pro: 67% (resets...)   W 45% (3d02h) · 5h 92%  (4h11m)    │ │
│ │ Gemini Flash: 71%             W 45% (3d02h) · 5h 92%  (shared)   │ │
│ └────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
Legend: W=weekly  5h=five-hour  (C/G)=which groups have low weekly  ·=separator
Fallback narrow (≤50 cols):
  1. alice@…  W12% 5h88% | low-W
```

### Components needed

| Reuse | New |
|-------|-----|
| `src/tui.ts: accountSummary()` — append suffix there | Helper `formatWindowInline(summary): string` → `"W12%·1d18h 5h88%·4h11m"` |
| `src/tui.ts: cachedQuotaOptions()` — append to each `title` directly | Helper `formatInlineSuffix(byGroup)` shared between roster + detail |
| `src/tui.ts: formatQuotaPercent` + `formatReset` / `formatWaitTime` | Nothing else — two one-liners |
| `src/plugin/ui/select.ts: MenuItem.description` for suffix | Optional truncation fallback already in `select.ts: truncateAnsi` |

### Data mapping

| Visual element | Field |
|----------------|-------|
| Roster suffix `W12%·1d18h` | `byGroup["3p" | "gemini"].weekly` → `formatQuotaPercent` + `·` + `formatWaitTime(reset)`; if both groups present, show lowest weekly value + count ` (3p/gemini)` = which `QuotaGroupKey` contributes |
| `5h88%·4h11m` | `byGroup["3p" | "gemini"].fiveHour` — same pattern per group |
| `W— 5h—` | `undefined` remainingFraction or missing `quotaSummary` → `n/a` compact as `—` |
| `low-W` tag appended to status | Any weekly `< 0.2` |
| Detail line `W 18% (1d18h) · 5h 100% (4h50m)` | `byGroup["3p"].weekly` + `byGroup["3p"].fiveHour` appended to existing legacy `Claude: …` title (window group `3p`); Gemini rows use `byGroup["gemini"]` |
| `(shared)` hint | Window quotas have one entry per `QuotaGroupKey` (`gemini`/`3p`); legacy `cachedQuota` `gemini-pro` vs `gemini-flash` sharing is separate (no window duplication) |

### Pros / Cons

- **Pros:** Minimal UI churn — no new commands, dialogs, or navigation; works immediately in existing `showAccountsDialog`/`showAccountActions` flows; smallest code footprint (two call sites); accessible — no color-only signal (percent text remains); scales to any number of accounts (one line each).
- **Cons:** Lowest glanceability — weekly and 5h crammed into one dim suffix compete with existing `quota X ago` tags; hard to compare accounts (requires eye-scan of suffix numbers); reset durations truncated at `50-col` widths; not suited for sparkline/history.

### Implementation effort — **S** (Small)

**Files to touch:** `src/tui.ts` only — extend `accountSummary()` (`src/tui.ts:160-172`) + extend `cachedQuotaOptions()` (`src/tui.ts:174-212`) with suffix helper (could be inline). Optional: `src/plugin/ui/inline.ts` if extracting pure helpers for testing, but not required. Tests: inline helper unit tests (`W n/a → W—`). **Best first-ship candidate.**

---

## Design 5 — Drill-Down Navigator (hierarchical + sparkline/history-ready)

**One-line concept:** A new `/ag-quota` command that navigates hierarchically: Account picker → Group picker
(Claude vs Gemini) → Window detail (weekly vs 5h) with per-window meta (`bucketId`, `resetTime`, `description`)
+ a sparkline/history placeholder fed by `quotaSummary.rawBuckets` + future time-series cache.

### Wireframe

```
Level 1 — Account picker (/ag-quota)          Level 2 — Group picker (after select)
┌  Quota — Select Account ─────────────────┐ ┌  bob@gmail.com — Limits ─────────────┐
│ ● 1. alice@gmail.com  [current]          │ │ ─ Claude & GPT  ───────────────────── │
│     W min 12% ███░░  next 1d18h (Wk)    │ │  Claude Weekly   18%  ▂▅█▇ low         │
│   2. bob@gmail.com                       │ │  Claude 5-hour  100%  █████           │
│     W min 18% ██░░░  next 1d18h (Wk)    │ │ ─ Gemini Models ────────────────────── │
│   3. carol@gmail.com  [disabled]         │ │  Gemini Weekly  45%  ▅▇██             │
│     — no quota yet —                     │ │  Gemini 5-hour  92%  █████           │
│                                          │ │                                       │
│ Enter: open account  Esc: back           │ │ Enter: drill  B: back  R: refresh    │
└──────────────────────────────────────────┘ └───────────────────────────────────────┘

Level 3 — Window detail (after selecting "Claude Weekly")
┌  Claude Weekly — bob@gmail.com ──────────────────────────────────────┐
│ Bucket: 3p-weekly       Window: weekly    Fetched: 12s ago           │
│ Remaining: 18%  [██░░░░░░░░]  LOW (<20%)                              │
│ Reset:     2026-08-18T09:53:30Z  (in 1d 18h)  grace +1.5s → 1d 18h 2s │
│ Description: Weekly Limit Remaining  (You have used most of weekly)  │
│                                                                      │
│ History (sparkline, last 7 fetches — placeholder)                    │
│  100% ┤        ╭╮                                                     │
│   75% ┤   ╭╮   ││  ╭╮                                                  │
│   50% ┤╭╮ ││ ╭╮││  ││  ╭                                               │
│   25% ┤││ │╰╮│╰╯│  │╰╮ │  ← you are here (18%)                        │
│    0% ┼╯╰─╯ ╰╯  ╰──╯ ╰─╯                                                │
│       └────────────────────────────────  7d ago → now                │
│                                                                      │
│ Raw buckets (debug):                                                 │
│  • 3p-weekly  weekly  0.185  2026-08-18T09:53:30Z                     │
│  • 3p-5h      5h      1.000  2026-08-17T11:45:11Z                     │
│ ── [R]efresh this account  [C]opy reset ISO  [B]ack  Esc Quit ────── │
└──────────────────────────────────────────────────────────────────────┘
Narrow fallback (Level 3):
  Claude Weekly 18% LOW  reset 1d18h  bucket 3p-weekly  fetched 12s
```

### Components needed

| Reuse | New |
|-------|-----|
| `src/tui.ts: loadAccounts()`, `accountTitle()`, `accountStatus()`, `formatQuotaPercent`, `formatWaitTime` | `showQuotaNavigator(api)` orchestrator with 3 `DialogSelect` levels + state (selected account/group/window) |
| `src/plugin/ui/select.ts: MenuItem` (category headings `Claude & GPT` / `Gemini Models`, `hint` for sparkline mini) | `src/plugin/ui/navigator.ts` helpers: `buildAccountPickerOptions()`, `buildGroupPickerOptions()`, `buildWindowDetailLines()` (pure) |
| `src/plugin/ui/ansi.ts: ANSI.dim / ANSI.yellow / ANSI.red` for LOW badge | `renderSparkline(values: (number|undefined)[]): string` — pure, renders `▁▂▃▄▅▆▇█` (7 levels) + `·` for `undefined` |
| `src/plugin/ui/confirm.ts` pattern for `[R] Refresh` confirmation | Future `src/plugin/stores/quota-history.ts` (not in this doc — placeholder array of last N `fetchedAt`+fractions per bucket) |
| Test pattern `auth-menu.test.ts: getStatusBadge` for LOW badge unit tests | Test pattern `ansi.test.ts: stripAnsi` for asserting sparkline length |

### Data mapping

| Visual element | Field |
|----------------|-------|
| Level 1 row `W min 12% ███░░` | `Math.min(byGroup["3p"].weekly, byGroup["gemini"].weekly)` + micro-bar |
| Level 1 `next 1d18h (Wk)` | `earliest resetTime among all 4 buckets` → `formatWaitTime`; badge `(Wk)` vs `(5h)` = which window is the bottleneck |
| Level 2 row `Claude Weekly 18% ▂▅█▇` | Per `byGroup["3p"].weekly` → percent + inline micro-sparkline from last 7 fetched values (future store) |
| Level 3 header `Bucket: 3p-weekly Window: weekly` | `WindowBucket.bucketId` + `WindowBucket.window` |
| `Remaining: 18%` + bar | `WindowBucket.remainingFraction` |
| `Reset: 2026-… (in 1d 18h)` | `WindowBucket.resetTime` (ISO passthrough) + derived `formatWaitTime` + `grace_to_deadline_ms` offset |
| `Description: Weekly Limit …` | `rawBuckets[].description` (from `groups[].buckets[].description` in `retrieveUserQuotaSummary`, preserved in `rawBuckets`) |
| Sparkline | Array of last N `remainingFraction` per `bucketId` (requires new time-series store; doc proposes placeholder single-point `▇` until history accumulates) |
| `Raw buckets (debug)` | `quotaSummary.rawBuckets.map(b => bucketId window fraction resetTime)` |

### Pros / Cons

- **Pros:** Most extensible — natural home for future `quota-history` sparkline, `description` text, and per-bucket debug (`rawBuckets`); deep detail without crowding roster; hierarchical `DialogSelect` reuse avoids new rendering engine; pairs well with Designs 1-2 as "detail drill from table/gauge row".
- **Cons:** Most navigation steps (3 levels) for simple "which account has most weekly left?" question; sparkline requires new persistence (`quota-history` store) not in current `AccountStorageV4`; overkill for 1-2 accounts; more files/handlers to keep in sync with `showAccountActions`.

### Implementation effort — **L** (Large)

**Files to touch:** `src/tui.ts` (new `showQuotaNavigator` + `/ag-quota` slash registration, `register` extension), new `src/plugin/ui/navigator.ts` (builders + `renderSparkline`), optional `src/plugin/stores/quota-history.ts` (future ring buffer per `bucketId`; not required for v1 — render single-point placeholder), `src/plugin/storage.ts` (already touched by parallel agent for `quotaSummary`; history is second step). Tests: `navigator.test.ts` for builders + sparkline with cases `all undefined → "····"`, `0..1 ramp → "▁▂▃▄▅▆▇█"`. Offer as companion to Design 1/2, not standalone.

---

## Comparison Table

| Design | Density (accounts+buckets per viewport rows) | Glanceability (can you spot weakest weekly in <2s?) | Multi-account scale (1 vs 20 accounts) | A11y / color dependence | Effort | Best for |
|--------|----------------------------------------------|------------------------------------------------------|----------------------------------------|--------------------------|--------|----------|
| **1 — Ledger Table** | **High** — 1 row/account (2 lines with resets), 4 quota cols | Medium — numbers comparable but no bar length cue; sort by weekly helps | **Best at scale** — `DialogSelect` windowing handles 20+ rows | Good — percent text primary, truncation handles narrow; color optional (LOW badge) | **M** | Fleet view, weekly triage across many accounts |
| **2 — Gauge Bar** | Low — 1 card/account (4-6 lines) | **Best** — bar length + color is pre-attentive; LOW flag | Good (1-5 accounts ideal; paged beyond) | Medium — bar color is main cue; supplement with LOW text + percent | **S/M** | Single-account health, screenshots, demos |
| **3 — Split-Pane Dashboard** | Medium — roster 1 line/badge per acct + detail card on demand | Medium — roster badges glanceable, detail requires drill | **Best** — roster windowing scales, detail stays uncluttered | Good — badges are text (`W12%`), detail bars supplement | **M** | Default `/ag-accounts` upgrade (progressive disclosure) |
| **4 — Inline Summary** | **Highest** — 0 extra rows; suffix on existing lines | Low — suffix cramped, competes with status tags | Good — no layout change, any pool size | **Best** — fully text, no new color; `W—` handles missing | **S** | Zero-risk first ship, feature-flagged rollout |
| **5 — Drill-Down Navigator** | Low — 3 levels to full detail | Low for aggregate, **Best for per-bucket** — full meta + history | Medium — L1 windowing handles 20, but 3 hops/act | Good — sparkline + text dual-encoding; raw bucket fallback | **L** | Deep debugging, future history/sparkline, power users |

**Notes on "density" vs "scale":** Density counts visual quota fields per fixed 24-line viewport; scale counts how ergonomic the interaction is when the pool grows (windowing, paging, badge truncation).

---

## Cross-Cutting Concerns (apply to all designs)

- **Fail-open rendering:** `remainingFraction === undefined` → render `n/a` (Designs 1/2/3/5) or `—` (Design 4 compact) in `dim`; never `0%`. Threshold checks skip `undefined`. Applies to missing `quotaSummary` (pre-fetch) too → show `— no quota yet —` placeholder.
- **Window grouping:** `retrieveUserQuotaSummary` groups map via `groupDisplayNameToKey` (`schema/weekly-limits.ts:172-178`): "Gemini Models" → `byGroup["gemini"]`, "Claude and GPT models" → `byGroup["3p"]` (`QuotaGroupKey`). This is distinct from legacy `cachedQuota` groups (`QuotaGroup` = `claude` | `gemini-pro` | `gemini-flash` in `src/plugin/quota.ts:34`). Window quotas have one entry per `QuotaGroupKey`, not per-model; no Pro/Flash split.
- **Legacy vs window co-display:** Keep `cachedQuota` (`quota.ts: `QuotaSummary` per-family from `fetchAvailableModels`) until migration completes. Recommended pattern: render window buckets as primary, legacy as dim secondary `(model quota: 42%)` — makes drift visible.
- **Reset-time grace:** Display `resetTime` as wall-clock ISO secondary + relative `in Xd Yh`; if `grace_to_deadline_ms` (config) is non-zero, optionally show `+1.5s grace` in detail views (Design 5) but never in compact roster.
- **Freshness:** Every view header should surface `quotaSummary.fetchedAt` via `formatRelativeTime` (`src/tui.ts:129-141` style). Stale threshold (e.g. `> quota_refresh_interval_minutes * 2`) could show a `↻ stale` badge — future enhancement.
- **A11y / ANSI:** Color is supplementary only — every color-coded bar has a percent label; use `ANSI.dim` (not color alone) for `disabled`/`n/a`. Ensure `stripAnsi` tests cover truncation (as in `select.ts:31-69`).
- **Testing pattern:** Follow `ansi.test.ts` / `auth-menu.test.ts` conventions — vitest globals, pure helper tests first (bar, badge, sparkline), no filesystem/network I/O. Mock `Date.now()` for `formatWaitTime` determinism.
- **Telemetry / logs:** No bucket payload should be logged at `info` — only `debug` redacted as in `quota.ts` (email redacted to `…`). Keep `rawBuckets[].bucketId` safe; never log full `refreshToken`.

---

## Recommendation — Reference Implementation

**Ship Design 4 (Inline Summary) first, then Design 1 (Ledger Table) as the permanent `/ag-quota` view,
with Design 5's drill-down as a follow-up.**

**Rationale:** Design 4 is a **one-file, S-effort** change strictly inside `src/tui.ts` (`accountSummary` +
`cachedQuotaOptions`) that surfaces weekly/5h data everywhere users already look — the `/ag-accounts` roster
and account detail — without introducing a new command, navigation model, or store mutation. It is the only
proposal that can land on the current branch without coordinating with the parallel schema/fetch agent beyond
reading `account.quotaSummary?`, and it is fully fail-open (`W— 5h—` when pre-migration). Once the fetch +
`AccountStorageV5` path is merged and weekly data is being populated in the wild, promote Design 1 as the
dedicated `/ag-quota` command: it is the only proposal that answers the fleet question *"which of my N
accounts has the most weekly headroom?"* in a single viewport without drilling, and its table layout composes
well with the inline badges (same `renderLedgerCell` primitive). Design 2's gauge is retained as a display
mode toggle inside the ledger (`[T] Table / [G] Gauge`), avoiding a third command. Design 5's navigator +
sparkline is valuable but depends on the not-yet-built `quota-history` time-series store and is better as a
second phase — the Level-3 wireframe above doubles as the spec for that store (`bucketId → ring buffer of
{at, remainingFraction}`), so capturing this doc now preserves the intent without blocking the weekly fetch
milestone.

**If only one design is built:** choose **Design 1 (Ledger Table)** — it has the best trade-off across the
comparison criteria (high density, best multi-account scale, medium glanceability, good a11y, medium effort)
and uniquely covers the multi-account rotation concern that motivated the weekly-limit feature (operators run
3-20 accounts and need to pick the headroom account quickly). It can be built incrementally: start with
percent cells, add bars and sorting later.

---

## Implementation Order (suggested)

1. **v1 (this branch, doc only — now):** land this doc + parallel fetch/storage agent.
2. **v1.1 — Design 4 (S):** `src/tui.ts: accountSummary` suffix + `cachedQuotaOptions` suffix, guarded by
   `if (account.quotaSummary)`. Tests: `inline.test.ts`. No config gate needed.
3. **v1.2 — Design 1 (M):** new `src/tui.ts: showQuotaLedgerDialog` + `register` slash `ag-quota`
   (`aliases: ["quota"]`), optional `src/plugin/ui/ledger.ts`. Reuse inline helper.
4. **v1.3 — Design 2 mode toggle (S):** add `[G]auge` toggle inside ledger, extract `src/plugin/ui/bar.ts`.
5. **v2   — Design 5 history (L):** add `src/plugin/stores/quota-history.ts` ring buffer + sparkline in
   Level-3 detail; wire into ledger row `Enter` drill.

---

*Generated for `feat/weekly-limit-fetch` — 2026-08-23. No `src/` or `schema/` changes in this commit.*
