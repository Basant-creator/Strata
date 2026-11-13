import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import { StrataService } from '../src/records/service.js';
import { StrataMCPHandler } from '../src/mcp/server.js';
import { registerHistoryCommand } from '../src/cli/commands/history.js';
import { registerExplainCommand } from '../src/cli/commands/explain.js';

/**
 * The human history experience, `strata history` and `strata explain`.
 *
 * One synthetic repository holding every kind of evidence the views must present:
 *
 *   src/billing/invoice.ts  the target, changed five times:
 *     c1 create totals              — partly rewritten later     → UNKNOWN
 *     c2 round each line            — replaced wholesale by c3   → SUPERSEDED
 *        (adds tests/invoice.test.ts, which c3 deletes           → deleted evidence)
 *     c3 round the total once       — still whole at HEAD        → ACTIVE
 *     c4 add currency formatting    — partly rewritten by c5     → UNKNOWN
 *     c5 show the currency symbol   — last change, untouched     → ACTIVE, with an INFERRED note
 *   src/billing/checkout.ts          a caller (connected code)
 *   src/reports/invoiceReport.ts     shares the words, imports nothing (a lexical neighbour)
 *   src/auth/login.ts                unrelated, and with no memory at all
 *
 *   REC-INV (DECLARED) about invoice.ts: an intent, a failed attempt and its replacement,
 *   an ACTIVE constraint and a consequence — the development memory git cannot hold.
 */

const repoDir = path.join(process.cwd(), '.test_repo_human_history');
let service: StrataService;
const sha: Record<string, string> = {};

const git = (args: string[], date?: string): string => execFileSync('git', args, {
  cwd: repoDir, encoding: 'utf-8',
  env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
});
const write = (rel: string, lines: string[]): void => {
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, lines.join('\n') + '\n', 'utf-8');
};
const commit = (label: string, msg: string, date: string): void => {
  git(['add', '-A']);
  git(['commit', '-q', '-m', msg], date);
  sha[label] = git(['rev-parse', 'HEAD']).trim();
};
const short = (label: string): string => sha[label]!.slice(0, 7);

const INTENT = 'Totals are rounded once at the end because per-line rounding drifted from the payment provider by a cent on large invoices.';
const FAILED = 'Round each line to cents before summing';
const FAILED_WHY = 'Totals drifted by one cent from the provider on invoices with many lines.';
const REPLACEMENT = 'Round once at the end of invoiceTotal';
const CONSTRAINT = 'Invoice totals must match the payment provider to the cent.';
const CONSEQUENCE = 'Invoices issued before the change keep their per-line rounded totals; they are not recomputed.';

beforeAll(() => {
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(repoDir, { recursive: true });
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Fixture Author']);

  write('src/billing/invoice.ts', [
    'export const TAX_RATE = 0.2;',
    '',
    'export function invoiceTotal(amounts: number[]): number {',
    '  const gross = amounts.reduce((sum, a) => sum + a, 0) * (1 + TAX_RATE);',
    '  return gross;',
    '}',
  ]);
  commit('c1', 'create invoice totals', '2026-01-01T10:00:00Z');

  write('src/billing/checkout.ts', [
    "import { invoiceTotal } from './invoice';",
    'export function charge(amounts: number[]): number { return invoiceTotal(amounts); }',
  ]);
  commit('checkout', 'checkout charges the invoice total', '2026-01-02T10:00:00Z');

  write('src/reports/invoiceReport.ts', [
    "export const REPORT_COLUMNS = ['invoice', 'total', 'rounding', 'currency'];",
  ]);
  commit('report', 'invoice report columns for totals and rounding', '2026-01-03T10:00:00Z');

  write('src/billing/invoice.ts', [
    'export const TAX_RATE = 0.2;',
    'const LINE_ROUNDING_ENABLED = true;',
    '',
    'function roundEachLineToCents(amount: number): number {',
    '  return Math.round(amount * 100) / 100;',
    '}',
    '',
    'export function invoiceTotal(amounts: number[]): number {',
    '  const perLine = amounts.map(roundEachLineToCents);',
    '  const gross = perLine.reduce((sum, a) => sum + a, 0) * (1 + TAX_RATE);',
    '  return gross;',
    '}',
  ]);
  write('tests/invoice.test.ts', [
    "import { invoiceTotal } from '../src/billing/invoice';",
    '// Asserts roundEachLineToCents is applied to every line before invoiceTotal sums them.',
    "test('rounds each line', () => { expect(invoiceTotal([0.004, 0.004])).toBe(0); });",
  ]);
  commit('c2', 'round each line before summing', '2026-01-05T10:00:00Z');

  write('src/auth/login.ts', ['export function login(user: string): boolean { return user.length > 0; }']);
  commit('login', 'fix login redirect', '2026-01-08T10:00:00Z');

  write('src/billing/invoice.ts', [
    'export const TAX_RATE = 0.2;',
    'const ROUND_ONCE_AT_END = true;',
    '',
    'export function roundTotalToCents(total: number): number {',
    '  return Math.round(total * 100) / 100;',
    '}',
    '',
    'export function invoiceTotal(amounts: number[]): number {',
    '  const rawGross = amounts.reduce((sum, a) => sum + a, 0) * (1 + TAX_RATE);',
    '  return roundTotalToCents(rawGross);',
    '}',
  ]);
  fs.rmSync(path.join(repoDir, 'tests/invoice.test.ts'));
  commit('c3', 'round the total once instead of each line', '2026-01-10T10:00:00Z');

  write('src/reports/invoiceReport.ts', [
    "export const REPORT_COLUMNS = ['invoice', 'total', 'rounding', 'currency', 'date'];",
  ]);
  commit('report2', 'invoice report adds a date column', '2026-01-12T10:00:00Z');

  const withCurrency = (formatLine: string): string[] => [
    'export const TAX_RATE = 0.2;',
    'const ROUND_ONCE_AT_END = true;',
    '',
    'export function roundTotalToCents(total: number): number {',
    '  return Math.round(total * 100) / 100;',
    '}',
    '',
    'export function invoiceTotal(amounts: number[]): number {',
    '  const rawGross = amounts.reduce((sum, a) => sum + a, 0) * (1 + TAX_RATE);',
    '  return roundTotalToCents(rawGross);',
    '}',
    '',
    "export const INVOICE_CURRENCY_CODE = 'EUR';",
    '',
    'export function formatInvoiceTotal(total: number): string {',
    formatLine,
    '}',
  ];
  write('src/billing/invoice.ts', withCurrency('  return `${total.toFixed(2)} ${INVOICE_CURRENCY_CODE}`;'));
  commit('c4', 'add currency formatting', '2026-01-15T10:00:00Z');

  // Dated after the record below is written, so the record describes older code.
  write('src/billing/invoice.ts', withCurrency('  return `€${total.toFixed(2)} (${INVOICE_CURRENCY_CODE})`;'));
  commit('c5', 'show the currency symbol', '2030-01-20T10:00:00Z');

  service = new StrataService(repoDir);
  service.init();
  service.indexCode();
  service.recordChange({
    id: 'REC-INV',
    title: 'invoice.ts rounds the total once, not each line',
    intent: INTENT,
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/billing/invoice.ts', changeType: 'modify', symbols: ['invoiceTotal'] }],
    attempts: [
      { approach: FAILED, status: 'failed', failureReason: FAILED_WHY, confidence: 'DECLARED' },
      { approach: REPLACEMENT, status: 'succeeded', confidence: 'DECLARED' },
    ],
    constraints: [{ statement: CONSTRAINT, confidence: 'DECLARED', status: 'ACTIVE' }],
    consequences: [{ statement: CONSEQUENCE, confidence: 'DECLARED', evidence: [] }],
    evidence: [
      { type: 'git_commit', reference: sha['c2']! },
      { type: 'git_commit', reference: sha['c3']! },
    ],
    result: { status: 'success', summary: 'Rounded once at the end.' },
  });
}, 120_000);

afterAll(() => {
  service?.close();
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
});

const TARGET = 'src/billing/invoice.ts';
/*
  One build per view, shared by every test that reads it.

  A human view is a full, uncapped pack build, and most of its time goes to starting git
  processes. Eighteen tests read the same two views of the target: built afresh each time,
  those tests took 2.7-3.2 s each under the full suite and timed out when the machine was
  busier. Each view is now built once and shared, as historical_diff shares its pack.
  Nothing modifies a view: tests only read the text and the pack. The one test that changes
  what a view would contain — it adds files and re-indexes — clears the cache when it does.
*/
const views = new Map<string, { pack: ReturnType<StrataService['humanView']>['pack']; text: string }>();
const view = (q: string, v: 'explain' | 'history', targetType?: 'file' | 'symbol' | 'task') => {
  const key = `${q}|${v}|${targetType ?? ''}`;
  let built = views.get(key);
  if (!built) {
    built = service.humanView(q, v, targetType ? { targetType } : {});
    views.set(key, built);
  }
  return built;
};
const lines = (t: string): string[] => t.split('\n');
const sectionOf = (text: string, heading: string): string[] => {
  const all = lines(text);
  const start = all.findIndex((l) => l.startsWith(heading));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of all.slice(start + 2)) {
    if (/^[A-Z][A-Z /]+ — /.test(l) && all[all.indexOf(l) + 1]?.startsWith('─')) break;
    out.push(l);
  }
  return out;
};
const REQUIRED = ['CURRENT', 'HISTORICAL DECISIONS', 'PREVIOUS ATTEMPTS', 'CONSTRAINTS',
                  'CONSEQUENCES', 'EVIDENCE', 'PROVENANCE', 'UNCERTAINTY'];

// ------------------------------------------------------------------ retrieval

describe('retrieval: the human view carries everything about the target, uncut', () => {
  it('finds every commit to the target and measures each change against HEAD', () => {
    const { pack } = view(TARGET, 'history');
    const direct = pack.historicalContext.filter((h) => h.relation === 'DIRECT_TARGET').map((h) => h.shortHash);
    for (const c of ['c1', 'c2', 'c3', 'c4', 'c5']) expect(direct).toContain(short(c));
    const status = (c: string) => pack.historicalDecisions.find((d) => d.commit === short(c) && d.inTarget)?.status;
    expect(status('c3')).toBe('ACTIVE');
    expect(status('c5')).toBe('ACTIVE');
    expect(status('c2')).toBe('SUPERSEDED');
    expect(status('c4')).toBe('UNKNOWN');
  });

  it('carries the record whole, with its own confidence on every part', () => {
    const { pack } = view(TARGET, 'explain');
    const rec = pack.memory!.find((m) => m.id === 'REC-INV')!;
    expect(rec.about).toBe('target');
    expect(rec.intent).toBe(INTENT);
    expect(rec.intentConfidence).toBe('DECLARED');
    expect(rec.attempts.map((a) => [a.status, a.approach])).toEqual([['failed', FAILED], ['succeeded', REPLACEMENT]]);
    expect(rec.constraints).toEqual([{ statement: CONSTRAINT, status: 'ACTIVE', confidence: 'DECLARED' }]);
    expect(rec.consequences).toEqual([{ statement: CONSEQUENCE, confidence: 'DECLARED' }]);
    expect(rec.commits).toEqual([short('c2'), short('c3')]);
  });

  it('leaves the agent pack exactly as it was: no memory, the same caps', () => {
    const agent = service.getContextPack(TARGET, {});
    expect(agent.memory).toBeUndefined();
    expect(agent.historicalDecisions.length).toBeLessThanOrEqual(4);
    expect(agent.historicalContext.filter((h) => h.changes).length).toBeLessThanOrEqual(3);
  });

  it('keeps unrelated and merely lexical history out of the target\'s own history', () => {
    const { pack } = view(TARGET, 'history');
    const direct = pack.historicalContext.filter((h) => h.relation === 'DIRECT_TARGET').map((h) => h.shortHash);
    for (const c of ['login', 'report', 'report2', 'checkout']) expect(direct).not.toContain(short(c));
  });
});

// ------------------------------------------------------------------ rendered: structure

describe('rendered: every required section, clearly separated', () => {
  it.each(['explain', 'history'] as const)('%s shows all required sections in order', (v) => {
    const { text } = view(TARGET, v);
    const at = REQUIRED.map((h) => lines(text).findIndex((l) => l.startsWith(`${h} — `)));
    for (const [i, h] of REQUIRED.entries()) expect(at[i], `${h} missing`).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain('DEVELOPMENT MEMORY — ');
    expect(text).toContain('DELETED EVIDENCE — ');
  });

  it('explain leads with a short answer made only of labelled lines', () => {
    const { text } = view(TARGET, 'explain');
    const summary = sectionOf(text, 'WHY THIS CODE IS LIKE THIS');
    const items = summary.filter((l) => l.trim());
    expect(items.length).toBeGreaterThan(3);
    for (const l of items) expect(l, l).toMatch(/\[(VERIFIED|DECLARED|INFERRED|UNKNOWN|ACTIVE · VERIFIED|SUPERSEDED · VERIFIED|DECLARED — the record's words, unverified)\]$/);
    expect(summary.join('\n')).toContain(`${short('c3')} "round the total once instead of each line" — the code it added is at HEAD`);
    // invoice.ts exports TAX_RATE, roundTotalToCents, invoiceTotal, INVOICE_CURRENCY_CODE and
    // formatInvoiceTotal; ROUND_ONCE_AT_END is module-level. Counted apart, not together.
    expect(summary.join('\n')).toContain('5 export(s), 1 module-level declaration(s); used from 1 file(s)  [VERIFIED]');
    expect(summary.join('\n')).toContain(`${short('c2')} "round each line before summing" — superseded by ${short('c3')}`);
  });

  it('history lists every change oldest first and refuses to read order as cause', () => {
    const { text } = view(TARGET, 'history');
    const tl = sectionOf(text, 'TIMELINE');
    const at = ['c1', 'c2', 'c3', 'c4', 'c5'].map((c) => tl.findIndex((l) => l.includes(`  ${short(c)}  `)));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(tl.join('\n')).toContain('That one change led to the next is not claimed');
    expect(tl.join('\n')).toContain('message (DECLARED — the author\'s description): "round each line before summing"');
    // The deleted test is named on the commit that added it.
    expect(tl.join('\n')).toContain('recovered: tests/invoice.test.ts');
  });
});

// ------------------------------------------------------------------ rendered: current vs historical

describe('rendered: current state and historical state are not confused', () => {
  it('CURRENT quotes the working tree, including a module-level constant', () => {
    const { text } = view(TARGET, 'explain');
    const cur = sectionOf(text, 'CURRENT').join('\n');
    expect(cur).toContain('src/billing/invoice.ts:8  export function invoiceTotal(amounts: number[]): number {');
    expect(cur).toContain('module-level declarations (not exported):');
    expect(cur).toContain('const ROUND_ONCE_AT_END = true;');
    expect(cur).toContain('src/billing/checkout.ts:2  invoiceTotal');
    expect(cur).not.toContain('roundEachLineToCents');
  });

  it('each decision shows the lines it removed and added, and whether they are at HEAD', () => {
    const { text } = view(TARGET, 'explain');
    const dec = sectionOf(text, 'HISTORICAL DECISIONS').join('\n');
    // From the start of the decision's own heading line to the next heading.
    const block = (c: string): string => {
      const start = dec.lastIndexOf('\n[', dec.indexOf(`] ${short(c)} · `)) + 1;
      const next = dec.indexOf('\n[', start + 1);
      return dec.slice(start, next < 0 ? undefined : next);
    };
    expect(block('c2')).toContain('[SUPERSEDED');
    expect(block('c2')).toContain('no longer present at HEAD');
    expect(block('c2')).toContain('+ function roundEachLineToCents(amount: number): number {');
    expect(block('c2')).toContain(`superseded by (VERIFIED): ${short('c3')}`);
    expect(block('c3')).toContain('still present at HEAD');
    expect(dec).toContain(`[UNKNOWN — NOT ESTABLISHED] ${short('c4')}`);
    // An observation Strata makes itself is labelled as its own reading.
    expect(block('c5')).toMatch(/\(INFERRED\) The repository records no later change reversing this/);
  });
});

// ------------------------------------------------------------------ rendered: memory, attempts, constraints

describe('rendered: development memory is readable and stays a claim', () => {
  it('quotes the record exactly under a DECLARED label, with who and when', () => {
    const { text } = view(TARGET, 'explain');
    const mem = sectionOf(text, 'DEVELOPMENT MEMORY').join('\n');
    expect(mem).toContain('REC-INV — "invoice.ts rounds the total once, not each line"');
    expect(mem).toContain('about: about this code');
    expect(mem).toContain('intent — DECLARED, unverified claim:');
    expect(mem).toContain(`"${INTENT}"`);
    expect(mem).toContain('recorded by');
  });

  it('shows the failed attempt, why it failed, and what replaced it, in order', () => {
    const { text } = view(TARGET, 'explain');
    const att = sectionOf(text, 'PREVIOUS ATTEMPTS').join('\n');
    const failed = att.indexOf(`1. FAILED — DECLARED, unverified claim:\n       "${FAILED}"`);
    const why = att.indexOf(`what happened: "${FAILED_WHY}"`);
    const next = att.indexOf(`2. SUCCEEDED — DECLARED, unverified claim:\n       "${REPLACEMENT}"`);
    expect(failed).toBeGreaterThan(-1);
    expect(why).toBeGreaterThan(failed);
    expect(next).toBeGreaterThan(why);
    // Git's own evidence of the replaced code sits beside the record's account of it.
    expect(att).toContain(`${short('c2')} "round each line before summing" — superseded by ${short('c3')}`);
  });

  it('shows the recorded constraint and consequence, labelled and attributed', () => {
    const { text } = view(TARGET, 'explain');
    expect(sectionOf(text, 'CONSTRAINTS').join('\n'))
      .toContain(`- [ACTIVE] DECLARED, unverified claim (REC-INV, about this code):\n    "${CONSTRAINT}"`);
    expect(sectionOf(text, 'CONSEQUENCES').join('\n'))
      .toContain(`- DECLARED, unverified claim (REC-INV, about this code):\n    "${CONSEQUENCE}"`);
  });

  it('says which commits changed the code after the record was written', () => {
    const { text } = view(TARGET, 'explain');
    expect(sectionOf(text, 'DEVELOPMENT MEMORY').join('\n'))
      .toContain(`changed since this record was written (VERIFIED): ${short('c5')} (2030-01-20)`);
  });
});

// ------------------------------------------------------------------ rendered: deleted evidence

describe('rendered: deleted evidence is understandable', () => {
  it('reads the deleted test back from git and says where it came from', () => {
    const { text } = view(TARGET, 'history');
    const del = sectionOf(text, 'DELETED EVIDENCE').join('\n');
    expect(del).toContain('tests/invoice.test.ts');
    expect(del).toContain(`read from ${short('c2')}`);
    expect(del).toContain('[VERIFIED]');
    expect(del).toContain('| // Asserts roundEachLineToCents is applied to every line before invoiceTotal sums them.');
  });
});

// ------------------------------------------------------------------ rendered: provenance and uncertainty

describe('rendered: provenance is correct and nothing is invented', () => {
  it('never shows the record\'s words outside a DECLARED quotation', () => {
    const { text } = view(TARGET, 'explain');
    for (const phrase of ['per-line rounding drifted', 'match the payment provider to the cent', 'per-line rounded totals']) {
      for (const l of lines(text).filter((x) => x.includes(phrase))) {
        expect(l.trim(), l).toMatch(/^"/);
        const i = lines(text).indexOf(l);
        expect(lines(text)[i - 1], `label above: ${l}`).toMatch(/DECLARED, unverified claim/);
      }
    }
  });

  it('adds no reason, motive or cause of its own', () => {
    for (const v of ['explain', 'history'] as const) {
      const { text } = view(TARGET, v);
      // Outside quoted material, the renderer states no cause. Its only uses of causal
      // words are the disclaimers that it does not claim one.
      for (const l of lines(text).filter((x) => !x.includes('"'))) {
        if (/not claimed|not evidence that|is not claimed/.test(l)) continue;
        expect(l, l).not.toMatch(/\bbecause\b|\bdue to\b|\bin order to\b|\bso that\b|\bled to\b|\bcaused\b|\bto fix\b|\bmotivat/i);
      }
    }
  });

  it('labels commit messages DECLARED everywhere they appear', () => {
    const { text } = view(TARGET, 'history');
    for (const l of lines(text).filter((x) => x.includes('"round the total once instead of each line"'))) {
      expect(l, l).toMatch(/DECLARED|\[ACTIVE|superseded|— the code it added|^\s+\S+\s+\d{4}-\d\d-\d\d\s+"|later commits to this file \(VERIFIED\)/);
    }
  });

  it('states what is unknown, in its own section', () => {
    const { text } = view(TARGET, 'explain');
    const unc = sectionOf(text, 'UNCERTAINTY').filter((l) => l.trim());
    expect(unc.length).toBeGreaterThan(0);
    for (const l of unc) expect(l).toMatch(/^- UNKNOWN — /);
    const open = unc.find((l) => l.includes('whether the changes made by'))!;
    expect(open).toContain(short('c1'));
    expect(open).toContain(short('c4'));
    expect(open).not.toContain(short('c3'));
  });

  it('says UNKNOWN, not nothing, for code nobody wrote anything down about', () => {
    const { text } = view('src/auth/login.ts', 'explain');
    expect(sectionOf(text, 'DEVELOPMENT MEMORY').join('\n')).toContain('UNKNOWN — no Strata record is about this code');
    expect(sectionOf(text, 'PREVIOUS ATTEMPTS').join('\n')).toContain('UNKNOWN — no previous attempt is recorded');
    expect(sectionOf(text, 'CONSTRAINTS').join('\n')).toContain('UNKNOWN — no constraint is recorded for this code.');
    expect(sectionOf(text, 'CONSEQUENCES').join('\n')).toContain('UNKNOWN — no consequence of earlier work here is recorded.');
    expect(sectionOf(text, 'WHY THIS CODE IS LIKE THIS').join('\n'))
      .toContain('no Strata record is about this code; nobody wrote down why  [UNKNOWN]');
    expect(sectionOf(text, 'UNCERTAINTY').join('\n')).toContain('why this code changed: no record states it');
  });
});

// ------------------------------------------------------------------ targets

describe('targets: file, symbol, directory and words', () => {
  it('a symbol: names it, puts the changes that name it first, and says history is per file', () => {
    const { pack, text } = view('invoiceTotal', 'explain');
    expect(pack.target.resolution).toBe('exact_symbol');
    expect(text).toContain('Target   invoiceTotal (function) in src/billing/invoice.ts:8');
    const dec = sectionOf(text, 'HISTORICAL DECISIONS');
    const first = dec.find((l) => l.startsWith('['))!;
    const firstCommit = first.split(' ').find((w) => /^[0-9a-f]{7}$/.test(w))!;
    const d = pack.historicalDecisions.find((x) => x.commit === firstCommit)!;
    expect([...d.historicalState, ...d.currentState].some((l) => l.includes('invoiceTotal'))).toBe(true);
    expect(dec.join('\n')).toContain('the quoted lines do not name invoiceTotal');
    expect(sectionOf(text, 'UNCERTAINTY').join('\n')).toContain('history is kept per file');
    expect(sectionOf(text, 'CURRENT').join('\n')).toContain('used at (invoiceTotal):');
  });

  it('a directory: covers its files and nothing outside it', () => {
    const { pack, text } = view('src/billing/', 'explain');
    expect(pack.target.files).toEqual(expect.arrayContaining(['src/billing/invoice.ts', 'src/billing/checkout.ts']));
    expect(pack.target.files.every((f) => f.startsWith('src/billing/'))).toBe(true);
    expect(sectionOf(text, 'CURRENT').join('\n')).toContain('src/billing/checkout.ts — ');
    // Two files, both covered: nothing is said to be left out.
    expect(pack.target.directories).toEqual([{ directory: 'src/billing/', indexedFiles: 2, leftOut: [] }]);
    expect(text).not.toContain('Left out: src/billing');
  });

  it('a directory larger than the resolver covers: names the files it left out', () => {
    // Six more files than the directory ceiling, none of them the subject of the request.
    for (let i = 1; i <= 6; i++) write(`src/billing/extra/part${i}.ts`, [`export const PART_${i} = ${i};`]);
    try {
      service.indexCode({ force: true });
      views.clear();
      const { pack, text } = view('src/billing/', 'explain');
      const d = pack.target.directories![0]!;
      expect(d.indexedFiles).toBe(8);
      expect(d.leftOut.length).toBe(8 - pack.target.files.length);
      expect(d.leftOut.length).toBeGreaterThan(0);
      expect(text).toContain(`src/billing/ holds 8 indexed files; this view covers ${pack.target.files.length}.`);
      for (const f of d.leftOut) expect(text).toContain(f);
      expect(sectionOf(text, 'UNCERTAINTY').join('\n')).toContain('holds more files than this view covers');
    } finally {
      fs.rmSync(path.join(repoDir, 'src/billing/extra'), { recursive: true, force: true });
      service.indexCode({ force: true });
      views.clear();
    }
  });

  it('words: the file the words are about outranks the one that merely shares them', () => {
    const { pack, text } = view('why is invoiceTotal rounded once at the end', 'explain');
    expect(pack.target.files[0]).toBe(TARGET);
    expect(pack.historicalContext.filter((h) => h.relation === 'DIRECT_TARGET').map((h) => h.shortHash))
      .not.toContain(short('report'));
    expect(text).toContain('Resolved ');
  });

  it('a name that matches nothing: says so and answers about nothing else', () => {
    const { pack, text } = view('src/billing/nope.ts', 'explain');
    expect(pack.targetNotFound).toBe(true);
    expect(text).toContain('Nothing in this repository matches "src/billing/nope.ts".');
    expect(text).not.toContain('HISTORICAL DECISIONS');
  });
});

// ------------------------------------------------------------------ surfaces

describe('surfaces: CLI and MCP', () => {
  const runCli = (argv: string[]): string => {
    const program = new Command();
    program.exitOverride();
    registerHistoryCommand(program);
    registerExplainCommand(program);
    const printed: string[] = [];
    const log = console.log;
    const cwd = process.cwd();
    console.log = (...a: unknown[]) => { printed.push(a.map(String).join(' ')); };
    try {
      process.chdir(repoDir);
      program.parse(['node', 'strata', ...argv]);
    } finally {
      process.chdir(cwd);
      console.log = log;
    }
    return printed.join('\n');
  };

  it('strata history <file> prints the timeline', () => {
    const out = runCli(['history', TARGET]);
    expect(out).toContain(`STRATA HISTORY — ${TARGET}`);
    expect(out).toContain('TIMELINE — ');
  });

  it('strata explain --symbol <name> resolves the symbol', () => {
    const out = runCli(['explain', '--symbol', 'invoiceTotal']);
    expect(out).toContain('Target   invoiceTotal (function) in src/billing/invoice.ts:8');
    expect(out).toContain('WHY THIS CODE IS LIKE THIS');
  });

  it('strata explain --json emits the structured pack with memory', () => {
    const pack = JSON.parse(runCli(['explain', TARGET, '--json']));
    expect(pack.memory[0].id).toBe('REC-INV');
  });

  // One MCP request per test: each request builds its own view. Same assertions as when
  // both views were one test.
  it('MCP strata_explain serves the explain view', async () => {
    const handler = new StrataMCPHandler(repoDir);
    try {
      const explain = await handler.handleToolCall('strata_explain', { query: TARGET });
      expect(explain.content[0]!.text).toContain('WHY THIS CODE IS LIKE THIS');
    } finally {
      handler.close();
    }
  });

  it('MCP strata_explain serves the history view', async () => {
    const handler = new StrataMCPHandler(repoDir);
    try {
      const history = await handler.handleToolCall('strata_explain', { query: TARGET, view: 'history' });
      expect(history.content[0]!.text).toContain('TIMELINE — ');
    } finally {
      handler.close();
    }
  });
});
