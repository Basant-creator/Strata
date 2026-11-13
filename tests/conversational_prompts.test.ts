import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { buildPromptContext } from '../src/integrations/claude-hook.js';
import { extractTaskQuery } from '../src/integrations/task-query.js';

/**
 * Conversational prompts get no context pack.
 *
 * With the hook on in Strata's own repository, "record the key decisions first, then
 * commit and push" and "yes, add the docs-only commit fix" got packs resolved from
 * "commit", "push" and "yes", with CAUTION lines claiming the task "names push". A reply
 * to the agent or a workflow step asks nothing about the code.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-conv-'));
const repo = path.join(base, 'repo');
const saved = { ...process.env };
const git = (args: string[], date?: string): string => execFileSync('git', args, {
  cwd: repo, encoding: 'utf-8', env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
});
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, 'utf-8');
};

beforeAll(() => {
  const globalConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(globalConfig, '', 'utf-8');
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'core.autocrlf', 'false']);
  // Words a conversational prompt uses are also file and symbol names here, so a pack
  // built from them would resolve to something: the test shows none is built.
  write('src/git/push.ts', 'export function push(ref: string): string {\n  return ref;\n}\n');
  write('src/git/commit.ts', 'export function commit(message: string): string {\n  return message;\n}\n');
  write('src/notifications/push.ts', 'export const PUSH_NOTIFICATIONS = true;\n');
  write('src/records/record.ts', 'export function recordDecision(text: string): string {\n  const commit = text.trim();\n  return commit;\n}\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'push and commit helpers'], '2026-01-01T10:00:00Z');
  write('src/git/push.ts', 'export function push(ref: string, force = false): string {\n  return force ? `+${ref}` : ref;\n}\n');
  // A line naming `commit` that a later commit removed: a task naming "commit" here
  // collides with it, and the pack cautions that the task names commit.
  write('src/records/record.ts', 'export function recordDecision(text: string): string {\n  return text;\n}\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'push can force'], '2026-01-02T10:00:00Z');
  const svc = new StrataService(repo);
  svc.init();
  svc.indexCode();
  svc.close();
}, 120_000);

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(base, { recursive: true, force: true });
});

afterEach(() => vi.restoreAllMocks());

const CONVERSATIONAL = [
  'commit and push',
  'push',
  'yes',
  'yes, go ahead',
  'looks good, commit and push',
  'ok thanks, continue',
  'run the tests again',
  'Sounds right. Proceed.',
  'yes please, rebase and push',
];

describe('a prompt that is only conversation', () => {
  it('is recognised as conversation', () => {
    for (const p of CONVERSATIONAL) expect(extractTaskQuery(p).conversational, p).toBe(true);
  });

  it('gets no context, and nothing is refreshed or built for it', () => {
    const pack = vi.spyOn(StrataService.prototype, 'getContextPack');
    const index = vi.spyOn(StrataService.prototype, 'indexCode');
    for (const prompt of CONVERSATIONAL) {
      const r = buildPromptContext({ prompt, cwd: repo });
      expect([prompt, r.decision, r.output]).toEqual([prompt, 'skipped-conversational', null]);
    }
    expect(pack).not.toHaveBeenCalled();
    expect(index).not.toHaveBeenCalled();
  });
});

describe('what is never mistaken for conversation', () => {
  it('a question about the code, even one that uses workflow words', () => {
    for (const p of [
      'Why does push fail when the ref is protected?',
      'push notifications are not delivered on Android',
      'the commit message parser drops trailers',
      'fix the CORS origins',
      'record the key decisions first',
    ]) {
      expect(extractTaskQuery(p).conversational, p).toBe(false);
    }
  });

  it('a prompt that names something outright', () => {
    for (const p of ['`push`', 'src/git/push.ts', 'yes, and check recordDecision', 'commit src/git/commit.ts']) {
      expect(extractTaskQuery(p).conversational, p).toBe(false);
    }
  });

  it('exchange words alone keep their old behaviour', () => {
    expect(extractTaskQuery('Answer only; do not edit files.')).toEqual({
      query: 'Answer only; do not edit files.', removed: [], conversational: false,
    });
  });

  it('a real question is delivered as before', () => {
    const r = buildPromptContext({ prompt: 'Why can src/git/push.ts force a ref?', cwd: repo });
    expect(r.decision).toBe('delivered');
    expect(r.targets).toEqual(['src/git/push.ts']);
  });
});

describe('a prompt that mixes a question and a workflow step', () => {
  it('keeps the question and drops the step', () => {
    // Removal is by the resolver's clauses, which split on "and": the step leaves as two.
    expect(extractTaskQuery('record the key decisions first, then commit and push')).toEqual({
      query: 'record the key decisions first', removed: ['then commit', 'push'], conversational: false,
    });
    expect(extractTaskQuery('yes, explain why push can force a ref')).toMatchObject({
      removed: ['yes'], conversational: false,
    });
  });

  it('the pack no longer cautions about the workflow words', () => {
    // The question names neither word, so a caution about either could only come from the step.
    const r = buildPromptContext({ prompt: 'Why does src/records/record.ts return its input? Then commit and push.', cwd: repo });
    expect(r.decision).toBe('delivered');
    expect(r.removed).toEqual(['Then commit', 'push.']);
    expect(r.query).not.toMatch(/commit and push/);
    expect(r.output!.hookSpecificOutput.additionalContext).not.toMatch(/names (commit|push)\b/);
  });
});

describe('a workflow step at the edge of a clause that also asks something', () => {
  it('an imperative workflow verb is cut from the start, and the rest kept as typed', () => {
    expect(extractTaskQuery('commit the fix to task-query')).toEqual({
      query: 'the fix to task-query', removed: ['commit'], conversational: false,
    });
    expect(extractTaskQuery('go ahead and commit the record')).toEqual({
      query: 'the record', removed: ['go ahead', 'commit'], conversational: false,
    });
    expect(extractTaskQuery('Please review the `task-query` changes')).toEqual({
      query: 'the `task-query` changes', removed: ['Please review'], conversational: false,
    });
  });

  it('a trailing "again" and a step tied on with before or after are cut from the end', () => {
    expect(extractTaskQuery('run the tests for task-query again')).toEqual({
      query: 'the tests for task-query', removed: ['run', 'again'], conversational: false,
    });
    expect(extractTaskQuery('review the hook changes before pushing')).toEqual({
      query: 'the hook changes', removed: ['review', 'before pushing'], conversational: false,
    });
    expect(extractTaskQuery('explain the caution logic after you commit it')).toEqual({
      query: 'explain the caution logic', removed: ['after you commit it'], conversational: false,
    });
  });

  it('steering words the resolver would score are cut from the start', () => {
    expect(extractTaskQuery('now explain why push can force a ref')).toEqual({
      query: 'explain why push can force a ref', removed: ['now'], conversational: false,
    });
  });

  it('a step whose object is only the pending work is conversation', () => {
    for (const p of ['commit the changes', 'push these updates', 'go ahead and commit your edits', 'yes, commit all the changes']) {
      expect(extractTaskQuery(p).conversational, p).toBe(true);
    }
  });

  it('the same word used as a noun is never cut', () => {
    for (const p of [
      'commit cache misses commits made after init',
      'push notifications fail on Android',
      'test runner hangs on Windows',
      'review queue drops items',
      'run loop exits early',
    ]) {
      expect(extractTaskQuery(p), p).toEqual({ query: p, removed: [], conversational: false });
    }
  });

  it('nothing is cut from the middle, and nothing the resolver ignores is cut alone', () => {
    for (const p of [
      'why does the commit message parser drop trailers',
      'make the hook commit the record before it pushes',
      'which method does the engine use now?',
      'then explain the caution logic',
    ]) {
      expect(extractTaskQuery(p), p).toEqual({ query: p, removed: [], conversational: false });
    }
  });

  it('the pack no longer cautions that the task names the workflow verb', () => {
    const r = buildPromptContext({ prompt: 'commit the recordDecision helper in src/records/record.ts', cwd: repo });
    expect(r.decision).toBe('delivered');
    expect(r.removed).toEqual(['commit']);
    expect(r.targets).toEqual(['src/records/record.ts']);
    expect(r.output!.hookSpecificOutput.additionalContext).not.toMatch(/names commit\b/);
  });
});

/*
  Prompts measured in Strata's own sessions, 2026-11-11 to 2026-11-13, where most packs the
  hook delivered were about files the prompt never meant. What the filter can tell apart by
  its closed lists is fixed here; what it cannot is held open on purpose:

  - "what's the current status of strata now?" and "Fix the indexer" reach the resolver in
    the same shape (a word that is a file name, status.ts or indexer.ts, plus wording), so no
    word list separates them without growing into the brittle lists these words keep out.
  - A commit whose object is a bare noun ("Commit docs and push") keeps "Commit docs": a verb
    is cut only before a determiner or pronoun, so "commit cache" stays whole (REC-14).
  - A LOW pack is still delivered.
*/
describe('prompts measured in the 2026-11 sessions', () => {
  it('a bare refusal or deferral is conversation, like "Not now"', () => {
    for (const p of ['Not yet', 'not now', 'no, not yet', 'Not yet, thanks']) {
      expect(extractTaskQuery(p).conversational, p).toBe(true);
    }
    const r = buildPromptContext({ prompt: 'Not yet', cwd: repo });
    expect([r.decision, r.output]).toEqual(['skipped-conversational', null]);
  });

  it('"yet" inside a question keeps the question whole', () => {
    for (const p of ['why is push not forced yet?', 'the yet-unindexed files are skipped', 'Not yet: why does push drop the ref?']) {
      expect(extractTaskQuery(p).conversational, p).toBe(false);
    }
    expect(extractTaskQuery('why is push not forced yet?').query).toBe('why is push not forced yet?');
  });

  it('a commit step alone is conversation; a commit with an object keeps the object', () => {
    for (const p of ['commit and push', 'commit the changes', 'Commit it', 'yes, commit and push them']) {
      expect(extractTaskQuery(p).conversational, p).toBe(true);
    }
    expect(extractTaskQuery('Commit the indexer fix')).toMatchObject({ query: 'the indexer fix', conversational: false });
    expect(extractTaskQuery('Commit docs and push')).toMatchObject({ query: 'Commit docs', conversational: false });
  });

  it('a status question about something in the code is delivered', () => {
    const r = buildPromptContext({ prompt: 'what is the status of the push force flag?', cwd: repo });
    expect(r.decision).toBe('delivered');
    expect(r.targets).toContain('src/git/push.ts');
  });

  it('coding tasks, history questions and short technical prompts are never conversation', () => {
    for (const p of [
      'Fix the indexer', 'make push refuse a protected ref', 'the budget drops the top-ranked commit, fix it',
      'why was force added to push?', 'Check REC-5', 'why were record files kept out of the word index?',
      'Allow agy flag', 'trimWorkflowEdges', 'src/git/push.ts',
    ]) {
      expect(extractTaskQuery(p).conversational, p).toBe(false);
    }
  });

  it('an ambiguous prompt is left to the resolver, not filtered', () => {
    for (const p of ['what about the docs?', 'is the hook slow?', 'Start Part C', 'Add a dated note', 'Stop and record it']) {
      expect(extractTaskQuery(p), p).toEqual({ query: p, removed: [], conversational: false });
    }
  });
});
