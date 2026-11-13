import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { ContextPack } from '../src/context/pack.js';
import { lineCount } from '../src/context/behavior.js';
import { findContradictions, CommitFacts } from '../src/context/contradictions.js';

/**
 * Trust hardening.
 *
 *   1. VERIFIED line counts were one too high for every newline-terminated file.
 *   2. The VERIFIED "Target defines …" list was cut at six with nothing to say so.
 *   3. A record git contradicts was delivered as DECLARED and never flagged.
 *   4. Plain English words ("page", "browser", "app") resolved as HIGH-confidence symbols.
 *   5. Every delivered pack was PARTIAL; a record's absence alone held strong packs there.
 *
 * Repository D, every date fixed:
 *   C1  2026-03-01  adds everything below except the files named in C2–C4
 *   C2  2026-03-02  adds src/nav/trail.ts only ("replace the navbar")
 *   C3  2026-03-03  changes src/ok/clean.ts
 *   C4  2030-01-01  changes src/stale/tariff.ts, after every record was written
 */

const repo = path.join(process.cwd(), '.test_repo_trust');
const sha: Record<string, string> = {};
const short = (label: string): string => sha[label]!.slice(0, 7);
let svc: StrataService;

const git = (args: string[], date?: string): string => execFileSync('git', args, {
  cwd: repo, encoding: 'utf-8',
  env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
});
/** Lines joined with "\n" and, unless told otherwise, a final newline: the common case. */
const write = (rel: string, lines: string[], finalNewline = true): void => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, lines.join('\n') + (finalNewline ? '\n' : ''), 'utf-8');
};
const exportsNamed = (names: string[]): string[] => names.map((n, i) => `export const ${n} = ${i};`);
const ROUTE_EXPORTS = ['SITE_ORIGIN', 'routes', 'projectRoute', 'professionalAnchor', 'PROJECT_SECTIONS', 'homeRoute', 'aboutRoute', 'contactRoute'];

const commit = (label: string, msg: string, date: string): void => {
  git(['add', '-A']);
  git(['commit', '-q', '-m', msg], date);
  sha[label] = git(['rev-parse', 'HEAD']).trim();
};

const defines = (p: ContextPack): string | undefined =>
  p.whyThisAreaMatters.find((s) => s.statement.startsWith('Target defines'))?.statement;
const behaviorOf = (p: ContextPack, file: string) => p.currentBehavior.find((b) => b.file === file);
const ap = (p: ContextPack) => p.applicability!;
const briefs = (p: ContextPack): string[] => ap(p).findings.filter((f) => f.decisive).map((f) => f.brief);

beforeAll(() => {
  if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Fixture Author']);
  git(['config', 'core.autocrlf', 'false']);

  write('src/lines/withNewline.ts', ['export const ONE = 1;', 'export const TWO = 2;', 'export const THREE = 3;']);
  write('src/lines/noNewline.ts', ['export const ONE = 1;', 'export const TWO = 2;', 'export const THREE = 3;'], false);
  write('src/surface/routes.ts', exportsNamed(ROUTE_EXPORTS));
  write('src/surface/small.ts', exportsNamed(['alpha', 'beta', 'gamma']));
  write('src/rng/rng.ts', [
    'export function createRng(seed: number): () => number {',
    '  let s = seed;',
    '  return () => (s = (s * 16807) % 2147483647) / 2147483647;',
    '}',
    'export function seedFrom(label: string): number {',
    '  return [...label].reduce((h, c) => h * 31 + c.charCodeAt(0), 7);',
    '}',
  ]);
  write('src/ok/clean.ts', ['export const CLEAN_LIMIT = 10;']);
  write('src/stale/tariff.ts', ['export const TARIFF_CAP = 50;']);
  // "page" and "browser" spell declarations here that nothing exports: a probe script's locals.
  write('scripts/probe.mjs', ['const page = "/";', 'const browser = "chromium";', 'export function runProbe() {', '  return page + browser;', '}']);
  write('src/web/render.ts', ['export function renderPage(): string {', "  return '<main></main>';", '}']);
  // "stop" is a plain word that is also an exported function's name.
  write('src/audio/control.ts', ['export function stop(): number {', '  return 0;', '}']);
  commit('C1', 'add the modules', '2026-03-01T10:00:00Z');

  write('src/nav/trail.ts', ['export const CHECKPOINTS = 7;']);
  commit('C2', 'replace the navbar', '2026-03-02T10:00:00Z');

  write('src/ok/clean.ts', ['export const CLEAN_LIMIT = 10;', 'export const CLEAN_FLOOR = 1;']);
  commit('C3', 'clean gets a floor', '2026-03-03T10:00:00Z');

  write('src/stale/tariff.ts', ['export const TARIFF_CAP = 60;']);
  commit('C4', 'raise the tariff cap', '2030-01-01T10:00:00Z');

  // Never committed: two data files that only the request's words reach, equally.
  write('data/quokkaTallyOne.json', ['{ "quokka": 1 }']);
  write('data/quokkaTallyTwo.json', ['{ "quokka": 2 }']);

  svc = new StrataService(repo);
  svc.init();
  svc.indexCode();

  const record = (id: string, file: string, intent: string): void => {
    svc.recordChange({
      id, title: `${id} title`, intent, intentConfidence: 'DECLARED',
      files: [{ path: file, changeType: 'modify', symbols: [] }],
      evidence: [],
      result: { status: 'success' },
    } as Parameters<StrataService['recordChange']>[0]);
  };
  // True: C1 and C3 did change clean.ts.
  record('REC-CLEAN', 'src/ok/clean.ts', `src/ok/clean.ts was created in ${short('C1')} and given a floor in ${short('C3')}.`);
  // False, and git can say so: C2 changed only src/nav/trail.ts.
  record('REC-RNG', 'src/rng/rng.ts', `src/rng/rng.ts was rewritten in ${short('C2')} to replace the generator with Math.random().`);
  // True when written; C4 (dated 2030) changes the file afterwards.
  record('REC-TARIFF', 'src/stale/tariff.ts', `src/stale/tariff.ts caps tariffs at fifty, set in ${short('C1')}.`);
}, 240_000);

afterAll(() => {
  svc?.close();
  if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
});

// ------------------------------------------------------------------ 1. line counts

describe('1. VERIFIED line counts match the file', () => {
  it('counts lines, not the empty element after a final newline', () => {
    expect(lineCount([''])).toBe(0);                 // empty file
    expect(lineCount(['a'])).toBe(1);                // "a"
    expect(lineCount(['a', ''])).toBe(1);            // "a\n"
    expect(lineCount(['a', 'b', 'c'])).toBe(3);      // "a\nb\nc"
    expect(lineCount(['a', 'b', 'c', ''])).toBe(3);  // "a\nb\nc\n"
    expect(lineCount(['a', '', ''])).toBe(2);        // "a\n\n": the blank line is a line
  });

  it('a newline-terminated file and the same file without the newline both report 3, VERIFIED', () => {
    for (const file of ['src/lines/withNewline.ts', 'src/lines/noNewline.ts']) {
      // One pack per file, read for both assertions: building it is the expensive part.
      const p = svc.getContextPack(file);
      const b = behaviorOf(p, file)!;
      expect([file, b.totalLines, b.provenance]).toEqual([file, 3, 'VERIFIED']);
      expect(svc.renderContextPack(p)).toContain(`- ${file} — 3 lines, exports:`);
    }
  });

  it('mutation: adding or removing the final newline changes nothing; adding a blank line adds one', () => {
    const file = 'src/lines/noNewline.ts';
    const body = ['export const ONE = 1;', 'export const TWO = 2;', 'export const THREE = 3;'];
    try {
      write(file, body, true);
      expect(behaviorOf(svc.getContextPack(file), file)!.totalLines).toBe(3);
      write(file, [...body, ''], true);
      expect(behaviorOf(svc.getContextPack(file), file)!.totalLines).toBe(4);
      write('src/lines/withNewline.ts', body, false);
      expect(behaviorOf(svc.getContextPack('src/lines/withNewline.ts'), 'src/lines/withNewline.ts')!.totalLines).toBe(3);
    } finally {
      write(file, body, false);
      write('src/lines/withNewline.ts', body, true);
    }
  });

  it('the line count agrees with the newline count for a newline-terminated file', () => {
    const file = 'src/rng/rng.ts';
    const bytes = fs.readFileSync(path.join(repo, file), 'utf-8');
    const newlines = (bytes.match(/\n/g) ?? []).length;
    expect(bytes.endsWith('\n')).toBe(true);
    expect(behaviorOf(svc.getContextPack(file), file)!.totalLines).toBe(newlines);
  });
});

// ------------------------------------------------------------------ 2. export list

describe('2. the VERIFIED export list is complete or says what it leaves out', () => {
  it('a surface longer than the list states the full count and how many are not listed', () => {
    const s = defines(svc.getContextPack('src/surface/routes.ts'))!;
    expect(s).toBe(`Target defines 8 exported symbols; 6 listed here, 2 not listed: ${ROUTE_EXPORTS.slice(0, 6).join(', ')}.`);
    const statement = svc.getContextPack('src/surface/routes.ts').whyThisAreaMatters.find((x) => x.statement === s)!;
    expect(statement.provenance).toBe('VERIFIED');
  });

  it('a surface that fits is listed whole, with no omission marker', () => {
    expect(defines(svc.getContextPack('src/surface/small.ts'))).toBe('Target defines alpha, beta, gamma.');
  });

  it('mutation: 6 exports fit exactly; 7 leave one out, and say so', () => {
    const file = 'src/surface/routes.ts';
    try {
      write(file, exportsNamed(ROUTE_EXPORTS.slice(0, 6)));
      svc.indexCode();
      expect(defines(svc.getContextPack(file))).toBe(`Target defines ${ROUTE_EXPORTS.slice(0, 6).join(', ')}.`);
      write(file, exportsNamed(ROUTE_EXPORTS.slice(0, 7)));
      svc.indexCode();
      expect(defines(svc.getContextPack(file)))
        .toBe(`Target defines 7 exported symbols; 6 listed here, 1 not listed: ${ROUTE_EXPORTS.slice(0, 6).join(', ')}.`);
    } finally {
      write(file, exportsNamed(ROUTE_EXPORTS));
      svc.indexCode();
    }
    expect(defines(svc.getContextPack(file))).toContain('8 exported symbols');
  });
});

// ------------------------------------------------------------------ 3. contradicted records

describe('3. a record git contradicts is marked, not trusted, and not rewritten', () => {
  const facts: Record<string, CommitFacts> = {
    aaaa111: { shortHash: 'aaaa111', changedFiles: ['lib/map/rng.ts'] },
    bbbb222: { shortHash: 'bbbb222', changedFiles: ['components/navigation/Navigation.tsx'] },
    cccc333: { shortHash: 'cccc333', changedFiles: [] }, // a merge: no file list
  };
  const lookup = (h: string): CommitFacts | null => facts[h.slice(0, 7)] ?? null;
  const check = (text: string, files = ['lib/map/rng.ts']) => findContradictions([text], files, lookup);

  it('flags a sentence naming a commit with a file that commit did not change', () => {
    const found = check('lib/map/rng.ts was rewritten in bbbb222 to use Math.random().');
    expect(found.map((c) => [c.commit, c.files, c.changed])).toEqual([['bbbb222', ['lib/map/rng.ts'], ['components/navigation/Navigation.tsx']]]);
  });

  it('reads a bare file name as the record\'s own file', () => {
    expect(check('rng.ts gained a third export in bbbb222.').map((c) => c.files)).toEqual([['rng.ts']]);
  });

  it('mutation: the same sentence with the commit that did change the file is not flagged', () => {
    expect(check('lib/map/rng.ts was rewritten in aaaa111 to use Math.random().')).toEqual([]);
  });

  it('does not flag what git cannot settle', () => {
    // A commit the store does not hold is UNKNOWN, not contradicted.
    expect(check('lib/map/rng.ts was rewritten in 1234abc.')).toEqual([]);
    // A commit with no file list (a merge) is not evidence against anything.
    expect(check('lib/map/rng.ts was merged in cccc333.')).toEqual([]);
    // No file named: no claim about a file.
    expect(check('bbbb222 replaced the navbar.')).toEqual([]);
    // A URL is not a file.
    expect(check('See https://example.com/lib/map/rng.ts about bbbb222.')).toEqual([]);
    // A claim about what a commit did to a file it did touch is beyond a file list.
    expect(check('lib/map/rng.ts stopped using mulberry32 in aaaa111.')).toEqual([]);
    // A word made of hex letters is not a commit.
    expect(check('lib/map/rng.ts was defaced in a decade.')).toEqual([]);
  });

  it('a commit cited beside a file is not a claim that the commit changed it', () => {
    // From a real, correct record: the commit's message and the file's comment are two sources.
    expect(check('Three attempts failed (stated in bbbb222 and in the comment in lib/map/rng.ts).')).toEqual([]);
    expect(check('See bbbb222 and lib/map/rng.ts for the discussion.')).toEqual([]);
    // Mutation: the same commit and file, now credited with a change, in either voice.
    expect(check('bbbb222 (2026-09-16) rewrote lib/map/rng.ts.').map((c) => c.commit)).toEqual(['bbbb222']);
    expect(check('lib/map/rng.ts was replaced by bbbb222.').map((c) => c.commit)).toEqual(['bbbb222']);
  });

  it('in the agent pack: marked first, the record\'s words kept, its provenance kept', () => {
    const p = svc.getContextPack('src/rng/rng.ts');
    const intent = p.decisionsAndConstraints.find((s) => s.statement.startsWith('[REC-RNG]'))!;
    expect(intent.statement).toContain(`CONTRADICTED by git (VERIFIED): it names ${short('C2')} with src/rng/rng.ts; ` +
      `git shows ${short('C2')} did not change it (it changed src/nav/trail.ts)`);
    expect(intent.statement).toContain(`src/rng/rng.ts was rewritten in ${short('C2')} to replace the generator with Math.random().`);
    expect(intent.statement.indexOf('CONTRADICTED')).toBeLessThan(intent.statement.indexOf('was rewritten'));
    expect(intent.provenance).toBe('DECLARED'); // not promoted, not demoted
  });

  it('in applicability: a contradicted record about the target holds the pack below SUPPORTED, and decides it', () => {
    const p = svc.getContextPack('src/rng/rng.ts');
    expect(ap(p).classification).toBe('PARTIAL');
    const f = ap(p).findings.find((x) => x.brief === `REC-RNG contradicted by git (${short('C2')})`)!;
    expect([f.facet, f.effect, f.label, f.decisive]).toEqual(['memory', 'limit', 'VERIFIED', true]);
  });

  it('in the human view: reported above the record, which is quoted unchanged', () => {
    const { text } = svc.humanView('src/rng/rng.ts', 'explain');
    expect(text).toContain(`  CONTRADICTED by git (VERIFIED): the record names ${short('C2')} with src/rng/rng.ts; ` +
      `${short('C2')} changed none of it (it changed src/nav/trail.ts).`);
    expect(text.indexOf('CONTRADICTED by git')).toBeLessThan(text.indexOf(`    "src/rng/rng.ts was rewritten in ${short('C2')}`));
  });

  it('the stored record is untouched', () => {
    const rec = svc.getRecord('REC-RNG')!;
    expect(rec.intent).toBe(`src/rng/rng.ts was rewritten in ${short('C2')} to replace the generator with Math.random().`);
    expect(rec.intentConfidence).toBe('DECLARED');
  });

  it('a true record is not flagged anywhere', () => {
    const p = svc.getContextPack('src/ok/clean.ts');
    expect(p.decisionsAndConstraints.some((s) => s.statement.includes('CONTRADICTED'))).toBe(false);
    expect(svc.humanView('src/ok/clean.ts', 'explain').text).not.toContain('CONTRADICTED');
  });

  it('a later Git change to a record\'s file is still reported as staleness, and holds the pack at PARTIAL', () => {
    const p = svc.getContextPack('src/stale/tariff.ts');
    expect(ap(p).classification).toBe('PARTIAL');
    expect(briefs(p)).toContain(`REC-TARIFF predates ${short('C4')}`);
    expect(p.decisionsAndConstraints.some((s) => s.statement.includes('CONTRADICTED'))).toBe(false);
  });
});

// ------------------------------------------------------------------ 4. false symbol matches

describe('4. plain words do not resolve as HIGH-confidence symbols', () => {
  const symbolAnchors = (p: ContextPack) => (p.target.anchors ?? []).filter((a) => a.kind === 'explicit_symbol');

  it('a plain word spelling only a file-local declaration does not anchor at all', () => {
    const p = svc.getContextPack('What does the page show before the browser paints?');
    expect(symbolAnchors(p)).toEqual([]);
    expect(p.target.confidence.level).not.toBe('HIGH');
    expect((p.target.anchors ?? []).some((a) => a.file === 'scripts/probe.mjs' && a.kind !== 'lexical')).toBe(false);
  });

  it('mutation: replace the plain word with the real code-shaped symbol, and it resolves exactly, HIGH', () => {
    const p = svc.getContextPack('What does renderPage show before the browser paints?');
    expect(symbolAnchors(p).map((a) => [a.file, a.matched, a.plainWord ?? false])).toEqual([['src/web/render.ts', 'renderPage', false]]);
    expect(p.target.confidence.level).toBe('HIGH');
  });

  it('a plain word that names an exported symbol still anchors, graded MEDIUM, not HIGH', () => {
    const p = svc.getContextPack('What happens when playback should stop?');
    expect(symbolAnchors(p).map((a) => [a.file, a.matched, a.plainWord])).toEqual([['src/audio/control.ts', 'stop', true]]);
    expect(p.target.confidence.level).toBe('MEDIUM');
    expect(ap(p).classification).not.toBe('SUPPORTED');
  });

  it('explicit symbol behaviour is unchanged: backticks, the whole request, and --symbol', () => {
    for (const p of [
      svc.getContextPack('What does `page` hold?'),
      svc.getContextPack('page'),
      svc.getContextPack('page', { targetType: 'symbol' }),
    ]) {
      expect(symbolAnchors(p).map((a) => [a.file, a.matched, a.plainWord ?? false])).toEqual([['scripts/probe.mjs', 'page', false]]);
      expect(p.target.confidence.level).toBe('HIGH');
    }
  });

  it('a one-word clause of a longer request is not the whole request', () => {
    const p = svc.getContextPack('explain the layout and page');
    expect(symbolAnchors(p)).toEqual([]);
  });

  it('a code-shaped name still outranks a plain word beside it', () => {
    const p = svc.getContextPack('Why should stop wait for createRng?');
    expect(symbolAnchors(p).map((a) => a.matched)).toEqual(['createRng']);
    expect(p.target.confidence.level).toBe('HIGH');
  });

  it('explicit paths are unchanged', () => {
    const p = svc.getContextPack('Look at scripts/probe.mjs and its page');
    expect(p.target.anchors?.[0]).toMatchObject({ file: 'scripts/probe.mjs', kind: 'explicit_path' });
    expect(p.target.confidence.level).toBe('HIGH');
  });
});

// ------------------------------------------------------------------ 5. applicability distribution

describe('5. applicability: strong evidence can be SUPPORTED, weak evidence cannot', () => {
  it('strong, with a current record: SUPPORTED', () => {
    const p = svc.getContextPack('src/ok/clean.ts');
    expect(ap(p).classification).toBe('SUPPORTED');
    expect(briefs(p)).toContain('REC-CLEAN on it (DECLARED)');
  });

  it('strong, with no record: SUPPORTED, and the missing record is reported as UNKNOWN beside the class', () => {
    const p = svc.getContextPack('src/surface/small.ts');
    expect(ap(p).classification).toBe('SUPPORTED');
    expect(ap(p).rule).toContain('no record is about it');
    const memory = ap(p).findings.filter((f) => f.facet === 'memory');
    expect(memory.map((f) => [f.brief, f.label, f.decisive])).toEqual([['no record on it (UNKNOWN)', 'UNKNOWN', false]]);
    expect(svc.renderAgentContext(p)).toMatch(/## APPLICABILITY: SUPPORTED\n[^\n]*\n(- [^\n]*\n)*- also: [^\n]*no record on it \(UNKNOWN\)/);
  });

  it('partial: a contradicted record, a stale record, a plain-word target', () => {
    expect(ap(svc.getContextPack('src/rng/rng.ts')).classification).toBe('PARTIAL');
    expect(ap(svc.getContextPack('src/stale/tariff.ts')).classification).toBe('PARTIAL');
    expect(ap(svc.getContextPack('What happens when playback should stop?')).classification).toBe('PARTIAL');
  });

  it('low value: matched by wording only, with nothing VERIFIED about the match', () => {
    const p = svc.getContextPack('quokka tally');
    expect(p.target.confidence.level).toBe('LOW');
    expect(ap(p).classification).toBe('LOW VALUE');
  });

  it('not applicable: nothing matches, or a named path the index does not hold', () => {
    expect(ap(svc.getContextPack('zeppelin flux capacitor')).classification).toBe('NOT APPLICABLE');
    expect(ap(svc.getContextPack('src/nope/missing.ts')).classification).toBe('NOT APPLICABLE');
  });
});
