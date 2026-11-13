import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { estimateTokens } from '../src/context/pack.js';

/**
 * Recorded memory follows the target, not the neighbourhood ranking.
 *
 * Every statement section is built by walking the selected records in order, and the
 * budget trims each section from its end. So the record that comes first is the record
 * that survives — and that order used to be decided by the *code neighbourhood* ranking,
 * which answers a different question (graph distance and shared words) from the one the
 * pack is about (what did the request name).
 *
 * Measured on a real repository: a question about one file resolved to it as the primary
 * target, the neighbourhood put a controller first, and under a tight budget the pack
 * kept the record about the controller and dropped the record about the file the
 * question named — the one carrying the two commits and the constant that answered it.
 *
 * The fixture reproduces that shape: the record about the target is discovered *after* a
 * record about a neighbour, so a pack that merely preserves discovery order fails these
 * tests.
 */

const repoDir = path.join(process.cwd(), '.test_repo_anchored_memory');
let service: StrataService;

const git = (...a: string[]): string => execFileSync('git', a, { cwd: repoDir, encoding: 'utf-8' });
const write = (rel: string, body: string): void => {
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf-8');
};

/** The question names the gate. The controller is only a neighbour that imports it. */
const QUERY = 'the drift gate rejects tracks by tempo in src/engine/driftGate.ts';

beforeAll(() => {
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(repoDir, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture Author');

  write('src/engine/driftGate.ts', [
    'export const LOWER_BOUND = 104;',
    'export const UPPER_BOUND = 136;',
    'export function withinGate(bpm: number): boolean {',
    '  return bpm >= LOWER_BOUND && bpm <= UPPER_BOUND;',
    '}',
  ].join('\n') + '\n');
  write('src/engine/playlistController.ts', [
    "import { withinGate } from './driftGate.js';",
    'export function buildPlaylist(bpms: number[]): number[] {',
    '  return bpms.filter(withinGate);',
    '}',
  ].join('\n') + '\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'gate tracks on an absolute tempo band');
  const gateCommit = git('rev-parse', 'HEAD').trim();

  service = new StrataService(repoDir);
  service.init();
  service.indexCode();

  /*
    Written controller-first on purpose. The controller is what the neighbourhood ranks
    highest — it is the file that imports the target — so discovery order puts its record
    ahead of the target's, which is exactly the inversion under test.
  */
  service.recordChange({
    id: 'REC-NEIGHBOR',
    title: 'Playlist controller returns an empty list rather than throwing',
    intent: 'Callers treated a thrown error as a transport failure and retried it forever.',
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/engine/playlistController.ts', changeType: 'modify' }],
    attempts: [
      { approach: 'Throw EmptyPlaylistError from the controller', status: 'failed',
        failureReason: 'Callers retried it as a network fault.', confidence: 'DECLARED' },
      { approach: 'Return null from the controller', status: 'superseded',
        failureReason: 'Every call site needed a null check.', confidence: 'DECLARED' },
    ],
    constraints: [{ statement: 'The controller must never throw for an empty result.',
                    confidence: 'DECLARED', status: 'ACTIVE' }],
    consequences: [{ statement: 'Empty and failed are no longer distinguishable to callers.',
                     confidence: 'DECLARED', evidence: [] }],
    result: { status: 'success' },
  });

  service.recordChange({
    id: 'REC-TARGET',
    title: 'driftGate.ts: the tempo gate was fixed to an absolute band',
    intent: 'The gate began as a band relative to the pool median and was replaced by an '
      + 'absolute one. WINDOW_MEDIAN_SPREAD was the original control.',
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/engine/driftGate.ts', changeType: 'modify' }],
    attempts: [
      // First: names the commit that ADDED the mechanism.
      { approach: 'Gate on intensity alone, with no tempo bound', status: 'superseded',
        failureReason: 'Superseded when the tempo gate was introduced.', confidence: 'DECLARED' },
      // Second: names what REPLACED it, and the constant. The decisive one, and the one a
      // floor of a single statement throws away.
      { approach: 'Gate on tempo relative to the pool median (WINDOW_MEDIAN_SPREAD = 15)',
        status: 'superseded',
        failureReason: 'Replaced by the absolute 104-136 band now in the file.',
        confidence: 'DECLARED' },
    ],
    constraints: [{ statement: 'The gate must keep at least half of a genre-shaped playlist.',
                    confidence: 'DECLARED', status: 'ACTIVE' }],
    consequences: [
      { statement: 'The retention rate follows directly from the bounds chosen here.',
        confidence: 'DECLARED', evidence: [] },
      { statement: 'Nothing records how 104 and 136 were derived.',
        confidence: 'DECLARED', evidence: [] },
    ],
    evidence: [
      { type: 'git_commit', reference: gateCommit, confidence: 'VERIFIED',
        description: 'the commit that set the absolute band' },
    ],
    result: { status: 'success' },
  });
}, 60_000);

afterAll(() => {
  service?.close();
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
});

/*
  One build per budget of the query, shared by every test that asks for it.

  A pack build spends most of its time starting git processes, and the full suite runs
  every file's builds in parallel; fifteen builds here were five packs. Packs are only read
  and rendered, and nothing in this file changes this store or its index after setup.
*/
const built = new Map<number, ReturnType<StrataService['getContextPack']>>();
const packAt = (maxTokens: number): ReturnType<StrataService['getContextPack']> => {
  let pack = built.get(maxTokens);
  if (!pack) {
    pack = service.getContextPack(QUERY, { maxTokens });
    built.set(maxTokens, pack);
  }
  return pack;
};

/** Every record id the pack's statements attribute themselves to, in order. */
const recordOrder = (pack: ReturnType<StrataService['getContextPack']>): string[] =>
  [...pack.decisionsAndConstraints, ...pack.constraints, ...pack.previousAttempts, ...pack.consequences]
    .map((s) => s.evidence.find((e) => /^REC-/.test(e)) ?? '?');

describe('records are ordered by distance from the resolved target', () => {
  it('puts the primary target\'s record ahead of a neighbour\'s, whatever the neighbourhood ranking', () => {
    const pack = packAt(40_000);
    expect(pack.target.files[0]).toBe('src/engine/driftGate.ts');
    // Both records are present; the order is what is under test.
    const order = recordOrder(pack);
    expect(new Set(order)).toEqual(new Set(['REC-TARGET', 'REC-NEIGHBOR']));
    expect(order[0]).toBe('REC-TARGET');
    expect(order.indexOf('REC-TARGET')).toBeLessThan(order.indexOf('REC-NEIGHBOR'));
  });

  it('is not simply discovery order: the neighbour\'s record was written first', () => {
    // A pack that kept insertion order would put REC-NEIGHBOR first, since it is the
    // record for the file the neighbourhood ranks highest.
    const neighbourFirst = service.getContextPack('src/engine/playlistController.ts', { maxTokens: 40_000 });
    expect(recordOrder(neighbourFirst)[0]).toBe('REC-NEIGHBOR');
  });
});

describe('a tight budget keeps the target\'s memory and drops the neighbour\'s', () => {
  // Small enough that the sections cannot hold both records.
  const TIGHT = 900;

  it('keeps the record about the target', () => {
    const text = service.renderContextPack(packAt(TIGHT));
    expect(text).toContain('REC-TARGET');
  });

  it('drops the neighbour\'s record first', () => {
    const pack = packAt(TIGHT);
    expect(recordOrder(pack).every((id) => id === 'REC-TARGET')).toBe(true);
    expect(pack.diagnostics.recordsOmitted).toContain('REC-NEIGHBOR');
  });

  it('keeps more than the target record\'s first attempt, so a progression survives', () => {
    // The decisive attempt is rarely the first one written: the first names what was
    // superseded, the second names what replaced it.
    const text = service.renderContextPack(packAt(TIGHT));
    expect(text).toContain('WINDOW_MEDIAN_SPREAD');
  });

  it('keeps the target record\'s cited evidence, which survives nowhere else', () => {
    // The record's intent is capped, so a commit it cites past the cap exists only here.
    const pack = packAt(TIGHT);
    expect(pack.evidence.some((e) => e.startsWith('git_commit:'))).toBe(true);
    expect(pack.evidence[0]).toBe('record REC-TARGET');
  });

  it('respects the budget while doing it', () => {
    const pack = packAt(TIGHT);
    const size = estimateTokens(service.renderContextPack(pack));
    expect(size <= TIGHT || pack.diagnostics.budgetExceeded).toBe(true);
  });
});

describe('what is omitted is said, not implied', () => {
  it('names a record the budget removed, so it cannot read as "nothing was recorded"', () => {
    const text = service.renderContextPack(packAt(900));
    expect(text).toMatch(/REC-NEIGHBOR.*did not fit this budget; omitted, not absent/);
  });

  it('reports no omission when everything fits', () => {
    const pack = packAt(40_000);
    expect(pack.diagnostics.recordsOmitted).toEqual([]);
    expect(service.renderContextPack(pack)).not.toContain('omitted, not absent');
  });

  it('distinguishes trimmed history from absent history', () => {
    // An emptied section used to state "no commits recorded against these files", which
    // is a claim about the repository and false whenever the budget did the emptying.
    const tight = service.renderContextPack(packAt(400));
    if (/## HISTORICAL CONTEXT\n- (UNKNOWN|OMITTED)/.test(tight)) {
      expect(tight).toMatch(/## HISTORICAL CONTEXT\n- OMITTED/);
      expect(tight).not.toMatch(/## HISTORICAL CONTEXT\n- UNKNOWN/);
    }
  });

  it('still says UNKNOWN where there genuinely is no history', () => {
    // A repository with no commits touching the target: absence, not omission.
    const bare = path.join(process.cwd(), '.test_repo_anchored_bare');
    if (fs.existsSync(bare)) fs.rmSync(bare, { recursive: true, force: true });
    fs.mkdirSync(path.join(bare, 'src'), { recursive: true });
    fs.writeFileSync(path.join(bare, 'src/only.ts'), 'export const only = 1;\n', 'utf-8');
    const g = (...a: string[]): string => execFileSync('git', a, { cwd: bare, encoding: 'utf-8' });
    g('init', '-q');
    g('config', 'user.email', 'a@b.c');
    g('config', 'user.name', 'A');
    const other = new StrataService(bare);
    try {
      other.init();
      other.indexCode();
      // Uncommitted: the file exists in the index but no commit mentions it.
      const text = other.renderContextPack(other.getContextPack('src/only.ts', { maxTokens: 40_000 }));
      expect(text).toMatch(/## HISTORICAL CONTEXT\n- UNKNOWN/);
    } finally {
      other.close();
      fs.rmSync(bare, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('existing behaviour is unchanged', () => {
  it('still refuses a record that touches nothing in the neighbourhood', () => {
    const pack = packAt(40_000);
    for (const id of recordOrder(pack)) expect(['REC-TARGET', 'REC-NEIGHBOR']).toContain(id);
  });

  it('carries each record\'s own provenance through, unchanged', () => {
    const pack = packAt(40_000);
    for (const s of [...pack.previousAttempts, ...pack.consequences]) {
      expect(s.provenance).toBe('DECLARED');
    }
  });

  it('keeps a record\'s statements attributed to it', () => {
    const pack = packAt(40_000);
    for (const s of pack.previousAttempts) {
      expect(s.statement).toMatch(/^\[REC-(TARGET|NEIGHBOR)\]/);
      expect(s.evidence.some((e) => e.startsWith('file:'))).toBe(true);
    }
  });

  it('keeps the trimmed-section notice from growing without bound', () => {
    // The notice lists one name per trimming step. On a tight pack that ran to fifteen
    // names and cost more than the section it had just reclaimed, which made the pack's
    // own size depend on how much had been trimmed from it.
    const text = service.renderContextPack(packAt(400));
    const notice = text.split('\n').find((l) => l.startsWith('_Truncated to fit'));
    if (notice) expect(notice.length).toBeLessThan(260);
  });
});
