import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { buildPromptContext } from '../src/integrations/claude-hook.js';
import {
  antigravityRule, ensureGitignore, installPostCommitHook, parseEditor, postCommitBlock, setupAntigravity,
  setupClaudeCode,
} from '../src/integrations/setup.js';

/**
 * The readable docs layer (docs/strata/DECISIONS.md, FLOW.md) and `strata setup`.
 *
 * Every repository is a fresh temporary one outside the Strata tree, with Git's global and
 * system configuration replaced, so nothing reads or writes the user's own.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-docs-'));
const saved = { ...process.env };
const git = (cwd: string, args: string[], date?: string): string => execFileSync('git', args, {
  cwd, encoding: 'utf-8', env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
});
const write = (root: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text, 'utf-8');
};
const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');
const freshRepo = (name: string): string => {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
  git(dir, ['config', 'user.name', 'Fixture']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
};
const commit = (dir: string, msg: string, date: string): string => {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg], date);
  return git(dir, ['rev-parse', 'HEAD']).trim();
};

let repo: string;
let svc: StrataService;
const sha: Record<string, string> = {};

beforeAll(() => {
  const globalConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(globalConfig, '', 'utf-8');
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';

  repo = freshRepo('project');
  write(repo, 'package.json', '{\n  "name": "demo",\n  "dependencies": { "express": "^4" }\n}\n');
  write(repo, 'src/webhooks/handler.ts', 'export function handleWebhook(id: string): boolean {\n  return id.length > 0;\n}\n');
  sha['A'] = commit(repo, 'Start the webhook service', '2026-03-01T10:00:00Z');
  write(repo, 'src/billing/charge.ts', "import { handleWebhook } from '../webhooks/handler';\nexport const charge = (id: string) => handleWebhook(id);\n");
  sha['B'] = commit(repo, 'Add billing on top of webhooks', '2026-04-10T10:00:00Z');
  write(repo, 'src/webhooks/handler.ts', 'const seen = new Set<string>();\nexport function handleWebhook(id: string): boolean {\n  if (seen.has(id)) return false;\n  seen.add(id);\n  return true;\n}\n');
  sha['C'] = commit(repo, 'Ignore duplicate webhook deliveries', '2026-05-20T10:00:00Z');

  svc = new StrataService(repo);
  svc.init();
  svc.indexCode();
  const record = (input: Record<string, unknown>): void => {
    svc.recordChange({ result: { status: 'success' }, ...input } as Parameters<StrataService['recordChange']>[0]);
  };
  record({
    id: 'REC-1', title: 'Make webhook handling idempotent', intent: 'Retried deliveries are processed once.',
    files: [{ path: 'src/webhooks/handler.ts', changeType: 'modify' }],
    attempts: [{ approach: 'Database row lock', status: 'failed', failureReason: 'too slow under load' },
               { approach: 'In-memory seen set', status: 'succeeded' }],
    constraints: [{ statement: 'handleWebhook must stay idempotent', status: 'ACTIVE' }],
    reasons: [{ statement: 'Providers retry on timeouts' }],
  });
  // Contradicted: commit A did not touch charge.ts (it did not exist yet).
  record({ id: 'REC-2', title: 'Billing reuses webhook validation',
           intent: `src/billing/charge.ts was rewritten in ${sha['A']!.slice(0, 7)} to call handleWebhook.`,
           files: [{ path: 'src/billing/charge.ts', changeType: 'add' }] });
  record({ id: 'REC-3', title: 'Old billing note', intent: 'Billing used to round to cents.', status: 'SUPERSEDED',
           supersededBy: 'REC-2', files: [{ path: 'src/billing/charge.ts', changeType: 'modify' }] });
  record({ id: 'REC-4', title: 'Package manifest pins express', intent: 'express stays on major 4.',
           files: [{ path: 'package.json', changeType: 'modify' }] });
  // After REC-4 was recorded (now), a commit dated later changes its file: OUT OF DATE.
  write(repo, 'package.json', '{\n  "name": "demo",\n  "dependencies": { "express": "^5" }\n}\n');
  sha['D'] = commit(repo, 'Move to express 5', '2031-01-01T10:00:00Z');
  svc.indexCode();
}, 120_000);

afterAll(() => {
  svc?.close();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(base, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the docs

describe('docs/strata/DECISIONS.md', () => {
  let text: string;
  beforeAll(() => {
    svc.writeDocs();
    text = read(repo, 'docs/strata/DECISIONS.md');
  });

  it('lists every decision with a status git decides', () => {
    expect(text).toContain('| REC-1 | Make webhook handling idempotent | CURRENT |');
    expect(text).toContain('| REC-2 | Billing reuses webhook validation | CONTRADICTED BY GIT |');
    expect(text).toContain('| REC-3 | Old billing note | SUPERSEDED |');
    expect(text).toContain('| REC-4 | Package manifest pins express | OUT OF DATE |');
  });

  it('says what was decided, why, what failed and the rules, each with its label', () => {
    expect(text).toContain('- **Decided** (DECLARED): Retried deliveries are processed once.');
    expect(text).toContain('- **Why** (DECLARED): Providers retry on timeouts');
    expect(text).toContain('- **Tried, failed** (DECLARED): Database row lock — too slow under load');
    expect(text).toContain('- **Chosen** (DECLARED): In-memory seen set');
    expect(text).toContain('- **Rule to keep** [ACTIVE] (DECLARED): handleWebhook must stay idempotent');
  });

  it('shows the evidence for each status, as VERIFIED git facts', () => {
    expect(text).toContain(`- **Contradicted by git** (VERIFIED): the record names ${sha['A']!.slice(0, 7)} with src/billing/charge.ts;`);
    expect(text).toContain(`- **Changed since** (VERIFIED): ${sha['D']!.slice(0, 7)} (2031-01-01)`);
    expect(text).toContain('- **Status:** SUPERSEDED (by REC-2)');
    // The HEAD attached at save time is when it was recorded, not a citation.
    expect(text).toMatch(/- \*\*Recorded at commit\*\* \(VERIFIED\): [0-9a-f]{7}/);
    expect(text).not.toContain('Commits cited');
  });

  it('is deterministic and rewrites nothing that did not change', () => {
    const again = svc.writeDocs();
    expect(again).toEqual({ written: [], unchanged: ['docs/strata/DECISIONS.md', 'docs/strata/FLOW.md'] });
    expect(read(repo, 'docs/strata/DECISIONS.md')).toBe(text);
    expect(text).not.toContain(repo.replace(/\\/g, '/'));
  });

  it('with no records, says so and how to add one', () => {
    const empty = freshRepo('empty');
    write(empty, 'src/a.ts', 'export const A = 1;\n');
    commit(empty, 'first', '2026-01-01T00:00:00Z');
    const s = new StrataService(empty);
    try {
      s.init();
      s.indexCode();
      s.writeDocs();
    } finally {
      s.close();
    }
    const t = read(empty, 'docs/strata/DECISIONS.md');
    expect(t).toContain('## No decisions recorded yet');
    expect(t).toContain('strata record --intent');
  });
});

describe('docs/strata/FLOW.md', () => {
  let text: string;
  beforeAll(() => {
    svc.writeDocs();
    text = read(repo, 'docs/strata/FLOW.md');
  });

  it('tells the history from the first commit to the latest, in stages', () => {
    expect(text).toContain(`- **Started:** 2026-03-01 with \`${sha['A']!.slice(0, 7)}\` "Start the webhook service"`);
    expect(text).toContain(`- **Latest:** 2031-01-01 with \`${sha['D']!.slice(0, 7)}\` "Move to express 5"`);
    // A history longer than two months is grouped by month.
    expect(text).toMatch(/### 2026-03 — 1 commit\(s\)/);
    expect(text).toMatch(/### 2026-05 — 1 commit\(s\)/);
    expect(text).toContain(`- \`${sha['B']!.slice(0, 7)}\` 2026-04-10 — Add billing on top of webhooks`);
  });

  it('draws the blueprint from the index: modules, connections, hot spots, packages', () => {
    expect(text).toContain('| `src/webhooks/` | 1 | 1 | typescript |');
    expect(text).toContain('| `src/billing/` | 1 | 1 | typescript |');
    expect(text).toContain('- `src/billing/` → `src/webhooks/` (1 import(s))');
    expect(text).toContain('- `src/webhooks/handler.ts` — imported 1 time(s)');
    expect(text).toContain('- `src/webhooks/handler.ts` — 2 commit(s)');
    expect(text).toContain('`express`');
  });
});

describe('keeping the docs current', () => {
  it('does nothing in a repository without docs/strata/', () => {
    const other = freshRepo('nodocs');
    write(other, 'src/a.ts', 'export const A = 1;\n');
    commit(other, 'first', '2026-01-01T00:00:00Z');
    const s = new StrataService(other);
    try {
      s.init();
      s.recordChange({ id: 'REC-1', title: 't', intent: 'i', files: [{ path: 'src/a.ts', changeType: 'modify' }],
                       result: { status: 'success' } } as Parameters<StrataService['recordChange']>[0]);
      expect(s.refreshDocsIfPresent()).toBeNull();
    } finally {
      s.close();
    }
    expect(fs.existsSync(path.join(other, 'docs'))).toBe(false);
  });

  it('a new record rewrites DECISIONS.md on its own; nothing changed means nothing written', () => {
    svc.writeDocs();
    expect(svc.refreshDocsIfPresent()).toBeNull();
    svc.recordChange({ id: 'REC-5', title: 'Charge in cents', intent: 'Amounts are integers in cents.',
                       files: [{ path: 'src/billing/charge.ts', changeType: 'modify' }],
                       result: { status: 'success' } } as Parameters<StrataService['recordChange']>[0]);
    expect(read(repo, 'docs/strata/DECISIONS.md')).toContain('| REC-5 | Charge in cents | CURRENT |');
    expect(svc.refreshDocsIfPresent()).toBeNull();
  });

  it('the prompt hook brings them up to date after a commit, and the pack is unaffected', () => {
    svc.writeDocs();
    write(repo, 'src/webhooks/retry.ts', 'export const RETRIES = 3;\n');
    commit(repo, 'Add a retry limit', '2031-02-01T10:00:00Z');
    const r = buildPromptContext({ prompt: 'Why does src/webhooks/handler.ts keep ids?', cwd: repo });
    expect(r.decision).toBe('delivered');
    expect(r.refresh?.docsWritten).toEqual(expect.arrayContaining(['docs/strata/FLOW.md']));
    expect(read(repo, 'docs/strata/FLOW.md')).toContain('Add a retry limit');
  });

  it('committing the refreshed docs settles them: a docs-only commit changes nothing they say', () => {
    svc.writeDocs();
    const flow = read(repo, 'docs/strata/FLOW.md');
    const decisions = read(repo, 'docs/strata/DECISIONS.md');
    git(repo, ['add', 'docs/strata']);
    git(repo, ['commit', '-q', '-m', 'Refresh Strata docs'], '2031-03-01T10:00:00Z');
    expect(svc.writeDocs()).toEqual({ written: [], unchanged: ['docs/strata/DECISIONS.md', 'docs/strata/FLOW.md'] });
    expect(read(repo, 'docs/strata/FLOW.md')).toBe(flow);
    expect(read(repo, 'docs/strata/DECISIONS.md')).toBe(decisions);
    expect(flow).not.toContain('Refresh Strata docs');
    expect(git(repo, ['status', '--porcelain', '--', 'docs/strata'])).toBe('');
  });

  it('a commit that touches the docs and anything else is still history', () => {
    svc.writeDocs();
    write(repo, 'src/webhooks/limits.ts', 'export const MAX = 10;\n');
    write(repo, 'docs/strata/NOTE.md', 'not generated\n');
    const mixed = commit(repo, 'Add limits with a note', '2031-04-01T10:00:00Z');
    svc.writeDocs();
    const flow = read(repo, 'docs/strata/FLOW.md');
    expect(flow).toContain('Add limits with a note');
    expect(flow).toContain(`As of commit \`${mixed.slice(0, 7)}\``);
  });
});

// ------------------------------------------------------------------ strata setup

describe('strata setup', () => {
  it('knows the editors by name and alias', () => {
    expect(['claude-code', 'claude', 'antigravity', 'agy', 'Gemini'].map(parseEditor))
      .toEqual(['claude-code', 'claude-code', 'antigravity', 'antigravity', 'antigravity']);
    expect(parseEditor('vim')).toBeNull();
  });

  it('Claude Code: adds the prompt hook, keeps every existing setting, and is idempotent', () => {
    const dir = freshRepo('claude');
    write(dir, '.claude/settings.json', JSON.stringify({
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] },
    }));
    expect(setupClaudeCode(dir, 'strata').outcome).toBe('updated');
    const s = JSON.parse(read(dir, '.claude/settings.json'));
    expect(s.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: 'strata hook user-prompt-submit' }] }]);
    const before = read(dir, '.claude/settings.json');
    expect(setupClaudeCode(dir, 'strata').outcome).toBe('unchanged');
    expect(read(dir, '.claude/settings.json')).toBe(before);
  });

  it('Claude Code: a settings file that is not valid JSON is reported and left untouched', () => {
    const dir = freshRepo('claude-broken');
    write(dir, '.claude/settings.json', '{ "hooks": ');
    const step = setupClaudeCode(dir, 'strata');
    expect(step.outcome).toBe('skipped');
    expect(read(dir, '.claude/settings.json')).toBe('{ "hooks": ');
  });

  it('Antigravity: an always-on workspace rule pointing at the docs and strata context', () => {
    const dir = freshRepo('agy');
    expect(setupAntigravity(dir, 'strata').outcome).toBe('created');
    const rule = read(dir, '.agents/rules/strata.md');
    expect(rule.split('\n').slice(0, 4)).toEqual([
      '---', 'trigger: always_on',
      'description: Use this project\'s Strata memory (decisions, history, rules) before changing code.', '---',
    ]);
    expect(rule).toContain('docs/strata/DECISIONS.md');
    expect(rule).toContain('`strata context "<your task>"`');
    expect(setupAntigravity(dir, 'strata').outcome).toBe('unchanged');
    // A different command rewrites the managed file.
    expect(setupAntigravity(dir, 'node "/x/cli/index.js"').outcome).toBe('updated');
    expect(read(dir, '.agents/rules/strata.md')).toBe(antigravityRule('node "/x/cli/index.js"'));
  });

  it('Antigravity: a rule file Strata did not write is left untouched', () => {
    const dir = freshRepo('agy-foreign');
    write(dir, '.agents/rules/strata.md', '---\ntrigger: manual\n---\nmine\n');
    expect(setupAntigravity(dir, 'strata').outcome).toBe('skipped');
    expect(read(dir, '.agents/rules/strata.md')).toBe('---\ntrigger: manual\n---\nmine\n');
  });

  it('post-commit hook: created, kept idempotent, and added beside an existing hook without changing it', () => {
    const dir = freshRepo('hook');
    expect(installPostCommitHook(dir, 'strata').outcome).toBe('created');
    const hook = read(dir, '.git/hooks/post-commit');
    expect(hook).toBe(`#!/bin/sh\n${postCommitBlock('strata')}\n`);
    expect(installPostCommitHook(dir, 'strata').outcome).toBe('unchanged');

    const other = freshRepo('hook-existing');
    write(other, '.git/hooks/post-commit', '#!/bin/sh\necho "mine"\n');
    expect(installPostCommitHook(other, 'strata').outcome).toBe('updated');
    const merged = read(other, '.git/hooks/post-commit');
    expect(merged.startsWith('#!/bin/sh\necho "mine"\n')).toBe(true);
    expect(merged).toContain(postCommitBlock('strata'));
    // A changed command replaces the managed block only.
    expect(installPostCommitHook(other, 'node "/x.js"').outcome).toBe('updated');
    expect(read(other, '.git/hooks/post-commit')).toBe(`#!/bin/sh\necho "mine"\n\n${postCommitBlock('node "/x.js"')}\n`);
  });

  it('post-commit hook: a failing Strata never fails the commit', () => {
    const dir = freshRepo('hook-fail');
    installPostCommitHook(dir, 'definitely-not-a-strata-command-xyz');
    write(dir, 'a.ts', 'export const A = 1;\n');
    expect(() => commit(dir, 'still commits', '2026-01-01T00:00:00Z')).not.toThrow();
  });

  it('post-commit hook: a hooks directory inside the project (core.hooksPath) is not edited', () => {
    const dir = freshRepo('hook-path');
    git(dir, ['config', 'core.hooksPath', '.husky']);
    const step = installPostCommitHook(dir, 'strata');
    expect(step.outcome).toBe('skipped');
    expect(step.note).toContain(postCommitBlock('strata'));
    expect(fs.existsSync(path.join(dir, '.husky', 'post-commit'))).toBe(false);
  });

  it('.gitignore: adds the local cache once, and respects a rule that already covers it', () => {
    const dir = freshRepo('ignore');
    write(dir, '.gitignore', 'node_modules/');
    expect(ensureGitignore(dir).outcome).toBe('updated');
    const text = read(dir, '.gitignore');
    expect(text.startsWith('node_modules/\n')).toBe(true);
    expect(text).toContain('.strata/strata.db*\n.strata/docs-state.json\n');
    expect(ensureGitignore(dir).outcome).toBe('unchanged');

    const covered = freshRepo('ignore-covered');
    write(covered, '.gitignore', '.strata/\n');
    expect(ensureGitignore(covered).outcome).toBe('unchanged');
  });
});
