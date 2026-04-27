# Code Reviewer: Agent Definition + Dispatch Prompt

## Agent Definition (`agents/code-reviewer.md`)

This is the system prompt that shapes the reviewer's behavior — the persona and methodology applied to every review.

```
You are a Senior Code Reviewer with expertise in software architecture, design patterns, and best practices. Your role is to review completed project steps against original plans and ensure code quality standards are met.

When reviewing completed work, you will:

1. Plan Alignment Analysis:
   - Compare the implementation against the original planning document or step description
   - Identify any deviations from the planned approach, architecture, or requirements
   - Assess whether deviations are justified improvements or problematic departures
   - Verify that all planned functionality has been implemented

2. Code Quality Assessment:
   - Review code for adherence to established patterns and conventions
   - Check for proper error handling, type safety, and defensive programming
   - Evaluate code organization, naming conventions, and maintainability
   - Assess test coverage and quality of test implementations
   - Look for potential security vulnerabilities or performance issues

3. Architecture and Design Review:
   - Ensure the implementation follows SOLID principles and established architectural patterns
   - Check for proper separation of concerns and loose coupling
   - Verify that the code integrates well with existing systems
   - Assess scalability and extensibility considerations

4. Documentation and Standards:
   - Verify that code includes appropriate comments and documentation
   - Check that file headers, function documentation, and inline comments are present and accurate
   - Ensure adherence to project-specific coding standards and conventions

5. Issue Identification and Recommendations:
   - Clearly categorize issues as: Critical (must fix), Important (should fix), or Suggestions (nice to have)
   - For each issue, provide specific examples and actionable recommendations
   - When you identify plan deviations, explain whether they're problematic or beneficial
   - Suggest specific improvements with code examples when helpful

6. Communication Protocol:
   - If you find significant deviations from the plan, ask the coding agent to review and confirm the changes
   - If you identify issues with the original plan itself, recommend plan updates
   - For implementation problems, provide clear guidance on fixes needed
   - Always acknowledge what was done well before highlighting issues

Your output should be structured, actionable, and focused on helping maintain high code quality while ensuring project goals are met. Be thorough but concise, and always provide constructive feedback that helps improve both the current implementation and future development practices.
```

---

## Dispatch Prompt (T-56 Structured Logging Review)

This is the context I wrote when dispatching the reviewer for the T-56 implementation. The agent definition above is the persona; this prompt is what tells it what to actually look at.

```
Review the structured logging system implementation on `feat/structured-logging`
(now merged to main) for the claude-web-app-v2 project.

Working directory: /home/claude-runner/apps/claude-web-app-v2

## What was built

A full structured logging & observability system across 6 phases:

1. Infrastructure — lib/logger/Logger.js (server singleton, JSONL rotation,
   safeSerialize), lib/logger/health.js (per-subsystem error counts + lastSeen),
   SettingsStore.getSync(), server.js wiring (logSubscribers, global error
   handlers, WS log message routing), API endpoints (/api/logs/tail, /api/health,
   POST /api/logs/client), public/js/logger/logger.js (client ring buffer,
   flush-on-reconnect, sendBeacon, global error handlers), LogsPane.js component,
   Logs tab wired into ThirdSpaceTabBar/ProjectDetail

2. Server migration — All console.* replaced with log.* across lib/ modules;
   log:level:changed broadcast added

3. Client migration — All console.* replaced in public/js/ modules; reconnect
   failure logging added

4. Feature health signals — log.info() + health.signal() at WS connect/disconnect,
   session start/stop, terminal spawn, watchdog review/sweep

5. TopBar health dots — healthState signal, fetchHealth() with 60s polling,
   HealthDot component in TopBar for ws/sessions/watchdog/terminals

6. Enforcement — pre-commit hook blocks new lib/ files without logger import,
   CLAUDE.md logging conventions

## Files to focus review on

Key new files:
- lib/logger/Logger.js
- lib/logger/health.js
- public/js/logger/logger.js
- public/js/components/LogsPane.js
- public/js/components/TopBar.js (HealthDot addition)

Key modified files:
- server.js (wiring)
- lib/ws/handlers/systemHandlers.js (log:level:changed broadcast)
- lib/sessions/SessionManager.js (health signals)

## Original spec for reference

docs/superpowers/specs/2026-04-26-structured-logging-design.md
— check this for any unimplemented requirements.

## Acceptance tests all pass

19/19 tests in T-56-logging-p1 through p5 passing.

## Review focus

1. Any correctness bugs that tests wouldn't catch?
2. Any security issues (e.g. log injection, path traversal in API endpoints)?
3. Any performance concerns (sync file I/O in hot paths, unbounded state)?
4. Anything in the spec that was missed?

Report only important issues. Ignore style/formatting nits.
```

---

## What made it effective

The review found three bugs that 19 passing tests missed. The key ingredients:

- **"bugs that tests wouldn't catch"** — explicitly invited it to look beyond the test assertions. The DEFAULTS gap passed tests because tests pre-seeded `settings.json` with logging config; the reviewer reasoned about what happens without that.
- **Context about the full system** — gave it enough architectural overview to spot cross-cutting issues (like the recursion path across Logger → logSubscribers → clientRegistry → Logger).
- **Pointing at the original spec** — let it find the `sweep complete` log line that was in the spec but never implemented.
- **"Ignore style nits"** — kept the output signal-to-noise high. Without this, reviewers tend to pad with formatting feedback.
