import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import { StrataService } from '../src/records/service.js';
import { StrataMCPHandler } from '../src/mcp/server.js';
import { registerContextCommand } from '../src/cli/commands/context.js';
import { registerExplainCommand } from '../src/cli/commands/explain.js';
import { registerHistoryCommand } from '../src/cli/commands/history.js';
import {
  buildPromptContext, budgetForInline, CONTEXT_HEADER, INLINE_CONTEXT_LIMIT, INLINE_MARGIN,
} from '../src/integrations/claude-hook.js';
import { ContextPack, estimateTokens } from '../src/context/pack.js';
import { ContextOptions } from '../src/context/engine.js';
import { renderHuman, HumanView } from '../src/context/human.js';
import { renderApplicabilityBlock, ApplicabilityFinding } from '../src/context/applicability.js';

/**
 * Applicability — how far a pack can answer its request, stated rather than left to be
 * inferred from which sections happen to be full.
 *
 * Three repositories.
 *
 *   A  git history and records
 *        src/core/ledger.ts    two commits, both still whole at HEAD; REC-LEDGER, current   → SUPPORTED
 *        src/core/rates.ts     two commits, settled; no record                             → history, no memory
 *        src/core/fresh.ts     never committed                                             → no history
 *        src/core/tariff.ts    REC-TARIFF, then a later commit to it (dated 2030)          → stale record
 *        src/core/volatile.ts  three changes, each partly rewriting the one before         → UNKNOWN decisions
 *        src/core/mixed.ts     REC-MIXED (DECLARED) and REC-TMIXED (derived, INFERRED)     → mixed evidence
 *        src/core/heavy.ts     REC-HEAVY: seventeen claims about one small file            → claims outnumber
 *        config/limits.yaml    a data file with history                                    → not parsed
 *        styles/site.css       a file type the index does not cover                        → not indexed
 *        src/many/             seven files, more than the resolver's ceiling of five       → scope cut
 *                              (never committed, so building its packs asks git little)
 *        scripts/roundTotals*  matched by words; committed, nothing exported               → weak, own evidence
 *        data/tallyNumbers*    matched by words; data files, never committed; REC-TALLY    → weak, memory only
 *   B  git history, and a store with no records at all
 *   C  no git history at all, and no records
 */

const repoA = path.join(process.cwd(), '.test_repo_applicability');
const repoB = path.join(process.cwd(), '.test_repo_applicability_nomem');
const repoC = path.join(process.cwd(), '.test_repo_applicability_nohist');
const sha: Record<string, string> = {};
const short = (label: string): string => sha[label]!.slice(0, 7);

const gitIn = (dir: string) => (args: string[], date?: string): string => execFileSync('git', args, {
  cwd: dir, encoding: 'utf-8',
  env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
});
const writeIn = (dir: string) => (rel: string, lines: string[]): void => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, lines.join('\n') + '\n', 'utf-8');
};
const fresh = (dir: string): void => {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const git = gitIn(dir);
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Fixture Author']);
  git(['config', 'core.autocrlf', 'false']);
};

let a: StrataService;
let b: StrataService;
let c: StrataService;

// Every pack the matrix reads is built once, before the tests, and the tests only assert.
type Query = [StrataService, string, ContextOptions?];
const packs = new Map<string, ContextPack>();
const again = new Map<string, ContextPack>();
const humans = new Map<string, { pack: ContextPack; text: string }>();
const key = (svc: StrataService, q: string, opts: ContextOptions = {}): string =>
  `${svc.getRepoRoot()}|${q}|${JSON.stringify(opts)}`;
const pack = (svc: StrataService, q: string, opts: ContextOptions = {}): ContextPack => {
  const k = key(svc, q, opts);
  if (!packs.has(k)) packs.set(k, svc.getContextPack(q, opts));
  return packs.get(k)!;
};
const human = (svc: StrataService, q: string, view: HumanView = 'explain'): { pack: ContextPack; text: string } => {
  const k = `${key(svc, q)}|${view}`;
  if (!humans.has(k)) humans.set(k, svc.humanView(q, view));
  return humans.get(k)!;
};

const ap = (p: ContextPack) => p.applicability!;
const decisive = (p: ContextPack): ApplicabilityFinding[] => ap(p).findings.filter((f) => f.decisive);
const briefs = (p: ContextPack): string[] => decisive(p).map((f) => f.brief);
/** The agent text with the applicability block taken out. */
const withoutBlock = (text: string): string => {
  const start = text.indexOf('\n## APPLICABILITY: ') + 1;
  if (start === 0) return text;
  return text.slice(0, start) + text.slice(text.indexOf('\n\n', start) + 2);
};
const blockOf = (svc: StrataService, p: ContextPack): string[] => {
  const text = svc.renderAgentContext(p);
  const start = text.indexOf('\n## APPLICABILITY: ') + 1;
  return text.slice(start, text.indexOf('\n\n', start)).split('\n');
};
/** The human view with the APPLICABILITY section taken out. */
const withoutSection = (text: string): string => {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('APPLICABILITY — '));
  if (at < 0) return text;
  const next = lines.findIndex((l, i) => i > at && l === '');
  return [...lines.slice(0, at - 1), ...lines.slice(next)].join('\n');
};
const CAUSAL = /\bbecause\b|\bdue to\b|\bin order to\b|\bso that\b|\bled to\b|\bcaused\b|\bto fix\b|\bmotivat/i;

let MATRIX: Query[] = [];
let AGAIN: Query[] = [];
// One of each class in the human views, and the ones the matrix reads. Targets with little
// history where the class allows it: every pack build here competes with the rest of the suite
// for git processes, and a pack with history costs several times one without.
const HUMAN_QUERIES = ['src/core/ledger.ts', 'tally numbers', 'src/many/', 'src/core/fresh.ts', 'src/core/doesNotExist.ts'];
const HISTORY_QUERIES = ['src/core/ledger.ts', 'src/core/doesNotExist.ts'];

beforeAll(() => {
  // ---------------------------------------------------------------- repository A
  fresh(repoA);
  const git = gitIn(repoA);
  const write = writeIn(repoA);
  // Hashes are read once, after the last commit, rather than one git process per commit:
  // every process started here competes with the rest of the suite's.
  const labels = new Map<string, string>();
  const commit = (label: string, msg: string, date: string): void => {
    git(['add', '-A']);
    git(['commit', '-q', '-m', msg], date);
    labels.set(msg, label);
  };

  write('src/core/ledger.ts', [
    'export const LEDGER_VERSION = 1;',
    '',
    'export function post(entries: number[], amount: number): number[] {',
    '  return [...entries, amount];',
    '}',
  ]);
  commit('L1', 'create the ledger', '2026-01-01T10:00:00Z');

  write('src/core/checkout.ts', [
    "import { post, balance } from './ledger';",
    "import { rateFor } from './rates';",
    'export function checkout(entries: number[], amount: number): number {',
    '  return balance(post(entries, amount * rateFor(amount)));',
    '}',
  ]);
  write('src/core/rates.ts', [
    'export const BASE_RATE = 1;',
    'export function rateFor(amount: number): number {',
    '  return amount > 100 ? BASE_RATE * 0.9 : BASE_RATE;',
    '}',
  ]);
  commit('R1', 'checkout posts to the ledger at the current rate', '2026-01-02T10:00:00Z');

  write('src/core/ledger.ts', [
    'export const LEDGER_VERSION = 1;',
    '',
    'export function post(entries: number[], amount: number): number[] {',
    '  return [...entries, amount];',
    '}',
    '',
    'export function balance(entries: number[]): number {',
    '  return entries.reduce((sum, e) => sum + e, 0);',
    '}',
  ]);
  commit('L2', 'ledger balance sums the posted entries', '2026-01-03T10:00:00Z');

  write('src/core/rates.ts', [
    'export const BASE_RATE = 1;',
    'export function rateFor(amount: number): number {',
    '  return amount > 100 ? BASE_RATE * 0.9 : BASE_RATE;',
    '}',
    'export const RATE_STEP = 2;',
  ]);
  // Its words appear in no path and no symbol: only this message carries them.
  commit('R2', 'tidy the quokka formatter', '2026-01-04T10:00:00Z');

  write('src/core/tariff.ts', [
    'export const TARIFF_CAP = 50;',
    'export function tariff(amount: number): number {',
    '  return Math.min(amount, TARIFF_CAP);',
    '}',
  ]);
  commit('T1', 'cap tariffs at fifty', '2026-01-05T10:00:00Z');

  // Three changes, each partly rewriting the one before: only the last one settles.
  const modes = (x: number, y: number): string[] => [
    `export const MODE_A = ${x};`,
    `export const MODE_B = ${y};`,
    'export const MODE_C = 3;',
    'export function mode(n: number): number {',
    '  return n > 0 ? MODE_A : MODE_B;',
    '}',
  ];
  write('src/core/volatile.ts', modes(1, 2));
  commit('V1', 'volatile modes', '2026-01-06T10:00:00Z');
  write('src/core/volatile.ts', modes(11, 22));
  commit('V2', 'volatile modes, second pass', '2026-01-07T10:00:00Z');
  write('src/core/volatile.ts', modes(111, 22));
  commit('V3', 'volatile modes, third pass', '2026-01-08T10:00:00Z');

  write('src/core/mixed.ts', [
    'export const MIXED_LIMIT = 3;',
    'export function mixed(n: number): number { return Math.min(n, MIXED_LIMIT); }',
  ]);
  commit('M1', 'mixed limit', '2026-01-09T10:00:00Z');
  write('src/core/mixed.ts', [
    'export const MIXED_LIMIT = 3;',
    'export function mixed(n: number): number { return Math.min(n, MIXED_LIMIT); }',
    'export function mixedTwice(n: number): number { return mixed(mixed(n)); }',
  ]);
  commit('M2', 'mixed twice', '2026-01-10T10:00:00Z');

  write('config/limits.yaml', ['limits:', '  tariff: 50', '  ledger: 1000']);
  commit('Y1', 'limits configuration', '2026-01-11T10:00:00Z');
  write('config/limits.yaml', ['limits:', '  tariff: 60', '  ledger: 1000']);
  commit('Y2', 'raise the tariff limit', '2026-01-12T10:00:00Z');

  write('styles/site.css', ['body { margin: 0; }']);
  commit('S1', 'site stylesheet', '2026-01-13T10:00:00Z');

  write('scripts/roundTotalsAlpha.ts', ['const roundTotalsAlpha = 1;', 'console.log(roundTotalsAlpha);']);
  write('scripts/roundTotalsBeta.ts', ['const roundTotalsBeta = 2;', 'console.log(roundTotalsBeta);']);
  commit('RT', 'print the round totals', '2026-01-15T10:00:00Z');

  write('src/core/heavy.ts', ['export function heavy(n: number): number { return n * 2; }']);
  commit('H1', 'heavy doubles', '2026-01-16T10:00:00Z');

  // Dated after the record about tariff.ts is written, so that record describes older code.
  write('src/core/tariff.ts', [
    'export const TARIFF_CAP = 60;',
    'export function tariff(amount: number): number {',
    '  return Math.min(amount, TARIFF_CAP);',
    '}',
  ]);
  commit('T2', 'raise the tariff cap to sixty', '2030-01-01T10:00:00Z');
  // Every message above is distinct, so each names one commit.
  for (const line of git(['log', '--format=%H%x09%s']).trim().split('\n')) {
    const [hash, subject] = line.split('\t');
    const label = labels.get(subject!);
    if (label) sha[label] = hash!;
  }

  // In the working tree and the index, never committed.
  write('src/core/fresh.ts', ['export function freshStart(): number { return 0; }']);
  for (let i = 1; i <= 7; i++) write(`src/many/part${i}.ts`, [`export const PART_${i} = ${i};`]);
  write('data/tallyNumbersOne.json', ['{ "tally": 1 }']);
  write('data/tallyNumbersTwo.json', ['{ "tally": 2 }']);

  a = new StrataService(repoA);
  a.init();
  a.indexCode();
  const record = (id: string, file: string, intent: string, extra: Record<string, unknown> = {}): void => {
    a.recordChange({
      id, title: `${id} title`, intent, intentConfidence: 'DECLARED',
      files: [{ path: file, changeType: 'modify', symbols: [] }],
      evidence: [{ type: 'git_commit', reference: sha['L2']! }],
      result: { status: 'success' },
      ...extra,
    } as Parameters<StrataService['recordChange']>[0]);
  };
  record('REC-LEDGER', 'src/core/ledger.ts', 'The ledger keeps every posted entry and sums them for the balance.');
  record('REC-TARIFF', 'src/core/tariff.ts', 'Tariffs are capped at fifty.');
  record('REC-VOLATILE', 'src/core/volatile.ts', 'The modes were tuned three times.');
  record('REC-MIXED', 'src/core/mixed.ts', 'Mixed values are limited to three.');
  record('REC-TALLY', 'data/tallyNumbersOne.json', 'The tally files hold the numbers to tally.', {
    files: [
      { path: 'data/tallyNumbersOne.json', changeType: 'add', symbols: [] },
      { path: 'data/tallyNumbersTwo.json', changeType: 'add', symbols: [] },
    ],
  });
  record('REC-HEAVY', 'src/core/heavy.ts', 'Heavy doubles its input.', {
    constraints: [1, 2, 3, 4, 5].map((i) => ({ statement: `Heavy constraint ${i}.`, confidence: 'DECLARED', status: 'ACTIVE' })),
    consequences: [1, 2, 3, 4, 5, 6].map((i) => ({ statement: `Heavy consequence ${i}.`, confidence: 'DECLARED', evidence: [] })),
    attempts: [1, 2, 3, 4, 5, 6].map((i) => ({ approach: `Heavy attempt ${i}`, status: 'failed', confidence: 'DECLARED' })),
  });
  a.saveDerivedRecord({
    id: 'REC-TMIXED', title: 'mixed.ts: 1 change attempt in an agent session', intent: 'Make mixed apply twice.',
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/core/mixed.ts', changeType: 'modify', symbols: ['mixedTwice'] }],
    attempts: [{ approach: 'Apply mixed twice', status: 'failed', failureReason: 'tests failed', confidence: 'INFERRED' }],
    evidence: [{ type: 'git_commit', reference: sha['M2']! }],
    result: { status: 'partial' },
  } as Parameters<StrataService['saveDerivedRecord']>[0], { observedAt: Date.now() });

  // ---------------------------------------------------------------- repository B: history, no records
  fresh(repoB);
  const gitB = gitIn(repoB);
  const writeB = writeIn(repoB);
  writeB('src/app/service.ts', ['export function serve(): number { return 1; }']);
  writeB('src/app/main.ts', ["import { serve } from './service';", 'export const started = serve();']);
  gitB(['add', '-A']);
  gitB(['commit', '-q', '-m', 'serve'], '2026-02-01T10:00:00Z');
  writeB('src/app/service.ts', ['export function serve(): number { return 1; }', 'export function stop(): number { return 0; }']);
  gitB(['add', '-A']);
  gitB(['commit', '-q', '-m', 'stop'], '2026-02-02T10:00:00Z');
  b = new StrataService(repoB);
  b.init();
  b.indexCode();

  // ---------------------------------------------------------------- repository C: no history at all
  fresh(repoC);
  const writeC = writeIn(repoC);
  writeC('src/app/tool.ts', ['export function tool(): number { return 1; }']);
  writeC('src/app/cli.ts', ["import { tool } from './tool';", 'export const ran = tool();']);
  c = new StrataService(repoC);
  c.init();
  c.indexCode();

  MATRIX = [
    [a, 'src/core/ledger.ts'], [a, 'tally numbers'], [a, 'round totals scripts'],
    [a, 'quantum flux capacitor'], [a, 'tuned three times'], [a, 'src/core/fresh.ts'],
    [b, 'src/app/service.ts'], [a, 'src/core/rates.ts'],
    [a, 'src/core/ledger.ts', { maxTokens: 700 }], [a, 'src/core/ledger.ts', { maxTokens: 1200 }],
    [a, 'src/core/mixed.ts', { maxTokens: 500 }], [a, 'src/core/fresh.ts and src/core/missing.ts'],
    [a, 'src/many/'], [a, 'config/limits.yaml'], [a, 'styles/site.css'], [a, 'src/core/tariff.ts'],
    [a, 'src/core/mixed.ts'], [a, 'src/core/heavy.ts'], [a, 'src/core/volatile.ts'],
    [c, 'src/app/tool.ts'], [a, 'src/core/doesNotExist.ts'],
  ];
  AGAIN = [[a, 'src/core/ledger.ts'], [a, 'src/core/fresh.ts'], [a, 'tally numbers'], [a, 'src/core/doesNotExist.ts']];
  for (const [svc, q, opts] of MATRIX) pack(svc, q, opts);
  // Built a second time, from scratch, for the determinism check: one of each class and
  // of each way to reach it, rather than the whole matrix twice.
  for (const [svc, q, opts] of AGAIN) again.set(key(svc, q, opts), svc.getContextPack(q, opts));
  for (const q of HUMAN_QUERIES) human(a, q, 'explain');
  for (const q of HISTORY_QUERIES) human(a, q, 'history');
}, 240_000);

afterAll(() => {
  for (const s of [a, b, c]) s?.close();
  for (const d of [repoA, repoB, repoC]) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the matrix

describe('the synthetic matrix', () => {
  it('1. a strong direct target is SUPPORTED: named, VERIFIED code and settled history, a current record', () => {
    const p = pack(a, 'src/core/ledger.ts');
    expect(ap(p).classification).toBe('SUPPORTED');
    expect(briefs(p)).toEqual(['named outright', 'code quoted', '2 target commit(s)', '2 of 2 decision(s) settled',
                               'REC-LEDGER on it (DECLARED)']);
    // The record decides as coverage only: it is a claim, and labelled one.
    const rec = decisive(p).find((f) => f.facet === 'memory')!;
    expect([rec.effect, rec.label]).toEqual(['claim', 'DECLARED']);
    expect(human(a, 'src/core/ledger.ts').pack.applicability!.classification).toBe('SUPPORTED');
  });

  it('2. a weak lexical target is never SUPPORTED: LOW VALUE with nothing VERIFIED of its own, PARTIAL with some', () => {
    const thin = pack(a, 'tally numbers');
    expect(thin.target.confidence.level).toBe('LOW');
    expect(ap(thin).classification).toBe('LOW VALUE');
    expect(briefs(thin)).toEqual(['matched by wording (LOW)', '2 data files not parsed', 'no commit changed it']);

    const own = pack(a, 'round totals scripts');
    expect(own.target.confidence.level).toBe('LOW');
    expect(ap(own).classification).toBe('PARTIAL');
    expect(ap(own).rule).toContain('matched by wording, not named');
    expect(briefs(own)).toEqual(['matched by wording (LOW)']);
  });

  it('3. no target: NOT APPLICABLE when nothing matches, LOW VALUE when only words do', () => {
    const nothing = pack(a, 'quantum flux capacitor');
    expect(nothing.target.resolution).toBe('none');
    expect(ap(nothing).classification).toBe('NOT APPLICABLE');
    expect(ap(nothing).findings.map((f) => f.brief)).toEqual(['no target']);

    const words = pack(a, 'tuned three times');
    expect(words.target.resolution).toBe('none');
    expect(ap(words).classification).toBe('LOW VALUE');
    expect(briefs(words)).toEqual(['no target', '1 record(s) by wording only']);
  });

  it('4. a target with no history is PARTIAL, and says none of the commits Strata holds changed it', () => {
    const p = pack(a, 'src/core/fresh.ts');
    expect(ap(p).classification).toBe('PARTIAL');
    const h = decisive(p).find((f) => f.facet === 'history')!;
    expect([h.brief, h.label]).toEqual(['no commit changed it', 'VERIFIED']);
    const held = Number(gitIn(repoA)(['rev-list', '--count', 'HEAD']).trim());
    expect(h.text).toBe(`none of the ${held} commits Strata holds changed the target`);
  });

  /*
    A record is a claim and cannot add support, so its absence no longer takes support away:
    a named target whose code is quoted and whose history is VERIFIED and settled is
    SUPPORTED, and the missing record is still reported, as UNKNOWN, beside the class rather
    than deciding it. A record that is present and unreliable still holds a pack down.
  */
  it('5. a target with no memory, in a store with no records, is SUPPORTED on VERIFIED evidence, and says nothing was written down', () => {
    const p = pack(b, 'src/app/service.ts');
    expect(ap(p).classification).toBe('SUPPORTED');
    expect(ap(p).rule).toContain('no record is about it: why it is like this is UNKNOWN beyond commit messages');
    expect(decisive(p).every((f) => f.label === 'VERIFIED')).toBe(true);
    const none = ap(p).findings.filter((f) => f.facet === 'memory');
    expect(none.map((f) => [f.brief, f.effect, f.label, f.decisive]))
      .toEqual([['no records in the store (UNKNOWN)', 'limit', 'UNKNOWN', false]]);
  });

  it('6. history without memory is SUPPORTED: settled VERIFIED history, and the missing record reported', () => {
    const p = pack(a, 'src/core/rates.ts');
    expect(ap(p).classification).toBe('SUPPORTED');
    expect(briefs(p)).toEqual(['named outright', 'code quoted', '2 target commit(s)', '2 of 2 decision(s) settled']);
    expect(ap(p).findings.filter((f) => f.facet === 'history').map((f) => [f.brief, f.effect]))
      .toEqual([['2 target commit(s)', 'basis'], ['2 of 2 decision(s) settled', 'basis']]);
    expect(ap(p).findings.filter((f) => f.facet === 'memory').map((f) => [f.brief, f.effect, f.label, f.decisive]))
      .toEqual([['no record on it (UNKNOWN)', 'limit', 'UNKNOWN', false]]);
  });

  it('7. memory on a weak target does not lift it: LOW VALUE, with the record carried as a claim', () => {
    const p = pack(a, 'tally numbers');
    const rec = ap(p).findings.find((f) => f.facet === 'memory')!;
    expect([rec.brief, rec.effect, rec.label, rec.decisive]).toEqual(['REC-TALLY on it (DECLARED)', 'claim', 'DECLARED', false]);
    expect(ap(p).classification).toBe('LOW VALUE');
    // The human view quotes more code than the agent pack; here there is none to quote.
    expect(human(a, 'tally numbers').pack.applicability!.classification).toBe('LOW VALUE');
  });

  it('8. truncated history: trimming the target\'s own commits and decisions makes it PARTIAL; trimming around it does not', () => {
    const cut = pack(a, 'src/core/ledger.ts', { maxTokens: 700 });
    expect(ap(cut).classification).toBe('PARTIAL');
    expect(briefs(cut)).toEqual(['2 target commit(s) trimmed', '1 decision(s) trimmed']);

    const around = pack(a, 'src/core/ledger.ts', { maxTokens: 1200 });
    expect(around.diagnostics.truncated).toBe(true);
    expect(ap(around).classification).toBe('SUPPORTED');
    // Trimmed all the same, and said so on the block's first line.
    expect(ap(around).findings.find((f) => f.facet === 'budget')!.text).toMatch(/^trimmed to fit 1200 tokens in \d+ step\(s\): /);
    expect(blockOf(a, around)[0]).toBe('## APPLICABILITY: SUPPORTED · trimmed to fit 1200 tokens');
  });

  it('9. omitted evidence is named, and a record, path or file the target needs that is not shown makes it PARTIAL', () => {
    const record = pack(a, 'src/core/mixed.ts', { maxTokens: 500 });
    expect(ap(record).classification).toBe('PARTIAL');
    expect(briefs(record)).toContain('REC-MIXED not shown (budget)');

    const named = pack(a, 'src/core/fresh.ts and src/core/missing.ts');
    expect(ap(named).classification).toBe('PARTIAL');
    expect(briefs(named)[0]).toBe('src/core/missing.ts not in the index');

    const dir = human(a, 'src/many/').pack;
    expect(ap(dir).classification).toBe('PARTIAL');
    expect(briefs(dir)).toContain('covers 5 of 7 files in src/many/');
    expect(briefs(pack(a, 'src/many/'))).toContain('covers 5 of 7 files in src/many/');
  });

  it('10. an unsupported file type is admitted: a data file with history is PARTIAL, an unindexed type NOT APPLICABLE', () => {
    const data = pack(a, 'config/limits.yaml');
    expect(ap(data).classification).toBe('PARTIAL');
    expect(briefs(data)).toContain('limits.yaml not parsed (data file)');
    expect(ap(data).findings.filter((f) => f.facet === 'history' && f.effect === 'basis').length).toBeGreaterThan(0);

    const css = pack(a, 'styles/site.css');
    expect(ap(css).classification).toBe('NOT APPLICABLE');
    expect(ap(css).findings).toHaveLength(1);
    expect(ap(css).findings[0]!.text).toContain('styles/site.css is in the working tree, but Strata does not index .css files');
  });

  it('11. a record older than a later change to its code is stale: PARTIAL, naming that commit', () => {
    const p = pack(a, 'src/core/tariff.ts');
    expect(ap(p).classification).toBe('PARTIAL');
    expect(briefs(p)).toEqual([`REC-TARIFF predates ${short('T2')}`]);
    expect(decisive(p)[0]!.text).toBe(`REC-TARIFF was written before ${short('T2')} changed its files; it may not describe the current code`);
  });

  it('12. mixed evidence: VERIFIED decides, DECLARED and INFERRED are claims, and claims outnumbering it prevent SUPPORTED', () => {
    const p = pack(a, 'src/core/mixed.ts');
    expect(ap(p).classification).toBe('SUPPORTED');
    expect(ap(p).findings.filter((f) => f.effect === 'basis').every((f) => f.label === 'VERIFIED')).toBe(true);
    expect(ap(p).findings.filter((f) => f.facet === 'memory').map((f) => [f.brief, f.effect, f.label]).sort())
      .toEqual([['REC-MIXED on it (DECLARED)', 'claim', 'DECLARED'], ['REC-TMIXED on it (INFERRED)', 'claim', 'INFERRED']]);

    const heavy = pack(a, 'src/core/heavy.ts');
    expect(ap(heavy).classification).toBe('PARTIAL');
    const p2 = heavy.provenanceSummary;
    expect(p2.DECLARED + p2.INFERRED).toBeGreaterThanOrEqual(p2.VERIFIED);
    expect(briefs(heavy)).toEqual([`mostly unverified (${p2.VERIFIED} VERIFIED vs ${p2.DECLARED + p2.INFERRED})`]);
  });

  it('13. UNKNOWN stays UNKNOWN: unsettled decisions are NOT ESTABLISHED, and no repository history is UNKNOWN, not empty', () => {
    const p = pack(a, 'src/core/volatile.ts');
    expect(ap(p).classification).toBe('PARTIAL');
    expect(briefs(p)).toEqual(['2 of 3 decision(s) NOT ESTABLISHED']);
    expect(decisive(p)[0]!.label).toBe('UNKNOWN');
    expect(blockOf(a, p).join('\n')).toContain('NOT ESTABLISHED');

    const none = pack(c, 'src/app/tool.ts');
    expect(ap(none).classification).toBe('PARTIAL');
    const h = decisive(none).find((f) => f.facet === 'history')!;
    expect([h.brief, h.label]).toEqual(['no repository history (UNKNOWN)', 'UNKNOWN']);
    expect(h.text).toContain('UNKNOWN, not empty');
  });

  it('14. a named file that does not exist is NOT APPLICABLE, and nothing else is claimed', () => {
    const p = pack(a, 'src/core/doesNotExist.ts');
    expect(p.targetNotFound).toBe(true);
    expect(ap(p).classification).toBe('NOT APPLICABLE');
    expect(ap(p).findings.map((f) => [f.text, f.decisive]))
      .toEqual([['src/core/doesNotExist.ts is not in the code index or the working tree', true]]);
  });
});

// ------------------------------------------------------------------ rules across the matrix

describe('the rules hold for every result', () => {
  it('every classification has a rule and the findings that decided it', () => {
    for (const [svc, q, opts] of MATRIX) {
      const a1 = ap(pack(svc, q, opts));
      expect(a1.rule.length, q).toBeGreaterThan(0);
      expect(a1.findings.some((f) => f.decisive), q).toBe(true);
      expect(['SUPPORTED', 'PARTIAL', 'LOW VALUE', 'NOT APPLICABLE']).toContain(a1.classification);
    }
  });

  it('only VERIFIED evidence is a basis; a record is never VERIFIED and never a basis', () => {
    for (const [svc, q, opts] of MATRIX) {
      for (const f of ap(pack(svc, q, opts)).findings) {
        if (f.effect === 'basis') expect(f.label, `${q}: ${f.text}`).toBe('VERIFIED');
        if (f.facet === 'memory') {
          expect(f.effect, `${q}: ${f.text}`).not.toBe('basis');
          expect(f.label, `${q}: ${f.text}`).not.toBe('VERIFIED');
        }
      }
    }
  });

  it('SUPPORTED only ever rests on a named target, quoted code and settled VERIFIED history', () => {
    for (const [svc, q, opts] of MATRIX) {
      const p = pack(svc, q, opts);
      if (ap(p).classification !== 'SUPPORTED') continue;
      expect(p.target.confidence.level, q).toBe('HIGH');
      expect(p.currentBehavior.length, q).toBeGreaterThan(0);
      const decisions = p.historicalDecisions.filter((d) => d.inTarget);
      const settled = decisions.filter((d) => d.status !== 'UNKNOWN').length;
      expect(settled, q).toBeGreaterThan(0);
      expect(settled, q).toBeGreaterThanOrEqual(decisions.length - settled);
      expect(p.diagnostics.budgetExceeded, q).toBe(false);
    }
  });

  it('the same input gives the same classification and explanation, and the same text', () => {
    expect(new Set(AGAIN.map(([svc, q, opts]) => ap(pack(svc, q, opts)).classification)).size).toBe(4);
    for (const [svc, q, opts] of AGAIN) {
      const first = pack(svc, q, opts);
      const second = again.get(key(svc, q, opts))!;
      expect(second.applicability, q).toEqual(first.applicability);
      expect(svc.renderAgentContext(second), q).toBe(svc.renderAgentContext(first));
    }
  });

  it('no history, and history with nothing about the target, read differently', () => {
    const never = decisive(pack(c, 'src/app/tool.ts')).find((f) => f.facet === 'history')!;
    const none = decisive(pack(a, 'src/core/fresh.ts')).find((f) => f.facet === 'history')!;
    expect([never.label, none.label]).toEqual(['UNKNOWN', 'VERIFIED']);
    expect(never.brief).not.toBe(none.brief);
    expect(never.text).toContain('Strata holds no commits for this repository');
    expect(none.text).toMatch(/^none of the \d+ commits Strata holds changed the target/);
  });

  it('no memory, and memory that exists but is weak, read differently', () => {
    const memory = (p: ContextPack): string[] => ap(p).findings.filter((f) => f.facet === 'memory').map((f) => f.brief);
    expect(memory(pack(b, 'src/app/service.ts'))).toEqual(['no records in the store (UNKNOWN)']);
    expect(memory(pack(a, 'src/core/rates.ts'))).toEqual(['no record on it (UNKNOWN)']);
    expect(memory(pack(a, 'src/core/tariff.ts'))).toEqual(['REC-TARIFF on it (DECLARED)', `REC-TARIFF predates ${short('T2')}`]);
    expect(memory(pack(a, 'tally numbers'))).toEqual(['REC-TALLY on it (DECLARED)']);
  });

  it('reasons are facts from the pack and the store, with their counts and ids, not guesses', () => {
    const cut = pack(a, 'src/core/ledger.ts', { maxTokens: 700 });
    const trimmed = ap(cut).findings.find((f) => f.brief === '2 target commit(s) trimmed')!;
    // In the engine's ranked order: the commit that introduced the file comes first.
    expect(trimmed.text).toBe(`2 of the 2 commit(s) that changed the target did not fit the budget: ${short('L1')}, ${short('L2')}`);
    const heavy = pack(a, 'src/core/heavy.ts');
    const verified = heavy.provenanceSummary.VERIFIED;
    expect(ap(heavy).findings.find((f) => f.facet === 'provenance')!.text).toContain(`only ${verified} of the pack's`);
  });
});

// ------------------------------------------------------------------ agent context

describe('agent context: the block, and nothing else', () => {
  it('the text an agent receives is the pack as before, with the block under the target lines', () => {
    for (const [svc, q, opts] of MATRIX) {
      const p = pack(svc, q, opts);
      const agent = svc.renderAgentContext(p);
      expect(withoutBlock(agent), q).toBe(svc.renderContextPack(p));
      const at = agent.indexOf('\n## APPLICABILITY: ');
      const next = p.targetNotFound ? agent.indexOf('## TARGET_NOT_FOUND') : agent.indexOf('## WHY THIS AREA MATTERS');
      expect(at, q).toBeGreaterThan(0);
      expect(at, q).toBeLessThan(next);
    }
  });

  it('the block is outside the budget: every budget measure sees the pack without it', () => {
    const p = pack(a, 'src/core/ledger.ts', { maxTokens: 1200 });
    expect(p.diagnostics.estimatedTokens).toBe(estimateTokens(a.renderContextPack(p)));
    expect(estimateTokens(a.renderContextPack(p))).toBeLessThanOrEqual(1200);
    expect(p.diagnostics.budgetExceeded).toBe(false);
  });

  it('the block keeps to its size, leads with the class and a reason, and counts what it cannot show', () => {
    for (const [svc, q, opts] of MATRIX) {
      const result = ap(pack(svc, q, opts));
      for (const max of [320, 200, 120]) {
        const lines = renderApplicabilityBlock(result, max);
        expect(lines.join('\n').length, `${q} @${max}`).toBeLessThanOrEqual(max);
        expect(lines[0], q).toMatch(/^## APPLICABILITY: (SUPPORTED|PARTIAL|LOW VALUE|NOT APPLICABLE)( · trimmed to fit \d+ tokens)?$/);
        expect(lines[1], q).toMatch(/^- (why|gaps): \S/);
      }
    }
    const tight = renderApplicabilityBlock(ap(pack(a, 'src/core/ledger.ts', { maxTokens: 700 })), 120);
    expect(tight[tight.length - 1]).toMatch(/^- \+\d+ more$/);
  });

  it('a pack that does not apply shows only why', () => {
    expect(blockOf(a, pack(a, 'styles/site.css'))).toEqual(
      ['## APPLICABILITY: NOT APPLICABLE', '- why: styles/site.css not indexed (file type)']);
    expect(blockOf(a, pack(a, 'src/core/doesNotExist.ts'))).toEqual(
      ['## APPLICABILITY: NOT APPLICABLE', '- why: src/core/doesNotExist.ts not in the index']);
  });

  const runCli = (argv: string[]): string => {
    const program = new Command();
    program.exitOverride();
    registerContextCommand(program);
    registerExplainCommand(program);
    registerHistoryCommand(program);
    const printed: string[] = [];
    const log = console.log;
    const cwd = process.cwd();
    console.log = (...x: unknown[]) => { printed.push(x.map(String).join(' ')); };
    try {
      process.chdir(repoA);
      program.parse(['node', 'strata', ...argv]);
    } finally {
      process.chdir(cwd);
      console.log = log;
    }
    return printed.join('\n');
  };

  it('CLI: strata context prints the block, and --json carries the assessment', () => {
    // The missing record no longer decides the class; it is still in the block.
    const block = runCli(['context', 'src/core/fresh.ts']);
    expect(block).toContain('## APPLICABILITY: PARTIAL\n- gaps: no commit changed it\n');
    expect(block).toMatch(/\n- also: [^\n]*no record on it \(UNKNOWN\)/);
    const parsed = JSON.parse(runCli(['context', 'src/core/fresh.ts', '--json']));
    expect(parsed.applicability.classification).toBe('PARTIAL');
    expect(parsed.applicability.findings.some((f: ApplicabilityFinding) => f.decisive)).toBe(true);
  });

  it('MCP: strata_context carries the block and the structured assessment', async () => {
    const handler = new StrataMCPHandler(repoA);
    try {
      const text = (await handler.handleToolCall('strata_context', { query: 'src/core/fresh.ts' })).content[0]!.text;
      expect(text).toContain('## APPLICABILITY: PARTIAL');
      const json = JSON.parse((await handler.handleToolCall('strata_context', { query: 'src/core/fresh.ts', format: 'json' })).content[0]!.text);
      expect(json.applicability.classification).toBe('PARTIAL');
    } finally {
      handler.close();
    }
  });

  it('hook: the delivered context carries the block, stays inside the measured inline size, and is otherwise unchanged', () => {
    const prompt = 'Why is src/core/fresh.ts like this?';
    const r = buildPromptContext({ prompt, cwd: repoA });
    const text = r.output!.hookSpecificOutput.additionalContext;
    expect(text).toContain('## APPLICABILITY: PARTIAL');
    expect(text.length).toBeLessThanOrEqual(INLINE_CONTEXT_LIMIT - INLINE_MARGIN);
    const p = a.getContextPack(prompt, { maxTokens: budgetForInline(INLINE_CONTEXT_LIMIT) });
    expect(withoutBlock(text)).toBe(`${CONTEXT_HEADER}\n\n${a.renderContextPack(p)}`);
  });
});

// ------------------------------------------------------------------ human view

describe('human view: the same assessment, readable', () => {
  const VIEWS: [string, HumanView][] = [
    ...HUMAN_QUERIES.map((q): [string, HumanView] => [q, 'explain']),
    ...HISTORY_QUERIES.map((q): [string, HumanView] => [q, 'history']),
  ];

  it('explain and history open with it, under the header and before every other section', () => {
    for (const [q, view] of VIEWS) {
      const { pack: p, text } = human(a, q, view);
      const lines = text.split('\n');
      const at = lines.findIndex((l) => l.startsWith('APPLICABILITY — '));
      expect(at, `${q} ${view}`).toBeGreaterThan(0);
      expect(lines[at + 1]).toMatch(/^─+$/);
      expect(lines[at + 2]).toBe(`${ap(p).classification} — ${ap(p).rule}`);
      const other = lines.findIndex((l, i) => i > at && /^[A-Z][A-Z /]+ — /.test(l) && lines[i + 1]?.startsWith('─'));
      if (other >= 0) expect(at).toBeLessThan(other);
    }
  });

  it('the view gains the section and nothing else', () => {
    for (const [q, view] of VIEWS) {
      const { pack: p, text } = human(a, q, view);
      expect(withoutSection(text), `${q} ${view}`).toBe(renderHuman({ ...p, applicability: undefined }, view));
    }
  });

  it('every finding carries its label, the deciding ones say so, and none states a cause', () => {
    for (const q of HUMAN_QUERIES) {
      const { text } = human(a, q, 'explain');
      const lines = text.split('\n');
      const at = lines.findIndex((l) => l.startsWith('APPLICABILITY — '));
      const next = lines.findIndex((l, i) => i > at && l === '');
      const section = lines.slice(at, next);
      for (const l of section.filter((x) => x.startsWith('    - '))) {
        expect(l, l).toMatch(/\[(VERIFIED|DECLARED|INFERRED|UNKNOWN)( · decides the class)?\]$/);
      }
      expect(section.filter((x) => x.includes('decides the class')).length, q).toBeGreaterThan(0);
      for (const l of section) expect(l, l).not.toMatch(CAUSAL);
    }
  });

  it('CLI explain and history, and MCP strata_explain, carry it', async () => {
    expect(runHuman(['explain', 'src/core/fresh.ts'])).toContain('APPLICABILITY — how far this view can answer the request');
    expect(runHuman(['history', 'src/core/fresh.ts'])).toContain('PARTIAL — not SUPPORTED: no commit changed it\n');
    const handler = new StrataMCPHandler(repoA);
    try {
      const text = (await handler.handleToolCall('strata_explain', { query: 'src/core/fresh.ts' })).content[0]!.text;
      expect(text).toContain('PARTIAL — not SUPPORTED: no commit changed it');
    } finally {
      handler.close();
    }
  });
});

function runHuman(argv: string[]): string {
  const program = new Command();
  program.exitOverride();
  registerExplainCommand(program);
  registerHistoryCommand(program);
  const printed: string[] = [];
  const log = console.log;
  const cwd = process.cwd();
  console.log = (...x: unknown[]) => { printed.push(x.map(String).join(' ')); };
  try {
    process.chdir(repoA);
    program.parse(['node', 'strata', ...argv]);
  } finally {
    process.chdir(cwd);
    console.log = log;
  }
  return printed.join('\n');
}
