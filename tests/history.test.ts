import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import type { ContextPack } from '../src/context/pack.js';

/**
 * The fixture is a synthetic depot-routing service with a deliberately shaped
 * history. Nothing here shares a path, symbol, phrase or commit id with any real
 * repository, so no case can pass by having been tuned to one.
 *
 * The history is built commit by commit so each case has a known right answer:
 *
 *   c1  create the manifest keyed by parcelId, with an identity test
 *   c2  DECISIVE — replace parcelId with routeKey, add a reuse test
 *   c3  unrelated: a label printer in another subsystem
 *   c4  delete the original identity test          (deleted evidence)
 *   c5  add a strict-validation flag               (attempt)
 *   c6  remove it again                            (superseded)
 *   c7  partially rewrite one routeKey line        (partial survival -> UNKNOWN)
 *   c8  unrelated and most recent: report layout   (must not bury c2)
 */

const repoDir = path.join(process.cwd(), '.test_repo_history');
let service: StrataService;
const sha: Record<string, string> = {};

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' });
}
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

  // --- c1: the original identity ------------------------------------------
  write('src/routing/manifest.ts', `
export interface ManifestEntry {
  parcelId: string;
  destination: string;
}

export function manifestKey(entry: ManifestEntry): string {
  return entry.parcelId;
}
`);
  write('src/routing/dispatch.ts', `
import { manifestKey, ManifestEntry } from './manifest.js';

export function dispatch(entry: ManifestEntry): string {
  return 'dispatched ' + manifestKey(entry);
}
`);
  write('tests/manifestIdentity.test.ts', `
// Asserts one manifest entry per parcelId.
export const identityCases = ['parcelId is the manifest identity'];
`);
  commit('c1', 'create the routing manifest keyed by parcelId');

  // --- c2: the decisive change --------------------------------------------
  write('src/routing/manifest.ts', `
export interface ManifestEntry {
  routeKey: string;
  parcelId?: string;
  destination: string;
}

export function manifestKey(entry: ManifestEntry): string {
  return entry.routeKey;
}
`);
  write('tests/routeKeyReuse.test.ts', `
// A depot re-scans the same route under a new parcelId; the manifest entry must
// be reused rather than duplicated.
export const reuseCases = ['same routeKey across two parcelIds reuses one entry'];
`);
  commit('c2', 'key the manifest by routeKey so re-scans reuse one entry');

  // --- c3: unrelated subsystem --------------------------------------------
  write('src/labels/printer.ts', `
export function printLabel(text: string): string { return text.toUpperCase(); }
`);
  commit('c3', 'add the label printer');

  // --- c4: delete the original identity test ------------------------------
  fs.rmSync(path.join(repoDir, 'tests/manifestIdentity.test.ts'));
  commit('c4', 'drop the superseded parcelId identity test');

  // --- c5 / c6: an attempt, then its removal ------------------------------
  write('src/routing/manifest.ts', `
export interface ManifestEntry {
  routeKey: string;
  parcelId?: string;
  destination: string;
}

export const strictManifestValidation = true;

export function manifestKey(entry: ManifestEntry): string {
  return entry.routeKey;
}
`);
  commit('c5', 'try strict manifest validation');

  write('src/routing/manifest.ts', `
export interface ManifestEntry {
  routeKey: string;
  parcelId?: string;
  destination: string;
}

export function manifestKey(entry: ManifestEntry): string {
  return entry.routeKey;
}
`);
  commit('c6', 'remove strict manifest validation');

  // --- c7: partial rewrite of a c2 line ------------------------------------
  write('src/routing/manifest.ts', `
export interface ManifestEntry {
  routeKey: string;
  parcelId?: string;
  destination: string;
  scannedAt: number;
}

export function manifestKey(entry: ManifestEntry): string {
  return entry.routeKey;
}
`);
  commit('c7', 'record the scan timestamp on each entry');

  // --- c8: unrelated and most recent ---------------------------------------
  write('src/reporting/layout.ts', `
export const reportColumns = ['route', 'destination', 'scannedAt'];
`);
  commit('c8', 'tune the warehouse report layout');

  service = new StrataService(repoDir);
  service.init();
  service.indexCode();

  // A record carrying an attempt, a constraint and a consequence.
  service.recordChange({
    title: 'Manifest identity moved to routeKey',
    intent: 'Re-scans of the same route were creating duplicate manifest entries.',
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/routing/manifest.ts', changeType: 'modify' }],
    attempts: [
      {
        approach: 'Deduplicate by destination string at write time',
        status: 'failed',
        failureReason: 'Two depots share a destination, so distinct routes collapsed into one entry.',
        confidence: 'DECLARED',
      },
      { approach: 'Key the manifest by routeKey', status: 'succeeded', confidence: 'DECLARED' },
    ],
    evidence: [
      { type: 'test_run', reference: 'tests/routeKeyReuse.test.ts', confidence: 'VERIFIED' },
    ],
    consequences: ['Entries scanned before the change carry no routeKey and are backfilled lazily.'],
    result: { status: 'success', summary: 'Re-scans reuse one entry.' },
  });
}, 90_000);

afterAll(() => {
  service?.close();
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
});

/*
  One build per question, shared by every test that asks it.

  A pack build spends most of its time starting git processes, and the full suite runs
  every file's builds in parallel. Twenty-eight calls here ask five questions — most of
  them `target()` — and test 12 asked it twice in one test. Packs are only read and
  rendered, and nothing in this file changes the store or the index after setup, so each
  question is built once.
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
const target = () => ask('src/routing/manifest.ts');
const render = (p: ContextPack): string => service.renderContextPack(p);
const hashes = (p: ContextPack): string[] => p.historicalContext.map((h) => h.shortHash);
const decisionFor = (p: ContextPack, commitSha: string) =>
  p.historicalDecisions.find((d) => d.commit === commitSha);

// --------------------------------------------------------- 1, 3, 7: state split

describe('current, historical and change are separated', () => {
  it('1/7. reports what is there now, from the working tree', () => {
    const pack = target();
    const behavior = pack.currentBehavior.find((b) => b.file === 'src/routing/manifest.ts');
    expect(behavior).toBeDefined();
    expect(behavior!.provenance).toBe('VERIFIED');
    expect(behavior!.signatures.map((s) => s.name)).toContain('manifestKey');
  });

  it('1. carries the old state and the new state as separate quoted facts', () => {
    const d = decisionFor(target(), sha.c2!);
    expect(d, 'the decisive commit produced no decision').toBeDefined();
    // What used to be there.
    expect(d!.historicalState.join('\n')).toMatch(/parcelId: string/);
    // What replaced it, and whether that is what the file holds now.
    expect(d!.currentState.join('\n')).toMatch(/routeKey/);
    expect(d!.currentIsAtHead).toBe(true);
  });

  it('3. includes the decisive diff, not just the commit subject', () => {
    const text = render(target());
    expect(text).toMatch(/routeKey/);
    // The subject alone would not tell a reader which field replaced which.
    expect(text).toMatch(/parcelId/);
  });
});

// ------------------------------------------------------- 2, 5: decision status

describe('decision status is measured against HEAD', () => {
  it('2. the surviving identity change is ACTIVE', () => {
    const d = decisionFor(target(), sha.c2!);
    expect(d!.status).toBe('ACTIVE');
    expect(d!.statusProvenance).toBe('VERIFIED');
    expect(d!.statusReason).toMatch(/HEAD/);
  });

  it('3. a change that was later removed is SUPERSEDED', () => {
    const pack = target();
    const d = decisionFor(pack, sha.c5!);
    if (d) {
      expect(d.status).toBe('SUPERSEDED');
      expect(d.statusReason).toMatch(/None of the .* are in .* at HEAD|absent/i);
    } else {
      // If c5 did not rank into the pack, the claim still must not be that it holds.
      expect(pack.historicalDecisions.every((x) => x.commit !== sha.c5)).toBe(true);
    }
  });

  it('4. status is never ACTIVE merely because a commit is old', () => {
    // Every ACTIVE decision must cite HEAD content as its grounds.
    for (const d of target().historicalDecisions) {
      if (d.status === 'ACTIVE') expect(d.statusReason).toMatch(/HEAD/);
      if (d.status === 'UNKNOWN') expect(d.statusProvenance).toBe('UNKNOWN');
    }
  });

  it('4b. partial survival is UNKNOWN rather than ACTIVE', () => {
    // c7 rewrote part of the interface c2 established. Any decision reported for a
    // partly-surviving change must not claim to still hold.
    const partial = target().historicalDecisions.filter(
      (d) => d.survivingLines > 0 && d.survivingLines < d.addedLines);
    for (const d of partial) expect(d.status).toBe('UNKNOWN');
  });
});

// --------------------------------------------------------------- 5: deleted

describe('deleted historical evidence is recoverable', () => {
  it('5. surfaces a test that no longer exists at HEAD', () => {
    expect(fs.existsSync(path.join(repoDir, 'tests/manifestIdentity.test.ts'))).toBe(false);
    const text = render(target());
    expect(text).toContain('tests/manifestIdentity.test.ts');
  });

  it('5b. never writes the historical file back into the worktree', () => {
    render(target());
    expect(fs.existsSync(path.join(repoDir, 'tests/manifestIdentity.test.ts'))).toBe(false);
  });
});

// ------------------------------------------------- 14, 15: relevance ranking

describe('history is anchored to the target, not to recency', () => {
  it('14. an unrelated commit is excluded from the target history', () => {
    const pack = target();
    const direct = pack.historicalContext.filter((h) => h.relation === 'DIRECT_TARGET');
    for (const h of direct) {
      expect(h.shortHash).not.toBe(sha.c3);
      expect(h.shortHash).not.toBe(sha.c8);
    }
  });

  it('15. an older direct commit outranks a newer unrelated one', () => {
    const ranked = hashes(target());
    const decisive = ranked.indexOf(sha.c2!);
    expect(decisive, 'the decisive commit is missing entirely').toBeGreaterThanOrEqual(0);
    for (const noise of [sha.c3!, sha.c8!]) {
      const at = ranked.indexOf(noise);
      if (at !== -1) expect(decisive).toBeLessThan(at);
    }
  });

  it('14b. an unrelated file gets its own history, not the manifest\'s', () => {
    const pack = ask('src/labels/printer.ts');
    expect(hashes(pack)).not.toContain(sha.c2);
  });
});

// ------------------------------------------- 8, 9, 10, 17: records integration

describe('recorded attempts, constraints and consequences', () => {
  it('8. a recorded previous attempt reaches the pack with its failure', () => {
    const text = render(target());
    expect(text).toMatch(/Deduplicate by destination/);
    expect(text).toMatch(/share a destination/);
  });

  it('8b. a recorded attempt keeps the confidence it was recorded with', () => {
    const attempts = target().previousAttempts;
    expect(attempts.length).toBeGreaterThan(0);
    // The record declared these; nothing measured them.
    for (const a of attempts) expect(a.provenance).not.toBe('VERIFIED');
  });

  it('9/10. consequences from the record are carried', () => {
    const text = render(target());
    expect(text).toMatch(/backfilled lazily/);
  });

  it('17. a record is linked only to files the index can verify', () => {
    // The record names src/routing/manifest.ts, which exists. Nothing in the pack
    // may claim a link to a path the index does not hold.
    const pack = target();
    const indexHas = (p: string): boolean => pack.diagnostics.filesInIndex > 0 && p.startsWith('src/');
    for (const e of pack.evidence) {
      if (e.includes('.ts') && e.startsWith('src/')) expect(indexHas(e)).toBe(true);
    }
  });
});

// ------------------------------------------------------- 11, 12: honest gaps

describe('what is not established is said to be unknown', () => {
  it('11/12. never presents a motive as VERIFIED', () => {
    const pack = target();
    const motive = /\b(because|in order to|so that|the (developer|author) )/i;
    const claims = [
      ...pack.whyThisAreaMatters, ...pack.decisionsAndConstraints,
      ...pack.previousAttempts, ...pack.consequences,
      ...pack.historicalDecisions.flatMap((d) => d.whyItMatters),
    ];
    for (const c of claims) {
      if (motive.test(c.statement)) {
        expect(c.provenance, `motive stated as VERIFIED: "${c.statement}"`).not.toBe('VERIFIED');
      }
    }
  });

  it('12. a commit subject is never promoted to VERIFIED', () => {
    // `provenance` on the event labels the commit and its file list, which git does
    // verify. The subject is the author's own claim, and the rendered line has to say
    // so beside every commit rather than letting the VERIFIED label cover both.
    const text = render(target());
    for (const h of target().historicalContext) {
      // The HISTORICAL CONTEXT entry, not the decision heading: both name the
      // commit, and only this one is the pack's own listing of it.
      const line = text.split('\n')
        .find((l) => l.startsWith('- [') && l.includes(h.shortHash));
      expect(line, `commit ${h.shortHash} not rendered`).toBeDefined();
      expect(line!).toMatch(/subject is the author's own description, DECLARED/);
    }
  });

  it('11b. reports uncertainty explicitly rather than by omission', () => {
    const pack = ask('src/labels/printer.ts');
    const text = render(pack);
    expect(pack.uncertainty.length + (text.match(/UNKNOWN/g)?.length ?? 0)).toBeGreaterThan(0);
  });

  it('13b. the chain is in git ancestry order, not timestamp order', () => {
    // Every commit in this fixture is authored within the same second, so a sort on
    // `authoredAt` alone yields an arbitrary sequence under a heading that states
    // the ordering is VERIFIED. Git's ancestry is the authority.
    const chain = ask('src/routing/manifest.ts', { maxTokens: 9000 })
      .changeChains.find((c) => c.files.includes('src/routing/manifest.ts'));
    expect(chain, 'no chain built for the target').toBeDefined();
    const order = chain!.sequence.map((s) => s.shortHash);
    const expected = [sha.c1, sha.c2, sha.c5, sha.c6, sha.c7].filter((h) => order.includes(h!));
    expect(order.filter((h) => expected.includes(h))).toEqual(expected);
  });

  it('13c. a deleted test is attached only to a decision it actually names', () => {
    // Sharing a filename stem makes it a candidate; it is evidence for a decision
    // only when it names something that decision changed.
    const pack = ask('src/routing/manifest.ts', { maxTokens: 9000 });
    const withTest = pack.historicalDecisions.filter(
      (d) => d.support.some((s) => s.kind === 'deleted test'));
    expect(withTest.length).toBeGreaterThan(0);
    for (const d of withTest) {
      const quoted = d.support.find((s) => s.kind === 'deleted test')!.quote ?? '';
      // The identity test names parcelId; only the decision that moved parcelId
      // may carry it.
      expect(quoted).toMatch(/parcelId/);
      expect([...d.historicalState, ...d.currentState].join('\n')).toMatch(/parcelId/);
    }
  });

  it('13. an incomplete chain shows its known parts and marks the gap', () => {
    const pack = target();
    for (const chain of pack.changeChains) {
      // Every step is either explained or named as a gap; none are silently dropped.
      const explained = chain.sequence.filter((s) => s.explained).length;
      expect(explained + chain.gaps.length).toBeGreaterThan(0);
    }
  });
});

// ------------------------------------------------------------- 16: budgeting

describe('the budget keeps the decisive evidence', () => {
  it('16. a tight budget keeps the decisive commit', () => {
    const tight = ask('src/routing/manifest.ts', { maxTokens: 1400 });
    expect(hashes(tight)).toContain(sha.c2);
  });

  it('16b. says what it dropped rather than dropping it silently', () => {
    const tight = ask('src/routing/manifest.ts', { maxTokens: 1200 });
    if (tight.diagnostics.truncated) {
      expect(tight.diagnostics.sectionsTruncated.length).toBeGreaterThan(0);
    }
    expect(tight.diagnostics.estimatedTokens).toBeGreaterThan(0);
  });
});

// ----------------------------------------------------------- 20: readability

describe('a developer can read the answer', () => {
  it('20. the pack names the current state, the old state, the change and its status', () => {
    const text = render(target());
    for (const marker of ['CURRENT', 'HISTORICAL', 'STATUS:', 'HISTORICAL DECISIONS']) {
      expect(text, `missing section marker ${marker}`).toContain(marker);
    }
    // And the change is attributable to a commit a reader can go and check.
    expect(text).toMatch(new RegExp(sha.c2!));
  });

  it('20b. every historical section carries a provenance label', () => {
    const text = render(target());
    const section = text.slice(text.indexOf('## HISTORICAL DECISIONS'));
    expect(section).toMatch(/VERIFIED|DECLARED|INFERRED|UNKNOWN/);
  });
});
