import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Command } from 'commander';
import { StrataService } from '../src/records/service.js';
import { StrataMCPHandler } from '../src/mcp/server.js';
import { StrataDatabase } from '../src/storage/db.js';
import { StrataRepository } from '../src/storage/repository.js';
import { parseRecordMarkdown } from '../src/records/markdown.js';
import { deriveRecord } from '../src/derive/derive.js';
import { registerDeriveCommand } from '../src/cli/commands/derive.js';

/**
 * The automatic memory loop.
 *
 *   agent work → transcript → strata derive → development memory → persisted record
 *   → later context (agent pack and human view)
 *
 * One synthetic repository and one synthetic transcript of a session in it, holding every
 * element the loop has to carry. The session changes src/rate/limiter.ts five times:
 *
 *   attempt 1  count requests in a window            → tests fail        → FAILED
 *   attempt 2  replace it with a sliding window      → tsc ok, tests fail → PARTIAL
 *   attempt 3  fix the comparison                    → all checks pass   → SUCCEEDED
 *              (the session commits this: a real commit in the fixture)
 *   attempt 4  experiment on window.ts, then `git checkout --` it       → ABANDONED
 *   attempt 5  write a new config file, nothing checked after it       → UNKNOWN
 *
 * Attempt 2 edits lines attempt 1 introduced, attempt 3 edits lines attempt 2 introduced:
 * replacements, which must not change either one's own result. The transcript states one
 * reason explicitly, one constraint in the task prompt and one by the agent, and one
 * consequence; it also *implies* a reason ("switching to a sliding window" right after a
 * failure) that must stay UNKNOWN, and a thinking block says "because", which must never be
 * read. A probe script written and deleted in one command is scratch, not a change.
 *
 * A second, shorter transcript changes src/rate/metrics.ts and states no reason at all.
 */

const repoDir = path.join(process.cwd(), '.test_repo_memory_loop');
const transcriptDir = path.join(process.cwd(), '.test_transcripts_memory_loop');
const T1 = 'session-limiter.jsonl';
const T2 = 'session-metrics.jsonl';
let service: StrataService;
let committedHash = '';
let raw1 = '';
let raw2 = '';

const git = (args: string[], date?: string): string => execFileSync('git', args, {
  cwd: repoDir, encoding: 'utf-8',
  env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
});
const write = (rel: string, lines: string[]): void => {
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, lines.join('\n') + '\n', 'utf-8');
};

// ------------------------------------------------------------------ transcript helpers

let clock = Date.parse('2026-02-02T10:00:00Z');
const stamp = (): string => new Date((clock += 2000)).toISOString();
const stream = (...envelopes: unknown[]): string => envelopes.map((e) => JSON.stringify(e)).join('\n');
const init = (sessionId: string) => ({ type: 'system', subtype: 'init', session_id: sessionId, cwd: repoDir, model: 'claude-opus-5' });
const prompt = (text: string) => ({ type: 'user', timestamp: stamp(), message: { content: [{ type: 'text', text }] } });
const say = (text: string) => ({ type: 'assistant', timestamp: stamp(), message: { content: [{ type: 'text', text }] } });
const think = (thinking: string) => ({ type: 'assistant', timestamp: stamp(), message: { content: [{ type: 'thinking', thinking }] } });
const use = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: 'assistant', timestamp: stamp(), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: string, isError = false) =>
  ({ type: 'user', timestamp: stamp(), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } });
const done = () => ({ type: 'result', subtype: 'success', num_turns: 30, duration_ms: 90_000 });

/** The repository as a shell in the session would spell it: forward slashes. */
const shellDir = (): string => repoDir.replace(/\\/g, '/');

const REASON = 'The current check only looks at the last request, so I\'ll count requests inside a one-second window instead.';
const IMPLIED = 'The count was off by one; switching to a sliding window.';
const CONSEQUENCE = 'This means a burst above the limit is rejected immediately instead of waiting for the next request.';
const AGENT_CONSTRAINT = 'The window length has to stay configurable per route.';
const PROMPT_CONSTRAINT = 'The public `allow()` signature must not change.';

function limiterTranscript(): string {
  const limiter = path.join(repoDir, 'src', 'rate', 'limiter.ts');
  return stream(
    init('syn-limiter-1'),
    prompt(`Make the rate limiter reject bursts over the configured limit. ${PROMPT_CONSTRAINT}`),
    say('Reading the limiter first.'),
    use('r1', 'Read', { file_path: limiter }),
    result('r1', 'export function allow(events, now, limit) { ... }'),
    think('I am doing this because the reviewer is picky about naming.'),
    say(REASON),
    // attempt 1
    use('e1', 'Edit', {
      file_path: limiter,
      old_string: '  const last = events[events.length - 1];\n  return !last || now - last.at > 1000 / limit;',
      new_string: '  return countInWindow(events, now) < limit;\n}\n\nfunction countInWindow(events: RateEvent[], now: number): number {\n  return events.filter((e) => now - e.at < 1000).length;',
    }),
    result('e1', 'The file has been updated successfully.'),
    use('b1', 'Bash', { command: `cd "${shellDir()}" && npm test`, description: 'Run the tests' }),
    result('b1', 'FAIL tests/limiter.test.ts > allows the first request\n Tests  1 failed | 4 passed (5)'),
    say(IMPLIED),
    // attempt 2 — edits the line attempt 1 introduced
    use('e2', 'Edit', {
      file_path: limiter,
      old_string: '  return countInWindow(events, now) < limit;',
      new_string: '  return slidingWindowCount(events, now, WINDOW_MS) < limit;\n}\n\nexport function slidingWindowCount(events: RateEvent[], now: number, windowMs: number): number {\n  return events.filter((e) => now - e.at < windowMs).length;',
    }),
    result('e2', 'The file has been updated successfully.'),
    use('b2', 'Bash', { command: `cd "${shellDir()}" && npx tsc --noEmit && echo TYPECHECK OK`, description: 'Typecheck' }),
    result('b2', 'TYPECHECK OK'),
    use('b3', 'Bash', { command: `cd "${shellDir()}" && npm test`, description: 'Run the tests' }),
    result('b3', 'FAIL tests/limiter.test.ts > rejects the burst\n Tests  2 failed | 3 passed (5)'),
    // attempt 3 — edits the line attempt 2 introduced
    use('e3', 'Edit', {
      file_path: limiter,
      old_string: '  return slidingWindowCount(events, now, WINDOW_MS) < limit;',
      new_string: '  return slidingWindowCount(events, now, WINDOW_MS) <= limit - 1;',
    }),
    result('e3', 'The file has been updated successfully.'),
    use('b4', 'Bash', { command: `cd "${shellDir()}" && npx tsc --noEmit && echo TYPECHECK OK`, description: 'Typecheck' }),
    result('b4', 'TYPECHECK OK'),
    use('b5', 'Bash', { command: `cd "${shellDir()}" && npm test`, description: 'Run the tests' }),
    result('b5', ' Tests  5 passed (5)'),
    // A probe written and deleted in one command: scratch, and a check.
    use('b6', 'Bash', {
      command: `cd "${shellDir()}" && cat > probe.ts <<'EOF'\nimport { allow } from './src/rate/limiter';\nconsole.log(allow([], 0, 1));\nEOF\nnpx ts-node probe.ts && rm probe.ts`,
      description: 'Smoke test the limiter',
    }),
    result('b6', 'true'),
    say(`Tests pass now. ${CONSEQUENCE} ${AGENT_CONSTRAINT}`),
    use('b7', 'Bash', { command: `cd "${shellDir()}" && git diff`, description: 'Review the diff' }),
    result('b7', 'diff --git a/src/rate/limiter.ts b/src/rate/limiter.ts\n--- a/src/rate/limiter.ts\n+++ b/src/rate/limiter.ts\n@@ -3,4 +3,8 @@\n-  const last = events[events.length - 1];\n-  return !last || now - last.at > 1000 / limit;\n+  return slidingWindowCount(events, now, WINDOW_MS) <= limit - 1;\n+}\n+export function slidingWindowCount(events: RateEvent[], now: number, windowMs: number): number {'),
    use('b8', 'Bash', { command: `cd "${shellDir()}" && git status --porcelain`, description: 'Working tree state' }),
    result('b8', ' M src/rate/limiter.ts\n?? .strata/'),
    use('b9', 'Bash', { command: `cd "${shellDir()}" && git commit -am "Count requests in a sliding window"`, description: 'Commit' }),
    result('b9', `[main ${committedHash.slice(0, 7)}] Count requests in a sliding window\n 1 file changed, 6 insertions(+), 2 deletions(-)`),
    // attempt 4 — an experiment, restored from git
    use('e4', 'Edit', {
      file_path: path.join(repoDir, 'src', 'rate', 'window.ts'),
      old_string: 'export const WINDOW_MS = 1000;',
      new_string: '// experimental: halve the window\nexport const WINDOW_MS = 1000;',
    }),
    result('e4', 'The file has been updated successfully.'),
    use('b10', 'Bash', { command: `cd "${shellDir()}" && git checkout -- src/rate/window.ts`, description: 'Undo the experiment' }),
    result('b10', ''),
    // attempt 5 — nothing is checked after it
    use('w1', 'Write', {
      file_path: path.join(repoDir, 'src', 'rate', 'config.ts'),
      content: 'export const RATE_CONFIG = { perRoute: true };\n',
    }),
    result('w1', 'File created successfully at: src/rate/config.ts'),
    done(),
  );
}

function metricsTranscript(): string {
  return stream(
    init('syn-metrics-1'),
    prompt('Tidy the metrics helper.'),
    use('m1', 'Edit', {
      file_path: path.join(repoDir, 'src', 'rate', 'metrics.ts'),
      old_string: 'export function requestCount(n: number): number {',
      new_string: 'export function requestCount(total: number): number {',
    }),
    result('m1', 'The file has been updated successfully.'),
    use('m2', 'Bash', { command: `cd "${shellDir()}" && npm test`, description: 'Run the tests' }),
    result('m2', ' Tests  5 passed (5)'),
    say('Renamed the parameter. Tests pass now.'),
    done(),
  );
}

// ------------------------------------------------------------------ fixture

beforeAll(() => {
  for (const d of [repoDir, transcriptDir]) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(transcriptDir, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Fixture Author']);

  write('src/rate/window.ts', ['export const WINDOW_MS = 1000;']);
  write('src/rate/metrics.ts', ['export function requestCount(total: number): number {', '  return total;', '}']);
  write('src/rate/limiter.ts', [
    'export interface RateEvent { at: number }',
    '',
    'export function allow(events: RateEvent[], now: number, limit: number): boolean {',
    '  const last = events[events.length - 1];',
    '  return !last || now - last.at > 1000 / limit;',
    '}',
  ]);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'first limiter'], '2026-02-01T10:00:00Z');

  // The state the session committed, so its commit is a real one in this repository.
  write('src/rate/limiter.ts', [
    "import { WINDOW_MS } from './window';",
    '',
    'export interface RateEvent { at: number }',
    '',
    'export function allow(events: RateEvent[], now: number, limit: number): boolean {',
    '  return slidingWindowCount(events, now, WINDOW_MS) <= limit - 1;',
    '}',
    '',
    'export function slidingWindowCount(events: RateEvent[], now: number, windowMs: number): number {',
    '  return events.filter((e) => now - e.at < windowMs).length;',
    '}',
  ]);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Count requests in a sliding window'], '2026-02-02T10:01:00Z');
  committedHash = git(['rev-parse', 'HEAD']).trim();

  raw1 = limiterTranscript();
  raw2 = metricsTranscript();
  fs.writeFileSync(path.join(transcriptDir, T1), raw1, 'utf-8');
  fs.writeFileSync(path.join(transcriptDir, T2), raw2, 'utf-8');

  service = new StrataService(repoDir);
  service.init();
  service.indexCode();
}, 120_000);

afterAll(() => {
  service?.close();
  for (const d of [repoDir, transcriptDir]) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
});

const derive1 = () => deriveRecord(raw1, 'claude-code', T1, { repoRoot: repoDir });
const derive2 = () => deriveRecord(raw2, 'claude-code', T2, { repoRoot: repoDir });
const lines = (t: string): string[] => t.split('\n');

/**
 * Built once, on first use, after the records are stored.
 *
 * A pack costs seconds on a slow machine, and every test below reads the same one; building
 * it per test made this file's load push other files' pack builds past their timeouts.
 */
const once = <T>(build: () => T): (() => T) => {
  let value: T | undefined;
  return () => (value ??= build());
};
const agentPack = once(() => service.getContextPack('src/rate/limiter.ts', {}));
const limiterView = once(() => service.humanView('src/rate/limiter.ts', 'explain'));
const metricsView = once(() => service.humanView('src/rate/metrics.ts', 'explain'));

// ------------------------------------------------------------------ transcript → derived fact

describe('transcript → derived facts', () => {
  it('reads each change as an attempt with the result its own checks show', () => {
    const { record } = derive1();
    expect(record.attempts!.map((a) => a.status)).toEqual(['failed', 'partial', 'succeeded', 'abandoned', 'unknown']);
    expect(record.attempts!.every((a) => a.confidence === 'INFERRED')).toBe(true);
    expect(record.attempts!.map((a) => a.sequence)).toEqual([1, 2, 3, 4, 5]);
    // The reasons for each result are the checks, quoted.
    // Quoted as the detectors quote output: whitespace collapsed, words exact.
    expect(record.attempts![0]!.failureReason).toContain('Tests 1 failed | 4 passed (5)');
    expect(record.attempts![1]!.failureReason).toMatch(/2 distinct; by the last run of each, 1 passed and 1 did not/);
    expect(record.attempts![3]!.failureReason).toMatch(/restored from git at event/);
    expect(record.attempts![4]!.failureReason).toBe('No check was run after this change, so its result is not established.');
    // Whether each change reached a commit is stated on the attempt itself.
    expect(record.attempts![2]!.approach).toContain(`committed in the session as ${committedHash.slice(0, 7)}`);
    expect(record.attempts![4]!.approach).toContain('no commit of it was observed in the session');
    // Replaced before the commit, or reverted: its own text reached no commit, and it does not say it did.
    for (const i of [0, 1, 3]) expect(record.attempts![i]!.approach).not.toMatch(/commit/);
  });

  it('records a replacement without turning it into a failure', () => {
    const { record } = derive1();
    const [a1, a2, a3] = record.attempts!;
    expect(a1!.replacedBy).toMatch(/^attempt 2: a later change edited lines this one introduced/);
    expect(a2!.replacedBy).toMatch(/^attempt 3: /);
    // Replaced, but its own result stands: PARTIAL, not FAILED.
    expect(a2!.status).toBe('partial');
    expect(a3!.replacedBy).toBeUndefined();
  });

  it('keeps an explicit reason as DECLARED, with where it was said', () => {
    const { record } = derive1();
    const reason = record.reasons!.find((r) => r.statement === REASON)!;
    expect(reason).toBeTruthy();
    expect(reason.confidence).toBe('DECLARED');
    expect(reason.statedBy).toBe('the agent');
    expect(reason.evidence![0]).toMatch(new RegExp(`^${T1}#\\d+$`));
    expect(reason.precedesAttempt).toBe(1);
  });

  it('leaves an implied reason UNKNOWN: nothing is read into order, and thinking is not read', () => {
    const { record } = derive1();
    const all = [...record.reasons!, ...record.constraints!, ...record.consequences!].map((s) => s.statement);
    expect(all.some((s) => s.includes('switching to a sliding window'))).toBe(false);
    expect(all.some((s) => s.includes('reviewer is picky'))).toBe(false);
    expect(record.reasons!.map((r) => r.statement)).toEqual([REASON]);
    // The second session states no reason, and its record says none.
    expect(derive2().record.reasons).toEqual([]);
  });

  it('keeps explicit constraints and consequences as DECLARED, attributed to who said them', () => {
    const { record } = derive1();
    const prompted = record.constraints!.find((c) => c.statement === PROMPT_CONSTRAINT)!;
    expect(prompted.statedBy).toBe('the task prompt');
    expect(prompted.confidence).toBe('DECLARED');
    expect(prompted.status).toBe('UNKNOWN');
    const agent = record.constraints!.find((c) => c.statement === AGENT_CONSTRAINT)!;
    expect(agent.statedBy).toBe('the agent');
    const consequence = record.consequences!.find((c) => c.statement === CONSEQUENCE)!;
    expect(consequence.confidence).toBe('DECLARED');
    expect(consequence.evidence![0]).toMatch(new RegExp(`^${T1}#\\d+$`));
  });

  it('names files as the repository does, with the symbols the edits declare, and not the scratch probe', () => {
    const { record } = derive1();
    const byPath = new Map(record.files.map((f) => [f.path, f]));
    expect([...byPath.keys()]).toEqual(['src/rate/config.ts', 'src/rate/limiter.ts', 'src/rate/window.ts']);
    expect(byPath.get('src/rate/limiter.ts')!.symbols).toEqual(expect.arrayContaining(['countInWindow', 'slidingWindowCount']));
    expect(byPath.get('src/rate/config.ts')!.changeType).toBe('add');
    expect(record.files.some((f) => f.path.includes('probe'))).toBe(false);
  });

  it('links code history only through what the session printed', () => {
    const { record } = derive1();
    const commit = record.evidence!.find((e) => e.type === 'git_commit')!;
    expect(commit.reference).toBe(committedHash.slice(0, 7));
    expect(commit.confidence).toBe('VERIFIED');
    expect(record.evidence!.some((e) => e.type === 'diff' && e.description!.includes('src/rate/limiter.ts'))).toBe(true);
    // Every evidence item is the transcript's own content.
    expect(record.evidence!.every((e) => e.confidence === 'VERIFIED')).toBe(true);
    // The second session committed nothing, and its record says so.
    expect(derive2().record.result.summary).toContain('No commit was observed in the transcript');
  });

  it('derives the same record, with the same id, every time', () => {
    const a = derive1().record;
    const b = derive1().record;
    expect(a).toEqual(b);
    expect(a.id).toMatch(/^REC-T[0-9a-f]{10}$/);
    expect(derive2().record.id).not.toBe(a.id);
  });
});

// ------------------------------------------------------------------ derived fact → persisted memory

describe('derived facts → persisted memory', () => {
  it('stores the record once, and a second save of the same derivation changes nothing', () => {
    const { record, observedAt } = derive1();
    const before = service.getStatus().totalRecords;
    const first = service.saveDerivedRecord(record, { observedAt });
    expect(first.outcome).toBe('created');
    const file = path.join(repoDir, '.strata', 'records', `${record.id}.md`);
    const bytes = fs.readFileSync(file, 'utf-8');

    const second = service.saveDerivedRecord(derive1().record, { observedAt: derive1().observedAt });
    expect(second.outcome).toBe('unchanged');
    expect(service.getStatus().totalRecords).toBe(before + 1);
    expect(fs.readFileSync(file, 'utf-8')).toBe(bytes);
    expect(second.record.updatedAt).toBe(first.record.updatedAt);
  });

  it('dates the record when the session ran, not when it was derived', () => {
    const stored = service.getRecord(derive1().record.id!)!;
    expect(stored.createdAt).toBe(Date.parse('2026-02-02T10:00:02Z'));
  });

  it('does not attach the store\'s current HEAD as though it were the session\'s commit', () => {
    const stored = service.getRecord(derive1().record.id!)!;
    const commits = stored.evidence.filter((e) => e.type === 'git_commit').map((e) => e.reference);
    expect(commits).toEqual([committedHash.slice(0, 7)]);
  });

  it('resumes: a shorter capture of a session is replaced by the full one under the same id', () => {
    const cut = raw2.split('\n').slice(0, 5).join('\n');
    const partial = deriveRecord(cut, 'claude-code', T2, { repoRoot: repoDir });
    const full = derive2();
    expect(partial.record.id).toBe(full.record.id);
    const before = service.getStatus().totalRecords;
    expect(service.saveDerivedRecord(partial.record, { observedAt: partial.observedAt }).outcome).toBe('created');
    expect(service.saveDerivedRecord(full.record, { observedAt: full.observedAt }).outcome).toBe('updated');
    expect(service.saveDerivedRecord(full.record, { observedAt: full.observedAt }).outcome).toBe('unchanged');
    expect(service.getStatus().totalRecords).toBe(before + 1);
    expect(service.getRecord(full.record.id!)!.attempts.map((a) => a.status)).toEqual(['succeeded']);
  });

  it('keeps every part — statuses, reasons, who said what, coordinates — across a restart', () => {
    const id = derive1().record.id!;
    const before = service.getRecord(id)!;
    service.close();
    service = new StrataService(repoDir);
    const after = service.getRecord(id)!;
    expect(after).toEqual(before);
    expect(after.attempts.map((a) => a.status)).toEqual(['failed', 'partial', 'succeeded', 'abandoned', 'unknown']);
    expect(after.reasons[0]!.statedBy).toBe('the agent');
    expect(after.constraints.find((c) => c.statement === PROMPT_CONSTRAINT)!.statedBy).toBe('the task prompt');
    expect(after.consequences.find((c) => c.statement === CONSEQUENCE)!.evidence[0]).toMatch(new RegExp(`^${T1}#`));
  });

  it('rebuilds the same memory from the Markdown record files alone', () => {
    const file = path.join(repoDir, '.strata', 'records', `${derive1().record.id}.md`);
    const { record: parsed, downgraded } = parseRecordMarkdown(fs.readFileSync(file, 'utf-8'), file);
    // Every VERIFIED label in a derived record was written by Strata, and reads back so.
    expect(downgraded).toEqual([]);
    const scratch = new StrataDatabase({ dbPath: ':memory:' });
    try {
      const repo = new StrataRepository(scratch);
      repo.saveRecord(parsed);
      expect(repo.getRecordById(parsed.id)).toEqual(service.getRecord(parsed.id));
    } finally {
      scratch.close();
    }
  });
});

// ------------------------------------------------------------------ an old store

describe('an existing store gains the new attempt statuses without losing anything', () => {
  it('widens record_attempts once, keeping every row', () => {
    const file = path.join(transcriptDir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE records (
        id TEXT PRIMARY KEY, schema_version TEXT NOT NULL DEFAULT '0.1.0', title TEXT NOT NULL,
        intent TEXT NOT NULL, intent_confidence TEXT NOT NULL, author_name TEXT NOT NULL, author_email TEXT,
        author_type TEXT NOT NULL, agent_name TEXT, agent_model TEXT, agent_provider TEXT, agent_tool TEXT,
        result_status TEXT NOT NULL, result_summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE record_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, approach TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('succeeded', 'failed', 'abandoned', 'superseded')),
        failure_reason TEXT,
        confidence TEXT NOT NULL CHECK(confidence IN ('VERIFIED', 'DECLARED', 'INFERRED', 'UNKNOWN')));
      CREATE TABLE record_files (
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, file_path TEXT NOT NULL,
        change_type TEXT NOT NULL, symbols_affected TEXT, PRIMARY KEY (record_id, file_path));
      INSERT INTO records VALUES ('REC-1', '0.1.0', 'old', 'kept', 'DECLARED', 'A', NULL, 'human',
        NULL, NULL, NULL, NULL, 'success', NULL, 1, 1);
      INSERT INTO record_files VALUES ('REC-1', 'src/old.ts', 'modify', NULL);
      INSERT INTO record_attempts (record_id, sequence, approach, status, failure_reason, confidence)
        VALUES ('REC-1', 1, 'the old way', 'superseded', 'it was replaced', 'DECLARED');
    `);
    old.close();

    const db = new StrataDatabase({ dbPath: file });
    try {
      const sql = (db.getRawDb().prepare(`SELECT sql FROM sqlite_master WHERE name = 'record_attempts'`).get() as { sql: string }).sql;
      expect(sql).toContain(`'partial'`);
      expect(sql).toContain(`'unknown'`);
      const repo = new StrataRepository(db);
      const kept = repo.getRecordById('REC-1')!;
      expect(kept.attempts).toEqual([expect.objectContaining({ approach: 'the old way', status: 'superseded', failureReason: 'it was replaced' })]);
      repo.saveRecord({ ...kept, attempts: [...kept.attempts, { sequence: 2, approach: 'a mixed result', status: 'partial', confidence: 'INFERRED', evidence: ['t.jsonl#3'] }] });
      expect(repo.getRecordById('REC-1')!.attempts.map((a) => a.status)).toEqual(['superseded', 'partial']);
    } finally {
      db.close();
    }
    // Opening it again changes nothing further.
    const again = new StrataDatabase({ dbPath: file });
    expect(new StrataRepository(again).getRecordById('REC-1')!.attempts).toHaveLength(2);
    again.close();
  });
});

// ------------------------------------------------------------------ persisted memory → future context

describe('persisted memory → the next agent, through the ordinary Context Engine', () => {
  it('retrieves the derived record for its file, with provenance intact', () => {
    const id = derive1().record.id!;
    const pack = agentPack();
    const mine = (list: { evidence: string[] }[]) => list.filter((s) => s.evidence.includes(id));
    const intents = mine(pack.decisionsAndConstraints);
    expect(intents.length).toBeGreaterThanOrEqual(2);
    expect(intents.every((s) => (s as { provenance: string }).provenance === 'DECLARED')).toBe(true);
    expect(intents.some((s) => (s as { statement: string }).statement.includes('so I\'ll count requests'))).toBe(true);
    const attempts = mine(pack.previousAttempts) as { statement: string; provenance: string }[];
    expect(attempts.map((a) => a.statement.split(' — ')[1]?.split(':')[0] ?? a.statement)).toBeTruthy();
    expect(attempts.every((a) => a.provenance === 'INFERRED')).toBe(true);
    expect(attempts.some((a) => a.statement.includes(' failed: '))).toBe(true);
    expect(attempts.some((a) => a.statement.includes(' partial: '))).toBe(true);
    const constraints = mine(pack.constraints) as { statement: string; provenance: string }[];
    expect(constraints.some((c) => c.statement.includes('signature must not change') && c.provenance === 'DECLARED')).toBe(true);
  });

  it('links it to the file and the confirmed symbol — and not to a symbol that never reached HEAD', () => {
    const id = derive1().record.id!;
    const pack = agentPack();
    const refs = pack.decisionsAndConstraints.find((s) => s.evidence.includes(id))!.evidence;
    expect(refs).toContain('file:src/rate/limiter.ts');
    expect(refs).toContain('symbol:src/rate/limiter.ts#slidingWindowCount');
    expect(refs.some((r) => r.includes('countInWindow'))).toBe(false);
  });

  it('links it to the commit the session made, which the store confirms', () => {
    // The agent pack cites at most five links per record (files and symbols first); the
    // engine's full view of the same record lists every commit the store confirms.
    const id = derive1().record.id!;
    const { pack } = limiterView();
    expect(pack.memory!.find((m) => m.id === id)!.commits).toEqual([committedHash.slice(0, 7)]);
  });

  it('frames the derived statements as unverified claims in the rendered pack, like any record', () => {
    const id = derive1().record.id!;
    const text = service.renderContextPack(agentPack());
    const claimLines = lines(text).filter((l) => l.startsWith(`- (DECLARED) [${id}]`));
    expect(claimLines.length).toBeGreaterThan(0);
    for (const l of claimLines) expect(l).toContain('UNVERIFIED CLAIM: "');
  });
});

// ------------------------------------------------------------------ the human view

describe('the human view shows what was recorded, and nothing more', () => {
  const explain = () => limiterView().text;
  const block = (text: string, heading: string): string => {
    const all = lines(text);
    const start = all.findIndex((l) => l.startsWith(heading));
    const end = all.findIndex((l, i) => i > start + 1 && /^[A-Z][A-Z /]+ — /.test(l) && all[i + 1]?.startsWith('─'));
    return all.slice(start, end < 0 ? undefined : end).join('\n');
  };

  it('says the record was derived, when the session ran, and what it was derived from', () => {
    const mem = block(explain(), 'DEVELOPMENT MEMORY');
    expect(mem).toContain('derived automatically from an agent session transcript that ran on 2026-02-02 — nobody wrote this record');
    expect(mem).toContain('result (INFERRED — read from the transcript): success');
    expect(mem).toContain(`[git_commit] ${committedHash.slice(0, 7)} — Committed during the session`);
    expect(mem).toMatch(/\[diff\] session-limiter\.jsonl#\d+ — git diff printed at event/);
  });

  it('quotes the stated reason with who said it, where, and that order is not cause', () => {
    const mem = block(explain(), 'DEVELOPMENT MEMORY');
    expect(mem).toContain(`- "${REASON}"`);
    expect(mem).toMatch(/\(the agent, at session-limiter\.jsonl#\d+; stated immediately before attempt 1, which is an ordering, not a cause\)/);
  });

  it('shows which named symbols the index still holds', () => {
    const mem = block(explain(), 'DEVELOPMENT MEMORY');
    expect(mem).toContain('countInWindow (not in the index now)');
    expect(mem).toContain('slidingWindowCount (in the index now)');
  });

  it('lists every attempt with its result, replacement and transcript positions', () => {
    const att = block(explain(), 'PREVIOUS ATTEMPTS');
    for (const s of ['1. FAILED — INFERRED', '2. PARTIAL — INFERRED', '3. SUCCEEDED — INFERRED', '4. ABANDONED — INFERRED', '5. UNKNOWN — INFERRED']) {
      expect(att).toContain(s);
    }
    expect(att).toContain('replaced by: "attempt 2: a later change edited lines this one introduced');
    expect(att).toMatch(/evidence: session-limiter\.jsonl#[\d,]+/);
  });

  it('attributes constraints and consequences to who stated them', () => {
    const text = explain();
    expect(block(text, 'CONSTRAINTS')).toMatch(/\[UNKNOWN\] DECLARED, unverified claim \(REC-T[0-9a-f]{10}, about this code; stated by the task prompt, at session-limiter\.jsonl#\d+\):\n {4}"The public `allow\(\)` signature must not change\."/);
    expect(block(text, 'CONSEQUENCES')).toContain('stated by the agent, at session-limiter.jsonl#');
  });

  it('keeps an unstated reason UNKNOWN, in the summary and under UNCERTAINTY', () => {
    const text = metricsView().text;
    expect(block(text, 'WHY THIS CODE IS LIKE THIS')).toMatch(/\(derived from a transcript\): no reason was stated during the work {2}\[UNKNOWN\]/);
    const unc = block(text, 'UNCERTAINTY');
    expect(unc).toMatch(/why the work in REC-T[0-9a-f]{10} was done the way it was: nothing in its transcript states a reason/);
    expect(unc).toMatch(/whether the work recorded in REC-T[0-9a-f]{10} reached the repository: its transcript shows no commit/);
  });

  it('adds no cause of its own', () => {
    for (const text of [limiterView().text, metricsView().text]) {
      for (const l of lines(text).filter((x) => !x.includes('"'))) {
        if (/not claimed|not evidence that|not a cause/.test(l)) continue;
        expect(l, l).not.toMatch(/\bbecause\b|\bdue to\b|\bin order to\b|\bso that\b|\bled to\b|\bcaused\b|\bmotivat/i);
      }
    }
  });
});

// ------------------------------------------------------------------ lessons from real transcripts

describe('what the real transcripts taught the reader', () => {
  const tiny = (...envelopes: unknown[]) =>
    deriveRecord(stream(init('lesson'), ...envelopes, done()), 'claude-code', 'lesson.jsonl', { repoRoot: repoDir });

  it('does not take Strata\'s own memory, read back by the agent, for something the session did', () => {
    // A context tool result quoting an earlier record's line-ending and timeout incidents.
    const { findings, record } = tiny(
      use('s1', 'mcp__strata__strata_get_context', { task: 'change the limiter' }),
      result('s1', "REC-7: warning: in the working copy of 'src/rate/limiter.ts', LF will be replaced by CRLF the next time Git touches it. " +
        'Command did not complete within its 300s timeout and was moved to the background (ID: bg9).'),
    );
    expect(findings.filter((f) => f.kind === 'line_ending_change' || f.kind === 'timeout_backgrounded')).toEqual([]);
    expect(record.attempts).toEqual([]);
  });

  it('counts an inline script\'s write only when the session\'s own git output shows the file changed', () => {
    const script = (id: string, file: string) => use(id, 'Bash', {
      command: `cd "${shellDir()}" && python - <<'PYEOF'\nimport io\np = '${file}'\nsrc = io.open(p).read()\nio.open(p, 'w').write(src.replace('a', 'b'))\nPYEOF`,
      description: 'Apply the change',
    });
    const corroborated = tiny(
      script('p1', 'src/rate/metrics.ts'), result('p1', ''),
      use('d1', 'Bash', { command: `cd "${shellDir()}" && git --no-pager diff`, description: 'Show the diff' }),
      result('d1', 'diff --git a/src/rate/metrics.ts b/src/rate/metrics.ts\n--- a/src/rate/metrics.ts\n+++ b/src/rate/metrics.ts\n@@ -1 +1 @@\n-a\n+b'),
    );
    expect(corroborated.record.files.map((f) => f.path)).toEqual(['src/rate/metrics.ts']);
    expect(corroborated.work.attempts).toHaveLength(1);
    // The same script, with nothing in the session showing that the file changed.
    const alone = tiny(script('p2', 'src/rate/metrics.ts'), result('p2', ''));
    expect(alone.work.attempts).toEqual([]);
  });

  it('reads "may not" and a mid-sentence "never" as description, not as constraints', () => {
    const { record } = tiny(prompt(
      'Remove the dead origins.\n\nA track outside the band is pushed aside and never sequenced.\n' +
      'An origin that looks like a duplicate of another may not be one.\n\n' +
      '**Do not change the behaviour of any\nexisting caller.**'));
    expect(record.constraints!.map((c) => c.statement)).toEqual(['**Do not change the behaviour of any existing caller.**']);
  });
});

// ------------------------------------------------------------------ CLI and MCP

describe('surfaces', () => {
  it('strata derive --save is idempotent from the command line', () => {
    const run = (): string => {
      const program = new Command();
      program.exitOverride();
      registerDeriveCommand(program);
      const printed: string[] = [];
      const log = console.log;
      const cwd = process.cwd();
      console.log = (...a: unknown[]) => { printed.push(a.map(String).join(' ')); };
      try {
        process.chdir(repoDir);
        program.parse(['node', 'strata', 'derive', path.join(transcriptDir, T2), '--save']);
      } finally {
        process.chdir(cwd);
        console.log = log;
      }
      return printed.join('\n');
    };
    // Already stored by the resume test, so both runs find it unchanged — and add nothing.
    const before = service.getStatus().totalRecords;
    expect(run()).toMatch(/Saved as REC-T[0-9a-f]{10} \(unchanged\)/);
    expect(run()).toMatch(/\(unchanged\)/);
    expect(service.getStatus().totalRecords).toBe(before);
  });

  it('MCP strata_explain shows the derived record through the same tool as any other', async () => {
    const handler = new StrataMCPHandler(repoDir);
    try {
      const res = await handler.handleToolCall('strata_explain', { query: 'src/rate/limiter.ts' });
      expect(res.content[0]!.text).toContain('derived automatically from an agent session transcript');
    } finally {
      handler.close();
    }
  });
});
