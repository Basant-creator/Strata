import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import type { ContextPack } from '../src/context/pack.js';

/**
 * Git says what changed. These tests are about the other half — what was tried,
 * what it cost, what it left behind — and about the line between the two. The
 * fixture is a synthetic telemetry ingester with real git history and hand-written
 * records, sharing nothing with any real repository.
 *
 * History:
 *   c1  ingest keyed by deviceId
 *   c2  DECISIVE — key by sensorKey, add a reuse test
 *   c3  unrelated subsystem
 *   c4  a later tweak to the same file
 */

const repoDir = path.join(process.cwd(), '.test_repo_memory');
let service: StrataService;
const sha: Record<string, string> = {};

const git = (...a: string[]): string =>
  execFileSync('git', a, { cwd: repoDir, encoding: 'utf-8' });
function write(rel: string, body: string): void {
  const full = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body.trimStart(), 'utf-8');
}
function commit(tag: string, message: string): void {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  sha[tag] = git('rev-parse', '--short', 'HEAD').trim();
}

beforeAll(() => {
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(repoDir, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'depot@example.com');
  git('config', 'user.name', 'Depot');

  write('src/ingest/reading.ts', `
export interface Reading { deviceId: string; value: number; }
export function readingKey(r: Reading): string { return r.deviceId; }
`);
  write('src/ingest/pipeline.ts', `
import { readingKey, Reading } from './reading.js';
export function ingest(r: Reading): string { return readingKey(r); }
`);
  commit('c1', 'ingest readings keyed by deviceId');

  write('src/ingest/reading.ts', `
export interface Reading { sensorKey: string; deviceId?: string; value: number; }
export function readingKey(r: Reading): string { return r.sensorKey; }
`);
  write('tests/sensorKeyReuse.test.ts', `
export const cases = ['one sensor reported by two devices collapses to one reading'];
`);
  commit('c2', 'key readings by sensorKey');

  write('src/reporting/charts.ts', `export const palette = ['a', 'b'];\n`);
  commit('c3', 'add the chart palette');

  write('src/ingest/reading.ts', `
export interface Reading { sensorKey: string; deviceId?: string; value: number; unit: string; }
export function readingKey(r: Reading): string { return r.sensorKey; }
`);
  commit('c4', 'carry the unit on each reading');

  service = new StrataService(repoDir);
  service.init();
  service.indexCode();

  // The memory: a failed attempt, its replacement, a constraint, a consequence.
  service.recordChange({
    id: 'REC-KEY',
    title: 'Reading identity moved to sensorKey',
    intent: 'One sensor reported by two devices was producing two readings.',
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/ingest/reading.ts', changeType: 'modify' }],
    symbols: ['readingKey'],
    status: 'ACTIVE',
    attempts: [
      {
        approach: 'Deduplicate by deviceId at write time',
        status: 'failed',
        failureReason: 'A replacement device reports the same sensor under a new deviceId.',
        confidence: 'DECLARED',
        evidence: [`commit:${sha.c1}`],
        replacedBy: 'Key the reading by sensorKey',
      },
      {
        approach: 'Key the reading by sensorKey',
        status: 'succeeded',
        confidence: 'DECLARED',
        evidence: ['tests/sensorKeyReuse.test.ts'],
      },
    ],
    constraints: [
      {
        statement: 'A sensor swapped onto a new device must keep one reading, not gain a second.',
        confidence: 'DECLARED',
        evidence: ['tests/sensorKeyReuse.test.ts'],
        status: 'ACTIVE',
      },
    ],
    consequences: [
      {
        statement: 'Readings written before the change carry no sensorKey and are backfilled on read.',
        confidence: 'DECLARED',
        evidence: [`commit:${sha.c2}`],
      },
    ],
    evidence: [{ type: 'git_commit', reference: sha.c2!, confidence: 'VERIFIED' }],
    result: { status: 'success', summary: 'One reading per sensor.' },
  });

  // Superseded memory: an old constraint that no longer binds, kept as history.
  service.recordChange({
    id: 'REC-OLD',
    title: 'Device ids were once required to be numeric',
    intent: 'The original ingest parsed deviceId as an integer.',
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/ingest/reading.ts', changeType: 'modify' }],
    status: 'SUPERSEDED',
    supersededBy: 'REC-KEY',
    constraints: [
      {
        statement: 'deviceId must parse as an integer.',
        confidence: 'DECLARED',
        evidence: [`commit:${sha.c1}`],
        status: 'SUPERSEDED',
      },
    ],
    result: { status: 'success' },
  });

  // Memory about somewhere else entirely. Must not reach the ingest target.
  service.recordChange({
    id: 'REC-CHART',
    title: 'Chart palette fixed to two colours',
    intent: 'The palette was cycling unpredictably.',
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/reporting/charts.ts', changeType: 'modify' }],
    constraints: [
      { statement: 'The palette must stay colour-blind safe.', confidence: 'DECLARED', status: 'ACTIVE' },
    ],
    result: { status: 'success' },
  });
}, 90_000);

afterAll(() => {
  service?.close();
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
});

/*
  One build per question and budget, shared by every test that asks it.

  A pack build spends most of its time starting git processes, and the full suite runs
  every file's builds in parallel: test 12c built two packs inside one five-second test and
  took ~2.8 s under the suite, and most tests here rebuild the same 9,000-token pack. Packs
  are only read and rendered. The one test that changes what a pack would contain — it
  adds a record — clears the cache when it does.
*/
const asked = new Map<string, ContextPack>();
const ask = (q: string, opts = {}): ContextPack => {
  const key = `${q}|${JSON.stringify(opts)}`;
  let pack = asked.get(key);
  if (!pack) {
    pack = service.getContextPack(q, opts);
    asked.set(key, pack);
  }
  return pack;
};
const target = (opts = {}) => ask('src/ingest/reading.ts', opts);
const render = (p: ContextPack): string => service.renderContextPack(p);

// ------------------------------------------------------- 1-3: attempts

describe('attempts are stored and surfaced with their outcome', () => {
  it('1/2. a failed attempt keeps its failure reason and its replacement', () => {
    const rec = service.getRecord('REC-KEY')!;
    const failed = rec.attempts.find((a) => a.status === 'failed')!;
    expect(failed.approach).toMatch(/Deduplicate by deviceId/);
    expect(failed.failureReason).toMatch(/replacement device/);
    expect(failed.replacedBy).toBe('Key the reading by sensorKey');
    expect(failed.evidence).toContain(`commit:${sha.c1}`);
  });

  it('3. a successful attempt is distinguishable from a failed one', () => {
    const rec = service.getRecord('REC-KEY')!;
    expect(rec.attempts.map((a) => a.status).sort()).toEqual(['failed', 'succeeded']);
  });

  it('the failed attempt reaches the context pack', () => {
    const text = render(target());
    expect(text).toMatch(/Deduplicate by deviceId/);
    expect(text).toMatch(/replacement device/);
  });
});

// ------------------------------------------------- 4-6: decision, constraint, consequence

describe('decision, constraint and consequence are distinct', () => {
  it('4/5/6. each lands in its own section rather than one narrative', () => {
    const pack = target();
    expect(pack.decisionsAndConstraints.some((s) => /two readings/.test(s.statement))).toBe(true);
    expect(pack.constraints.some((s) => /swapped onto a new device/.test(s.statement))).toBe(true);
    expect(pack.consequences.some((s) => /backfilled on read/.test(s.statement))).toBe(true);
  });

  it('5. a constraint is not printed as a consequence', () => {
    const text = render(target());
    const constraintLine = text.split('\n').find((l) => /swapped onto a new device/.test(l))!;
    expect(constraintLine).toBeDefined();
    const section = text.slice(0, text.indexOf(constraintLine));
    expect(section).toContain('## CONSTRAINTS');
  });

  it('6. a consequence is not promoted into a causal claim', () => {
    const c = target().consequences.find((s) => /backfilled on read/.test(s.statement))!;
    expect(c.provenance).toBe('DECLARED');
    expect(c.statement).not.toMatch(/\bcaused\b/);
  });
});

// ------------------------------------------------------ 7, 8, 15, 16: honesty

describe('nothing is invented', () => {
  it('7/15. no motive is asserted as VERIFIED', () => {
    const pack = target();
    const claims = [
      ...pack.whyThisAreaMatters, ...pack.decisionsAndConstraints, ...pack.constraints,
      ...pack.previousAttempts, ...pack.consequences,
    ];
    for (const c of claims) {
      if (/\bbecause\b|\bin order to\b|\bso that\b/i.test(c.statement)) {
        expect(c.provenance, `motive as VERIFIED: ${c.statement}`).not.toBe('VERIFIED');
      }
    }
  });

  it('8. recorded provenance survives the round trip', () => {
    const rec = service.getRecord('REC-KEY')!;
    expect(rec.constraints[0]!.confidence).toBe('DECLARED');
    expect(rec.consequences[0]!.confidence).toBe('DECLARED');
    // And the pack does not raise it.
    const c = target().constraints.find((s) => /swapped onto a new device/.test(s.statement))!;
    expect(c.provenance).toBe('DECLARED');
  });

  it('16. no consequence is manufactured for a target that recorded none', () => {
    const pack = ask('src/ingest/pipeline.ts');
    for (const c of pack.consequences) expect(c.provenance).not.toBe('VERIFIED');
  });
});

// --------------------------------------------------------- 9: superseded memory

describe('superseded memory is kept and marked', () => {
  it('9. a superseded record is still retrievable', () => {
    const rec = service.getRecord('REC-OLD')!;
    expect(rec.status).toBe('SUPERSEDED');
    expect(rec.supersededBy).toBe('REC-KEY');
  });

  it('9b. a superseded constraint is shown with its status, not hidden', () => {
    const pack = target({ maxTokens: 9000 });
    const old = pack.constraints.find((s) => /parse as an integer/.test(s.statement));
    expect(old, 'the superseded constraint was dropped entirely').toBeTruthy();
    expect(old!.statement).toContain('SUPERSEDED');
  });
});

// -------------------------------------------------- 10, 11: retrieval and filtering

describe('memory is retrieved for its target and no further', () => {
  it('10. memory linked to the target is retrieved', () => {
    const text = render(target());
    expect(text).toContain('REC-KEY');
  });

  it('11. memory about another subsystem does not reach this target', () => {
    const text = render(target({ maxTokens: 9000 }));
    expect(text).not.toContain('REC-CHART');
    expect(text).not.toMatch(/colour-blind safe/);
  });

  it('11b. that memory does reach its own target', () => {
    expect(render(ask('src/reporting/charts.ts'))).toContain('REC-CHART');
  });
});

// --------------------------------------------------------------- 12: budget

describe('decisive memory survives budgeting', () => {
  it('12. a tight budget keeps the failed attempt', () => {
    const tight = target({ maxTokens: 1500 });
    const text = render(tight);
    expect(text).toMatch(/Deduplicate by deviceId/);
  });

  it('12c. a tight budget never empties a section that had content', () => {
    // Found on real data: consequences had no floor while attempts had one, so the
    // budget emptied the section and the pack rendered "nothing recorded" over
    // three recorded consequences — a different claim, and a false one.
    const roomy = target({ maxTokens: 9000 });
    const tight = target({ maxTokens: 1400 });
    if (roomy.consequences.length > 0) expect(tight.consequences.length).toBeGreaterThan(0);
    if (roomy.previousAttempts.length > 0) expect(tight.previousAttempts.length).toBeGreaterThan(0);
    if (roomy.constraints.length > 0) expect(tight.constraints.length).toBeGreaterThan(0);
  });

  it('12b. a tight budget keeps at least one constraint', () => {
    const tight = target({ maxTokens: 1500 });
    expect(tight.constraints.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------ 13: persistence

describe('memory survives a process restart', () => {
  it('13. a second service instance reads the same memory back', () => {
    const reopened = new StrataService(repoDir);
    try {
      const rec = reopened.getRecord('REC-KEY')!;
      expect(rec, 'record did not survive reopening').toBeTruthy();
      expect(rec.constraints[0]!.statement).toMatch(/swapped onto a new device/);
      expect(rec.consequences[0]!.evidence).toContain(`commit:${sha.c2}`);
      expect(rec.attempts.find((a) => a.status === 'failed')!.replacedBy)
        .toBe('Key the reading by sensorKey');
      expect(rec.symbols).toContain('readingKey');
      expect(rec.status).toBe('ACTIVE');
    } finally {
      reopened.close();
    }
  });

  it('13b. a store created before these fields existed still loads', () => {
    // The migration adds columns to an existing database; a record written through
    // the old shape (consequences as bare strings) must read back unchanged rather
    // than failing or acquiring claims nobody made.
    service.recordChange({
      id: 'REC-LEGACY',
      title: 'Legacy shape',
      intent: 'Written the way records used to be written.',
      files: [{ path: 'src/ingest/reading.ts', changeType: 'modify' }],
      consequences: ['A bare string, as the old schema allowed'],
      result: { status: 'success' },
    });
    // Packs built before the record do not carry it.
    asked.clear();
    const rec = service.getRecord('REC-LEGACY')!;
    expect(rec.consequences[0]!.statement).toBe('A bare string, as the old schema allowed');
    expect(rec.consequences[0]!.confidence).toBe('DECLARED');
    expect(rec.constraints).toEqual([]);
    expect(rec.status).toBe('UNKNOWN');
  });
});

// ------------------------------------------------- 14: git history stays separate

describe('development memory and git history stay distinguishable', () => {
  it('14. a git-derived decision and a recorded attempt are different things', () => {
    const text = render(target({ maxTokens: 9000 }));
    // The git side: measured from the diff, VERIFIED, with a status against HEAD.
    expect(text).toContain('## HISTORICAL DECISIONS');
    expect(text).toMatch(/STATUS: (ACTIVE|SUPERSEDED|UNKNOWN)/);
    // The memory side: someone's account, DECLARED, in its own section.
    expect(text).toContain('## PREVIOUS ATTEMPTS');
    const attemptLine = text.split('\n').find((l) => /Deduplicate by deviceId/.test(l))!;
    expect(attemptLine).toMatch(/DECLARED/);
  });

  it('14b. the pack never labels a recorded claim as git evidence', () => {
    const pack = target({ maxTokens: 9000 });
    for (const s of [...pack.previousAttempts, ...pack.constraints, ...pack.consequences]) {
      expect(s.provenance).not.toBe('VERIFIED');
    }
  });
});
