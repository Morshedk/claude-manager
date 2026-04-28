# Auditor & Program Manager — Design Spec

**Date:** 2026-04-28
**Status:** Draft
**Scope:** Two new automated systems built into WatchdogManager: a daily Auditor and a nightly Program Manager.

---

## Problem Statement

The current watchdog review (`watchdogReview()`) handles operational health — session crashes, rate limits, context size, credit snapshots, activity summaries. It does not assess:

- Whether changes were documented or tested
- Whether work aligns to project strategy
- Whether the same problems keep recurring
- Whether recommendations actually helped
- Whether factory sessions are doing the right work next
- Whether the user is frustrated or the system is wasting credits

Additionally, there is no structured backlog management. Factory sessions read static CLAUDE.md roadmaps and go idle when they finish the listed work. Requirements from the user, from audit findings, and from bug reports have no single intake point.

## Solution Overview

Two new automated methods in WatchdogManager, running as nightly timers:

1. **Auditor** — runs at 2am UTC daily. Produces governance-grade daily digests and weekly reviews (Fridays). Assesses 13 dimensions. Self-improving: identifies its own blind spots and writes requirements for better instrumentation.

2. **Program Manager (PM)** — runs at 4am UTC daily (after the Auditor). Maintains a prioritized backlog per project and updates the "Current Sprint" section in each project's CLAUDE.md so factory sessions always know what to work on next. Also invocable manually via `/pm` skill.

They communicate through files: the Auditor writes digests and recommendations, the PM reads them as an input source alongside the project roadmap and user requirements.

---

## Part 1: The Auditor

### 1.1 Modes

**Daily Digest** (2am UTC every night):
- Covers the preceding 24 hours
- One digest per active project + one cross-project infrastructure digest
- Uses Claude with extended thinking enabled

**Weekly Review** (2am UTC on Fridays, replaces that day's daily digest):
- Reads the last 14 days of daily digests (2-week lookback window)
- Produces a scored review with trend analysis
- Checks whether implemented recommendations actually helped
- Compares dimension scores to the previous week

### 1.2 Audit Dimensions

The Auditor evaluates 13 dimensions, each producing findings in the daily digest:

| # | Dimension | What it checks |
|---|-----------|---------------|
| 1 | **Change management** | Did commits have tests? Were features documented? Did anything ship without going through dev/qa skills? Are there commits with no context? |
| 2 | **Strategy alignment** | Is the work matching the project roadmap phases? Are factory sessions doing what the Current Sprint says? Is unplanned work creeping in? |
| 3 | **Recurring failures** | Same errors repeating, sessions stuck in loops, watchdog restarting the same thing, identical error fingerprints across days |
| 4 | **Cost efficiency** | Burn rate trends, idle sessions wasting credits, subagent costs, periods where credits go unused (could have been doing background work) |
| 5 | **Security & hygiene** | Leaked tokens in logs, stale sessions with open tmux, orphan processes, disk usage creep, sensitive files in commits |
| 6 | **Documentation gaps** | Features that shipped without decision docs, CLAUDE.md out of date, missing test coverage, undocumented API endpoints |
| 7 | **Process improvement** | Are skills/prompts/gates effective? Could the dev skill's design phase be sharper? Is the QA skill catching real issues? Missing gates (e.g., no gate between merge and deploy)? Should factory sessions have better system prompts? |
| 8 | **Meaningful interactions** | Significant decisions made in conversations, requirements clarified, design choices confirmed, breakthroughs. Institutional knowledge that shouldn't be lost on context restart. |
| 9 | **User sentiment** | Frustration signals: repeated corrections, terse responses, sessions killed mid-task, "I already told you" patterns. Tracked over time — is the system getting more helpful or more annoying? |
| 10 | **Work patterns** | Times of day the user is active, productivity vs. frustration correlation with time, weekend vs. weekday patterns. Informs when the PM should schedule intensive autonomous work. |
| 11 | **Credit utilization** | Not just spend but efficiency — are credits approaching limits with no alert? Are there idle periods where factory sessions could have been doing background work? Waste detection. |
| 12 | **Lost & repeated work** | Sessions that did the same task twice, abandoned branches with significant work, features implemented then reverted, merge conflicts that destroyed changes. |
| 13 | **Blind spot detection** | What can't the Auditor assess? What data is missing? What instrumentation would it need? These become structured requirements for the PM. |

### 1.3 Beta/Prod Gap Analysis (v2 project specific)

For claude-web-app-v2, the Auditor also tracks:
- What's deployed on beta (port 3002) that hasn't been promoted to prod (port 3001)
- How long features sit on beta before promotion
- Whether beta-only bugs are caught before hitting prod
- Git diff between main branch and beta worktree

### 1.4 Closed Session Coverage

Sessions that were active during the day but stopped/archived before the 2am audit run must be included. The Auditor stitches together data from:

- **`data/session-lifecycle.json`** — create/delete events with timestamps
- **`data/activity-logs/cm-*.json`** — summaries written by watchdogReview() while sessions were alive (persist after session stops)
- **`data/session-archive/{id}.json`** — metadata + last 10 log entries for sessions swept by stale cleanup
- **`data/sessions.json`** — full session list including stopped sessions with `exitedAt` timestamps
- **`data/sessionlog/`** — session event logs if captured

For each session active in the last 24 hours, the digest includes: what it accomplished, how long it ran, how it ended (user stopped, crashed, swept as stale), and whether it completed its intended work.

**Gap detection:** If lifecycle events exist for a session but no activity log entries do, the session was created and destroyed between watchdog review cycles and never got summarized. The Auditor flags these as a blind spot.

### 1.5 Data Sources (all read-only)

The Auditor never modifies operational state. It reads:

| Source | Purpose |
|--------|---------|
| `git log` per project | Commits, branches, diffs |
| `git diff main...beta` (v2) | Beta/prod gap |
| `data/activity-logs/*.json` | Session summaries and key actions |
| `data/session-lifecycle.json` | Session create/stop/archive events |
| `data/session-archive/*.json` | Archived session metadata |
| `data/sessions.json` | Current session list with timestamps |
| `data/credit-history.json` | Cost trends and burn rates |
| `data/health.json` | Subsystem health signals |
| `data/connection-log.jsonl` | Client connection patterns (feature usage, work patterns) |
| `data/sessionlog/` | Session event logs |
| `~/.claude/skills/*/SKILL.md` | Skill definitions (assess effectiveness) |
| `{project}/CLAUDE.md` | Strategy/roadmap (assess alignment) |
| `{project}/BACKLOG.md` | Backlog state (assess PM effectiveness) |
| `{project}/AUDIT-DIGESTS/recommendations.md` | Track recommendation outcomes |

### 1.6 Storage

**Per project** (Niyyah, v2, any future project):
```
{project}/AUDIT-DIGESTS/
├── daily/
│   ├── 2026-04-27.md
│   ├── 2026-04-28.md
│   └── ...
├── reviews/
│   ├── 2026-04-25-weekly.md
│   └── 2026-05-02-weekly.md
├── blind-spots.md              # cumulative, entries added/removed as gaps found/resolved
└── recommendations.md          # living ledger of all recommendations + outcomes
```

**Cross-project infrastructure:**
```
data/audit/
├── daily/
│   ├── 2026-04-27.md
│   └── ...
├── reviews/
│   └── 2026-04-25-weekly.md
└── recommendations.md
```

### 1.7 Recommendation Tracking

`recommendations.md` is a living ledger. Each recommendation gets:

| Field | Description |
|-------|-------------|
| ID | Auto-incrementing (R-001, R-002, ...) |
| Date | When the recommendation was made |
| Recommendation | What to change |
| Source | Which digest/dimension produced it |
| Status | `open`, `implemented`, `rejected`, `revised` |
| Outcome | Measured result after implementation (or "too early to measure") |

The weekly Friday review:
1. Checks every **open** recommendation — is it still relevant? Should priority change?
2. Checks every **recently implemented** recommendation — did it help? Measures the same signals that originally triggered it.
3. If improvement detected → records positive outcome
4. If no change or regression → marks for revision with analysis of why
5. Reports summary: "3 of 5 implemented recommendations showed improvement, 1 had no effect (revising), 1 too early to measure"

### 1.8 Weekly Review Scoring

The Friday review scores each active project on 5 governance dimensions (1-5 scale):

| Dimension | Score basis |
|-----------|------------|
| Change management discipline | % of commits with tests, documentation rate |
| Strategy alignment | % of work matching roadmap/sprint items |
| Cost efficiency | Burn rate trend, idle waste ratio |
| Process maturity | Skill usage rate, gate compliance |
| Documentation quality | Decision docs per feature, CLAUDE.md freshness |

Scores are compared to the previous week with trend arrows (improving/stable/declining).

### 1.9 Notifications

After each run, a Telegram summary is sent via the factory session's bot token:
- **Daily:** 5-10 line summary — key findings, top recommendation, any red flags
- **Weekly:** Executive summary — scores with trends, recommendation effectiveness, top 3 action items

---

## Part 2: The Program Manager

### 2.1 Overview

The PM maintains a prioritized backlog per active project and keeps factory sessions pointed at the right work by updating the "Current Sprint" section in each project's CLAUDE.md.

### 2.2 Input Sources (priority order)

1. **User direct requirements** — fed via `/pm add <requirement>` or Telegram
2. **Project CLAUDE.md roadmap** — phased feature plan (parsed on first run, tracked for manual changes)
3. **Auditor daily digests** — improvement recommendations, process gaps
4. **Auditor blind spots** — instrumentation/monitoring requirements
5. **Auditor weekly reviews** — strategic drift findings, recurring issues needing systemic fixes
6. **Activity logs** — what actually got built (to mark completions, detect scope creep)
7. **Git history** — what shipped, what got reverted, what's on open branches

### 2.3 Output: Two Files Per Project

**`{project}/BACKLOG.md`** — the full prioritized backlog:

```markdown
# Backlog — Niyyah

## Phase 1: Core (in progress)
- [x] NPH-001: Expo init + project scaffold | shipped 2026-04-10
- [x] NPH-002: Aladhan prayer times integration | shipped 2026-04-15
- [ ] NPH-003: Prayer home screen UI | P1 | est: 4h
  - Acceptance: shows 5 daily prayers with next-prayer countdown for user's location
- [ ] NPH-004: Basic habit tracker (3 habits) | P1 | est: 6h
  - Acceptance: create/edit/delete habits, daily check-off persists locally

## Phase 2: Premium
- [ ] NPH-010: Supabase auth integration | P2 | est: 8h | blocked-by: NPH-003
  - Acceptance: email/password signup, login, session persistence

## Improvements (from Auditor)
- [ ] AUD-001: Add API endpoint usage tracking | P2 | source: blind-spot 2026-04-28
  - Acceptance: middleware logs request counts per endpoint per hour
- [ ] AUD-002: Sharpen dev skill design prompt | P3 | source: digest 2026-04-27
  - Acceptance: dev skill requires file:line citations in design output

## Bugs
- [ ] BUG-001: Detox E2E test discovery broken | P1 | source: factory error loop 2026-04-25
  - Acceptance: `npm run test:e2e` discovers and runs smoke.test.ts
```

Each item has: ID, priority (P1-P4), estimate, acceptance criteria, source, status, and optional dependencies.

**`{project}/CLAUDE.md` "Current Sprint" section:**

```markdown
## Current Sprint (updated 2026-04-28 04:00 UTC)

1. **NPH-003: Prayer home screen UI** — Build the main prayer times screen
   showing 5 daily prayers with next-prayer countdown. Use Aladhan API
   integration from NPH-002. Acceptance: all 5 prayers display with correct
   times for user's location.

2. **BUG-001: Fix Detox E2E test discovery** — jest.config.js testMatch pattern
   doesn't find e2e/ tests. Fix the pattern and verify `npm run test:e2e`
   discovers smoke.test.ts.

3. **AUD-001: Add API endpoint usage tracking** — Add lightweight request
   counting middleware so the Auditor can assess feature adoption. Log counts
   to data/endpoint-usage.json hourly.
```

Items are written as clear instructions — a factory session reads one and starts working immediately.

### 2.4 Nightly Cycle (4am UTC)

1. **Read inputs** — latest Auditor digest, git log since last run, activity logs, current backlog, Auditor blind-spots.md and recommendations.md
2. **Mark completions** — match git commits and activity summaries against backlog items, mark shipped with date
3. **Detect new work** — Auditor findings become backlog items (AUD- prefix), unplanned commits not matching any backlog item get flagged as scope creep
4. **Reprioritize** — sort by: P1 bugs first, then phase order, then Auditor recommendations by severity, then P2-P4
5. **Update Current Sprint** — pick top 3-5 unblocked items, write into CLAUDE.md with full context for factory sessions
6. **Report** — write summary to `data/pm/daily/{date}.md`: items completed, items added, sprint changes, blockers
7. **Telegram notification** — "Sprint updated: 2 completed, 3 new from Auditor. Next: [item titles]"

### 2.5 Initial Seeding

On first run for a project, the PM:
1. Parses the existing CLAUDE.md roadmap (phases, features, tech decisions)
2. Converts each feature into a structured backlog item with ID, priority (based on phase), and acceptance criteria derived from the feature description
3. Writes the initial `BACKLOG.md`
4. Sets the first Current Sprint from Phase 1 items
5. Commits both files

### 2.6 Manual Mode (`/pm` skill)

The PM is also a skill for direct interaction:

| Command | Action |
|---------|--------|
| `/pm` | Show current sprint + backlog summary for the active project |
| `/pm add <requirement>` | Add a new backlog item — PM assigns ID, priority, estimate |
| `/pm reprioritize` | Force re-sort and sprint update now |
| `/pm status` | What's completed, in progress, blocked, and next |

### 2.7 CLAUDE.md Write Safety

The PM rewrites only the `## Current Sprint` section of CLAUDE.md. It:
- Reads the full file, locates the `## Current Sprint` heading
- Replaces only that section (up to the next `##` heading or EOF)
- Writes atomically (tmp + rename)
- If the section doesn't exist yet, appends it at the end

This avoids merge conflicts with manual edits to other sections.

### 2.8 Skill File

The `/pm` skill lives at `~/.claude/skills/pm/SKILL.md` and delegates to `WatchdogManager.pmCycle()` for automated operations and reads `BACKLOG.md` directly for display commands.

### 2.9 Scope Boundaries

The PM does NOT:
- Assign work to specific sessions — it sets the sprint, factory sessions pick up what's next
- Create branches or PRs — that's the dev skill
- Run tests or validate — that's the qa/test skills
- Assess quality — that's the Auditor
- Modify operational state — it only writes BACKLOG.md, CLAUDE.md, and its own reports

---

## Part 3: How They Work Together

### 3.1 Nightly Pipeline

```
2:00 AM UTC ─── Auditor runs ───────────────────────────────────┐
                │                                                │
                ├─ Reads: git log, activity logs, sessions,      │
                │         credit history, health signals,        │
                │         connection logs, skill definitions,    │
                │         CLAUDE.md roadmaps                     │
                │                                                │
                ├─ Writes: daily digest (per project + infra)    │
                │          updates recommendations.md            │
                │          updates blind-spots.md                │
                │                                                │
                ├─ Sends: Telegram daily summary                 │
                │                                                │
                └─ On Fridays: weekly review replaces digest     │
                   scores dimensions, checks recommendation     │
                   outcomes, compares to last week               │
                                                                 │
                ─── 2 hour gap ──────────────────────────────────┘
                                                                 │
4:00 AM UTC ─── PM runs ────────────────────────────────────────┐
                │                                                │
                ├─ Reads: Auditor digest (just written),         │
                │         git log, activity logs, backlog,       │
                │         blind-spots.md, recommendations.md     │
                │                                                │
                ├─ Marks completions in BACKLOG.md               │
                ├─ Adds new items from Auditor findings          │
                ├─ Reprioritizes                                 │
                ├─ Updates Current Sprint in CLAUDE.md           │
                │                                                │
                ├─ Writes: PM daily report                       │
                ├─ Sends: Telegram sprint update                 │
                │                                                │
                └─ Factory sessions wake up to fresh sprint      │
```

### 3.2 The Self-Improvement Loop

```
Auditor finds blind spot ──→ writes to blind-spots.md
           │
PM reads blind-spots.md ──→ creates backlog item (AUD-xxx)
           │
PM puts it in Current Sprint ──→ factory session builds it
           │
Feature ships ──→ Auditor detects new data source available
           │
Auditor removes blind spot ──→ next digest has richer analysis
           │
Auditor assesses: did the new instrumentation help? ──→ updates recommendations.md
```

### 3.3 Project Coverage

| Project | Path | Auditor | PM | Notes |
|---------|------|---------|-----|-------|
| Niyyah | `/projects/niyyah` | Daily digest + weekly review | Backlog + sprint | Primary product |
| claude-web-app-v2 | `/home/claude-runner/apps/claude-web-app-v2` | Daily digest + weekly review + beta/prod gap | Backlog + sprint | Platform/infrastructure |
| claude-web-app (v1) | `/home/claude-runner/apps/claude-web-app` | Daily digest only (low activity) | No backlog (legacy) | Monitor for regressions only |
| Infrastructure | N/A | Cross-project digest in `data/audit/` | N/A | Credits, system health, patterns |

### 3.4 Timing Configuration

Both timers are configurable via SettingsStore:

```json
{
  "auditor": {
    "enabled": true,
    "dailyHourUTC": 2,
    "weeklyDay": "friday",
    "lookbackDays": 14,
    "projects": ["/projects/niyyah", "/home/claude-runner/apps/claude-web-app-v2"]
  },
  "pm": {
    "enabled": true,
    "dailyHourUTC": 4,
    "sprintSize": 5,
    "projects": ["/projects/niyyah", "/home/claude-runner/apps/claude-web-app-v2"]
  }
}
```

---

## Part 4: Implementation Notes

### 4.1 New Methods on WatchdogManager

- `auditDaily()` — the daily digest cycle
- `auditWeeklyReview()` — the Friday review cycle
- `pmCycle()` — the nightly PM cycle
- `_buildAuditContext(projectPath, lookbackHours)` — gather all data sources for a project
- `_buildClosedSessionReport(lookbackHours)` — stitch together data for sessions active but now closed
- `_parseBacklog(projectPath)` — read and parse BACKLOG.md
- `_writeBacklog(projectPath, items)` — write updated BACKLOG.md
- `_updateCurrentSprint(projectPath, items)` — rewrite the Current Sprint section in CLAUDE.md
- `_seedBacklogFromRoadmap(projectPath)` — first-run: parse CLAUDE.md roadmap into backlog items

### 4.2 New Timers

Two new `setInterval`/scheduled timers alongside the existing tick and review timers:
- Audit timer: fires at `dailyHourUTC` (default 2am UTC)
- PM timer: fires at `pmDailyHourUTC` (default 4am UTC)
- Weekly review: audit timer checks if today is the configured weeklyDay

### 4.3 Extended Thinking

Both the Auditor and PM use `_callClaude()` with extended thinking enabled. This requires a flag or a new method variant since the current `_callClaude()` doesn't pass thinking flags. The audit and PM prompts are complex enough to benefit from deep reasoning.

### 4.4 Prompt Design

The Auditor prompt is the critical differentiator. It doesn't summarize — it thinks like a **senior engineering consultant reviewing a multi-agent autonomous operation**. Key prompt characteristics:

- Structured output format (markdown with findings per dimension)
- Explicit instruction to check all 13 dimensions
- Access to previous recommendations.md to track outcomes
- Instruction to be honest about what it can't assess (blind spots)
- For weekly review: compare to previous scores, measure recommendation effectiveness

The PM prompt thinks like a **technical program manager** who:
- Understands dependencies between tasks
- Writes acceptance criteria that are testable
- Prioritizes bugs over features
- Recognizes scope creep
- Writes sprint items as clear instructions, not ticket titles

### 4.5 Low-Power Mode Consideration

The current low-power mode would block Auditor and PM calls if AI is failing. Since these run at night when API load is typically lower, they should:
- Retry once after a 5-minute delay if the first call fails
- If both attempts fail, write a minimal digest noting the failure and retry next night
- Never skip the weekly review — queue it for the next successful night run

### 4.6 File Size Management

Daily digests accumulate. To prevent unbounded growth:
- Keep the last 90 days of daily digests, archive older ones to `{project}/AUDIT-DIGESTS/archive/`
- Keep all weekly reviews (they're the permanent record)
- recommendations.md and blind-spots.md are curated by the Auditor — completed/rejected items move to an archive section within the file

---

## Part 5: What This Does NOT Cover

- **Real-time alerting** — the existing watchdog tick handles this
- **Session health monitoring** — the existing watchdogReview() handles this
- **Code review** — the dev skill's review phase handles this
- **Test execution** — the qa/test skills handle this
- **Deployment** — the promote-version skill handles this

The Auditor and PM sit above all of these, providing governance and direction.
