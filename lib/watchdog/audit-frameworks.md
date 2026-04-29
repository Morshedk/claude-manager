# Governance Audit Reference Framework

This document provides the Auditor with structured evaluation criteria drawn from
established frameworks (CISA, PRINCE2, Agile, SDLC, testing best practices) adapted
for an autonomous AI development system with multiple concurrent sessions.

---

## 1. System Topology (MUST READ FIRST)

This system runs two servers from the SAME codebase in the SAME directory:

| Server | PM2 Name | Port | Data Directory | Purpose |
|--------|----------|------|----------------|---------|
| Production | claude-v2-prod | 3001 | data/ | Stable, user-facing |
| Beta | claude-v2-beta | 3002 | data-beta/ | Testing new code |

**Critical implications for auditing:**
- Both servers share `data/watchdog-state.json` — session state may bleed across environments
- A session "running" in watchdog state may belong to either prod or beta
- Code deployed to main is NOT live until `pm2 restart` is run for each server
- Beta gets restarted first; prod should only restart after beta is verified clean
- The factory sessions (factory, factory2) are persistent watchdog-managed sessions
- Managed sessions (cm-XXXXXXXX) are user-created and may be on either server

**When auditing, always check:**
- Are changes deployed to beta only, prod only, or both?
- Is a session's data dir consistent with which server it's on?
- Are factory sessions pointed at the right workdir for their server?
- Is there drift between what's deployed on prod vs beta?

---

## 2. Session Lifecycle Patterns

### Healthy Session Lifecycle
```
created → starting → running → [producing output] → idle → stopped/archived
```

### Failure Patterns to Detect

**A. Restart Loop (Priority: CRITICAL)**
Session dies → watchdog restarts → session hits same blocker → dies again.
- Signal: Same session name appearing in restart logs 3+ times in 24h
- Signal: Identical idle summaries across consecutive activity log entries
- Root cause categories: missing permission, invalid CLI flag, broken dependency, context too large
- CISA equivalent: "Repeated incident without root cause analysis" (IR-4)

**B. Zombie Session (Priority: HIGH)**
Session shows as RUNNING but produces no output, no commits, no tool calls.
- Signal: Status "running" but last activity log entry >4h old
- Signal: tmux pane shows idle prompt or error message
- Cost impact: consumes a terminal slot, gets health-checked by watchdog, burns credits

**C. Orphan Session (Priority: MEDIUM)**
Session exists in tmux but not in watchdog registry, or vice versa.
- Signal: `tmux list-sessions` shows sessions not in watchdog-state.json
- Signal: watchdog-state.json has entries with status "running" but no tmux session
- Recovery: POST /api/sessions/recover

**D. Context Explosion (Priority: HIGH)**
Session accumulates too much context, responses degrade, costs spike.
- Signal: Session with >50,000 tokens in context window
- Signal: Increasing response times in activity logs
- Signal: AI summarization calls returning truncated or nonsensical output
- SDLC equivalent: Memory leak — unbounded resource growth

**E. Unobserved Autonomous Session (Priority: MEDIUM)**
Session running with no browser viewer attached for extended period.
- Signal: viewerCount = 0 for >2h on a running session
- Note: May be intentional (factory sessions run unattended) or indicate WS disconnect
- Distinguish: WS disconnect (system issue) vs user absence (expected)

---

## 3. CISA Framework — Adapted Controls

Reference: NIST SP 800-53 / CISA Cybersecurity Performance Goals

### Access Control (AC)
- [ ] Sessions use OAuth tokens, not raw API keys
- [ ] ANTHROPIC_API_KEY is always empty in session environment (OAuth preferred)
- [ ] No hardcoded credentials in committed code
- [ ] Telegram bot tokens stored in env vars, not in code
- [ ] .env files excluded from git via .gitignore

### Audit and Accountability (AU)
- [ ] All session starts/stops logged to session-lifecycle.json
- [ ] Activity logs capture session summaries at regular intervals
- [ ] Credit usage tracked per session via credit-history.json
- [ ] Health signals emitted for all subsystems (ws, sessions, terminals, watchdog)
- [ ] Structured logging with tags, not bare console.log

### Configuration Management (CM)
- [ ] Changes go through beta before production (git worktree workflow)
- [ ] Conventional commit messages (feat/fix/test/docs prefixes)
- [ ] No force-pushes to main
- [ ] PM2 process config versioned and consistent
- [ ] Settings stored in settings.json with schema defaults

### Incident Response (IR)
- [ ] Watchdog detects and restarts crashed sessions automatically
- [ ] Telegram notifications sent for session crashes, restarts, rate limits
- [ ] Restart count tracked with pause threshold (4 restarts → 30min cooldown)
- [ ] Error loops detected with fingerprinting (same error = same root cause)
- [ ] **Gap to check: Is there escalation for repeated identical failures?**

### Risk Assessment (RA)
- [ ] Cost burn rate monitored and anomalies flagged
- [ ] Credit runway projected
- [ ] Low-credit fallback mode configured
- [ ] Session idle time tracked
- [ ] **Gap to check: Are blind spots from previous audits being addressed?**

### System and Communications Protection (SC)
- [ ] WebSocket connections authenticated
- [ ] Server listens on 127.0.0.1 (not 0.0.0.0)
- [ ] No external API endpoints exposed without auth
- [ ] Session data isolated per server (data/ vs data-beta/)

---

## 4. PRINCE2 — Adapted Principles

### Continued Business Justification
- Every session should have a clear purpose tied to a project goal
- Factory sessions exist to advance niyyah (the product) — if they're not, why?
- Platform (claude-web-app-v2) work is justified only when it unblocks product delivery
- **Audit check:** Can you trace each active session to a backlog item or stated goal?

### Learn from Experience
- Previous audit digests should show improving trends, not repeated findings
- Same RED/AMBER items appearing across 3+ consecutive digests = governance failure
- Recommendation effectiveness must be tracked (R-XXX → did it help?)
- **Audit check:** Are yesterday's recommendations being actioned?

### Defined Roles and Responsibilities
- Factory sessions: autonomous product development (niyyah)
- Dev sessions: user-directed development tasks
- Watchdog: monitoring, restart, health signals
- Auditor: governance review (this role)
- PM: backlog and sprint management
- **Audit check:** Is any role vacant or malfunctioning?

### Manage by Stages
- Phases defined in CLAUDE.md for each project
- Sprint items selected from BACKLOG.md
- Current Sprint section in CLAUDE.md shows active work
- **Audit check:** Is the current sprint aligned with the current phase?

### Manage by Exception
- Escalate only when thresholds are breached
- Restart loop threshold: 4 restarts → pause
- Idle recurrence threshold: 3 identical summaries → alert (NOT YET IMPLEMENTED)
- Cost anomaly threshold: >2x average burn rate
- **Audit check:** Are exception thresholds defined and enforced?

### Focus on Products
- Deliverables over process: commits, features shipped, tests passing
- A session that runs for 8h with no commits has a problem
- **Audit check:** What was actually delivered in the last 24h?

---

## 5. Agile Practices — Audit Criteria

### Sprint Health
- Sprint items should be small enough to complete in 1-3 sessions
- Items in sprint for >3 days without progress are blocked
- Sprint velocity: items completed per week (track trend)
- WIP limit: no more than sprint-size items in progress simultaneously

### Definition of Done
- Code committed with conventional prefix
- Tests passing (or explicitly deferred with justification)
- Deployed to beta
- CHANGELOG updated for user-facing changes
- No new lint warnings introduced

### Retrospective Signals
- What went well: GREEN dimensions, completed recommendations
- What needs improvement: persistent AMBER/RED dimensions
- Action items: carry forward unresolved recommendations with escalated priority

### Technical Debt Tracking
- Sessions that produce workarounds instead of fixes
- Files growing beyond maintainable size (>500 lines)
- Known test failures that persist across audit cycles
- Dependency updates deferred

---

## 6. SDLC Best Practices — Audit Criteria

### Requirements Traceability
- Each backlog item should have acceptance criteria
- Commits should reference what they implement (feat/fix prefix + description)
- **Audit check:** Can you trace from a commit to a backlog item to a project goal?

### Testing Pyramid
- Unit tests: core logic, pure functions
- Integration tests: module interactions
- E2E tests: full user workflows (Detox for mobile, Playwright for web)
- **Audit check:** Are new features covered by tests at the appropriate level?

### Deployment Pipeline
- Code → beta → verify → prod (never skip beta)
- Each pm2 restart is a deployment event — should be logged
- Rollback plan: git revert + pm2 restart
- **Audit check:** Was the deployment sequence followed?

### Environment Parity
- Beta and prod should run the same code version (after deployment)
- Config differences (port, data dir) should be the ONLY delta
- If beta has bugs, they should be fixed before promoting to prod
- **Audit check:** Is there code drift between beta and prod?

---

## 7. Testing Practices — Audit Criteria

### Test Quality Indicators
- Tests that verify behavior, not implementation (no testing mock internals)
- Tests that can fail for the right reasons (not overly broad assertions)
- Tests that run in isolation (no shared state, no test-order dependencies)
- **Known issue: 10 pre-existing WatchdogManager test failures (creditState) + 2 SessionStore**

### Test Coverage Strategy
- New code should have tests
- Bug fixes should have regression tests
- Refactoring should not break existing tests
- **Audit check:** Did new commits include tests?

### E2E Test Infrastructure
- Jest + Detox for niyyah mobile app
- Jest for claude-web-app-v2 backend
- Playwright for UI testing
- **Known blocker:** jest.config.js testMatch doesn't include Detox specs

### AI-Specific Testing Considerations
- AI responses are non-deterministic — test structure, not exact content
- Prompt changes should be tested with representative inputs
- Timeout handling is critical — AI calls can hang
- JSON parsing from AI output needs defensive handling (regex extraction)

---

## 8. Cost Governance — Audit Criteria

### Credit Categories
- devV1, devV2: development session categories
- Watchdog: monitoring overhead
- Factory/factory2: autonomous session costs

### Cost Anomaly Signals
- Any single category >50% of total = investigate
- Watchdog cost >15% of total = polling too frequently
- Idle session with any cost = wasted credits
- Burn rate change >2x in 24h = something changed

### Cost Optimization Checklist
- [ ] Idle sessions paused or terminated after threshold
- [ ] Watchdog polling frequency matched to session activity level
- [ ] Low-credit fallback mode configured and tested
- [ ] Extended thinking (--effort max) reserved for complex tasks, not routine
- [ ] Context window managed — compact or restart when too large

---

## 9. Recommendation Tracking Protocol

When issuing recommendations:

1. **Use sequential IDs:** R-001, R-002, etc. per digest (reset each day)
2. **Set explicit priority:** critical > high > medium > low
3. **Track across days:** If R-001 from Day N is not resolved by Day N+1, escalate priority
4. **Three-strike rule:** If the same recommendation appears in 3 consecutive digests without action, mark it CRITICAL and flag it as a governance failure
5. **Link to framework:** Reference which framework principle the recommendation addresses

### Escalation Ladder
- Day 1: Recommendation issued at assessed priority
- Day 2: Priority escalates one level if unactioned
- Day 3: Becomes CRITICAL with governance failure flag
- Day 4+: Include in "Systemic Issues" section — the audit itself is failing if outputs aren't consumed

---

## 10. Blind Spot Self-Assessment

The Auditor should check its own monitoring for these gaps every cycle:

### Data Quality
- [ ] Are activity logs being written for all sessions?
- [ ] Is credit-history.json being updated?
- [ ] Are health signals fresh (<5 min old)?
- [ ] Is session-lifecycle.json capturing all events?

### Coverage
- [ ] Can I see both prod and beta server state?
- [ ] Do I have visibility into the git log for all monitored projects?
- [ ] Can I distinguish between intentional idle and broken idle?
- [ ] Do I know which sessions are factory vs user-created?
- [ ] Do I know which server each session belongs to?

### Timeliness
- [ ] Am I running at the scheduled time?
- [ ] Are my digests being consumed by the PM?
- [ ] Are recommendations being tracked across days?
- [ ] Is the weekly review scheduled and running?
