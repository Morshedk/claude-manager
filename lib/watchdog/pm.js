// lib/watchdog/pm.js
// Pure functions for reading, writing, and managing project backlogs in BACKLOG.md format,
// and updating the Current Sprint section in CLAUDE.md.
// No AI calls — just filesystem operations and markdown parsing.

import fs from 'fs';
import path from 'path';
import { log } from '../logger/Logger.js';

const TAG = 'pm';

// ── File I/O helpers ───────────────────────────────────────────────────────

function readFileSafe(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// ── parseBacklog ───────────────────────────────────────────────────────────

/**
 * Reads BACKLOG.md and parses it into structured items.
 * Each item has: { id, title, done, shipped, section, priority, estimate, acceptance, blockedBy, source }
 * Returns [] if no BACKLOG.md exists.
 * @param {string} projectPath
 * @returns {Array<object>}
 */
export function parseBacklog(projectPath) {
  const filePath = path.join(projectPath, 'BACKLOG.md');
  const content = readFileSafe(filePath, null);
  if (content === null) return [];

  const lines = content.split('\n');
  const items = [];
  let currentSection = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect section headers (## Phase 1: Core, ## Bugs, etc.)
    const sectionMatch = line.match(/^## (.+?)(?:\s*\(.*\))?\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    // Detect backlog items: - [x] or - [ ]
    const itemMatch = line.match(/^- \[(x| )\] (.+)$/);
    if (!itemMatch) continue;

    const done = itemMatch[1] === 'x';
    const rawText = itemMatch[2];

    // Parse ID and title: "TST-001: Setup project" or just "TST-001: Setup project | P1 | ..."
    // Split on | to separate metadata segments
    const segments = rawText.split('|').map(s => s.trim());
    const mainPart = segments[0]; // "TST-001: Setup project" or similar

    const idTitleMatch = mainPart.match(/^([A-Z]+-\d+):\s*(.+)$/);
    if (!idTitleMatch) continue;

    const id = idTitleMatch[1];
    let title = idTitleMatch[2].trim();

    // Parse metadata from remaining segments
    let priority = null;
    let estimate = null;
    let blockedBy = null;
    let source = null;
    let shipped = null;

    for (let s = 1; s < segments.length; s++) {
      const seg = segments[s];

      // shipped date: "shipped 2026-04-10"
      const shippedMatch = seg.match(/^shipped\s+(\S+)/);
      if (shippedMatch) {
        shipped = shippedMatch[1];
        continue;
      }

      // Priority: P1, P2, P3
      const priorityMatch = seg.match(/^(P[1-3])$/);
      if (priorityMatch) {
        priority = priorityMatch[1];
        continue;
      }

      // Estimate: "est: 4h"
      const estMatch = seg.match(/^est:\s*(.+)$/);
      if (estMatch) {
        estimate = estMatch[1].trim();
        continue;
      }

      // Blocked-by: "blocked-by: TST-002"
      const blockedMatch = seg.match(/^blocked-by:\s*(.+)$/);
      if (blockedMatch) {
        blockedBy = blockedMatch[1].trim().split(/\s*,\s*/);
        continue;
      }

      // Source: "source: qa 2026-04-20"
      const sourceMatch = seg.match(/^source:\s*(.+)$/);
      if (sourceMatch) {
        source = sourceMatch[1].trim();
        continue;
      }
    }

    // Also check if "shipped" is embedded in the main title segment
    if (!shipped) {
      const titleShippedMatch = title.match(/^(.+?)\s*shipped\s+(\S+)\s*$/);
      if (titleShippedMatch) {
        title = titleShippedMatch[1].trim();
        shipped = titleShippedMatch[2];
      }
    }

    // Look ahead for acceptance criteria on the next line
    let acceptance = null;
    if (i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      const acceptMatch = nextLine.match(/^\s+- Acceptance:\s*(.+)$/);
      if (acceptMatch) {
        acceptance = acceptMatch[1].trim();
      }
    }

    items.push({
      id,
      title,
      done,
      shipped: shipped || null,
      section: currentSection,
      priority,
      estimate,
      acceptance,
      blockedBy,
      source,
    });
  }

  log.info(TAG, 'backlog parsed', { projectPath, itemCount: items.length });
  return items;
}

// ── writeBacklog ───────────────────────────────────────────────────────────

/**
 * Writes items back to BACKLOG.md, grouped by section.
 * Marks section status (complete/in progress).
 * Uses atomic write (tmp + rename).
 * @param {string} projectPath
 * @param {string} projectName
 * @param {Array<object>} items
 */
export function writeBacklog(projectPath, projectName, items) {
  // Group items by section
  const sections = new Map();
  for (const item of items) {
    const sec = item.section || 'Uncategorized';
    if (!sections.has(sec)) sections.set(sec, []);
    sections.get(sec).push(item);
  }

  const lines = [`# Backlog — ${projectName}`, ''];

  for (const [section, sectionItems] of sections) {
    // Determine section status
    const allDone = sectionItems.every(it => it.done);
    const anyDone = sectionItems.some(it => it.done);
    let status = '';
    if (allDone) status = ' (complete)';
    else if (anyDone) status = ' (in progress)';

    lines.push(`## ${section}${status}`);

    for (const item of sectionItems) {
      const checkbox = item.done ? '[x]' : '[ ]';
      const metaParts = [];

      if (item.shipped) metaParts.push(`shipped ${item.shipped}`);
      if (item.priority) metaParts.push(item.priority);
      if (item.estimate) metaParts.push(`est: ${item.estimate}`);
      if (item.blockedBy && item.blockedBy.length > 0) {
        metaParts.push(`blocked-by: ${item.blockedBy.join(', ')}`);
      }
      if (item.source) metaParts.push(`source: ${item.source}`);

      const metaSuffix = metaParts.length > 0 ? ' | ' + metaParts.join(' | ') : '';
      lines.push(`- ${checkbox} ${item.id}: ${item.title}${metaSuffix}`);

      if (item.acceptance) {
        lines.push(`  - Acceptance: ${item.acceptance}`);
      }
    }

    lines.push('');
  }

  const filePath = path.join(projectPath, 'BACKLOG.md');
  atomicWrite(filePath, lines.join('\n'));
  log.info(TAG, 'backlog written', { projectPath, itemCount: items.length });
}

// ── updateCurrentSprint ────────────────────────────────────────────────────

/**
 * Updates the ## Current Sprint section in CLAUDE.md.
 * If section exists: replaces content between ## Current Sprint and next ## (or EOF).
 * If section doesn't exist: appends at the end.
 * Preserves all other CLAUDE.md sections.
 * Uses atomic write.
 * @param {string} projectPath
 * @param {Array<object>} sprintItems — each { id, title, acceptance, description }
 */
export function updateCurrentSprint(projectPath, sprintItems) {
  const filePath = path.join(projectPath, 'CLAUDE.md');
  let content = readFileSafe(filePath);

  const now = new Date();
  const dateStr = now.toISOString().replace(/T/, ' ').replace(/\.\d+Z/, ' UTC');
  const header = `## Current Sprint (updated ${dateStr})`;

  // Build sprint content
  const sprintLines = [header, ''];
  for (let i = 0; i < sprintItems.length; i++) {
    const item = sprintItems[i];
    sprintLines.push(`${i + 1}. **${item.id}: ${item.title}**`);
    if (item.description) {
      sprintLines.push(`   ${item.description}`);
    }
    if (item.acceptance) {
      sprintLines.push(`   - Acceptance: ${item.acceptance}`);
    }
    sprintLines.push('');
  }

  const sprintBlock = sprintLines.join('\n');

  // Check if ## Current Sprint already exists
  const sprintRegex = /^## Current Sprint[^\n]*\n/m;
  const match = sprintRegex.exec(content);

  if (match) {
    // Find the start of the section
    const sectionStart = match.index;
    // Find the next ## header (or EOF)
    const afterHeader = sectionStart + match[0].length;
    const nextHeaderMatch = content.slice(afterHeader).match(/^## /m);
    const sectionEnd = nextHeaderMatch
      ? afterHeader + nextHeaderMatch.index
      : content.length;

    // Replace the section
    content = content.slice(0, sectionStart) + sprintBlock + content.slice(sectionEnd);
  } else {
    // Append at end
    content = content.trimEnd() + '\n\n' + sprintBlock;
  }

  atomicWrite(filePath, content);
  log.info(TAG, 'current sprint updated', { projectPath, sprintItemCount: sprintItems.length });
}

// ── seedBacklogFromRoadmap ─────────────────────────────────────────────────

/**
 * Reads CLAUDE.md and finds ### Phase N ... sections.
 * Extracts bullet points as features and creates backlog items.
 * Writes BACKLOG.md and returns the items array.
 * @param {string} projectPath
 * @param {string} projectName
 * @param {string} prefix — e.g. 'NPH' for IDs like NPH-001
 * @returns {Array<object>}
 */
export function seedBacklogFromRoadmap(projectPath, projectName, prefix) {
  const filePath = path.join(projectPath, 'CLAUDE.md');
  const content = readFileSafe(filePath);
  if (!content) {
    log.warn(TAG, 'no CLAUDE.md found for roadmap seeding', { projectPath });
    return [];
  }

  const lines = content.split('\n');
  const items = [];
  let counter = 1;
  let currentPhase = null;
  let currentSection = '';
  let currentPriority = null;

  for (const line of lines) {
    // Detect phase headers: ### Phase 1 (Week 1-2): Core
    const phaseMatch = line.match(/^###\s+Phase\s+(\d+)\b[^:]*:\s*(.+)$/);
    if (phaseMatch) {
      const phaseNum = parseInt(phaseMatch[1], 10);
      const phaseName = phaseMatch[2].trim();
      currentPhase = phaseNum;
      currentSection = `Phase ${phaseNum}: ${phaseName}`;
      // Phase 1 = P1, Phase 2 = P2, Phase 3 = P3
      currentPriority = phaseNum <= 3 ? `P${phaseNum}` : `P3`;
      continue;
    }

    // Stop picking up bullets if we hit a new ## (non-phase section)
    if (/^## /.test(line) && currentPhase !== null) {
      // Only reset if it's not a ### sub-header inside the phases
      currentPhase = null;
      currentSection = '';
      currentPriority = null;
      continue;
    }

    // Pick up bullet points within a phase
    if (currentPhase !== null && /^- /.test(line)) {
      const title = line.replace(/^- /, '').trim();
      if (!title) continue;

      const id = `${prefix}-${String(counter).padStart(3, '0')}`;
      counter++;

      items.push({
        id,
        title,
        done: false,
        shipped: null,
        section: currentSection,
        priority: currentPriority,
        estimate: null,
        acceptance: null,
        blockedBy: null,
        source: null,
      });
    }
  }

  if (items.length > 0) {
    writeBacklog(projectPath, projectName, items);
    log.info(TAG, 'backlog seeded from roadmap', { projectPath, itemCount: items.length });
  } else {
    log.warn(TAG, 'no roadmap phases found in CLAUDE.md', { projectPath });
  }

  return items;
}

// ── PM_CYCLE_PROMPT ────────────────────────────────────────────────────────

/**
 * Prompt constant for the PM's nightly AI call.
 * Instructs Claude to process the backlog, mark completions, identify new work,
 * flag scope creep, select sprint items, and return structured JSON.
 */
export const PM_CYCLE_PROMPT = `You are a Project Manager for a software project. You have been given:

1. The current BACKLOG.md (parsed into structured items)
2. The latest Auditor daily digest (summarizing recent activity)
3. The git log for the last 24 hours
4. The current sprint size limit

Your job is to run the nightly PM cycle:

## Step 1: Mark completions
Review the git log and auditor digest. Identify backlog items that have been completed.
An item is "done" if the git log shows commits that clearly implement or fix it,
or the auditor digest confirms it was shipped.

## Step 2: Identify new work
From the auditor digest, identify any new bugs, recommendations, or feature requests
that should become backlog items. Assign appropriate IDs continuing from the highest
existing ID number. Set priority based on severity:
- P1: critical bugs, security issues, data loss risks
- P2: moderate bugs, important features
- P3: nice-to-haves, polish, minor improvements

## Step 3: Flag scope creep
If the auditor digest mentions work being done that is NOT in the backlog,
flag it as potential scope creep. This is informational — do not block it.

## Step 4: Select sprint items
From all undone, unblocked items, select up to the sprint size limit.
Prioritize by: P1 first, then P2, then P3. Within the same priority,
prefer items that unblock other items, then items with lower ID numbers.

## Step 5: Write report
Write a brief (3-5 sentence) report summarizing what happened and what's next.

## Output
Return valid JSON (no markdown fences):
{
  "completedIds": ["TST-001", ...],
  "newItems": [
    { "id": "TST-XXX", "title": "...", "section": "Bugs", "priority": "P1", "source": "audit YYYY-MM-DD", "acceptance": "..." }
  ],
  "scopeCreep": ["description of untracked work..."],
  "sprint": [
    { "id": "TST-002", "title": "...", "description": "brief plan for this sprint item", "acceptance": "..." }
  ],
  "report": "Brief summary of completions, new items, and sprint plan."
}`;
