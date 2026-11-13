import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { DECLARED_RECORD_NOTICE, DECLARED_CLAIM_HEADER, estimateTokens } from '../src/context/pack.js';
import { isCodeShaped } from '../src/code/graph.js';
import { FRAMING_STEP } from '../src/context/engine.js';

/**
 * Target resolution and the trust a DECLARED record is given.
 *
 * Each group reproduces one failure measured on a real repository, in a fixture of its own
 * so nothing here depends on that repository's names:
 *
 *   - a named directory resolved to its five shortest filenames, not to the files meant;
 *   - "which files call <function>" made a helper named `call` the primary target, and the
 *     calls to the function lost their places to references to its types;
 *   - clauses elaborating a named file added tied lexical guesses from elsewhere;
 *   - a DECLARED record opening "Recorded from Git history" was taken as verified history.
 */

const repoDir = path.join(process.cwd(), '.test_repo_resolution_claims');
let service: StrataService;

const git = (...a: string[]): string => execFileSync('git', a, { cwd: repoDir, encoding: 'utf-8' });
const write = (rel: string, body: string): void => {
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf-8');
};

beforeAll(() => {
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(repoDir, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture Author');

  // Five short, unrelated files: exactly what "the five shortest paths" used to select.
  for (const name of ['ids', 'log', 'time', 'util', 'hash']) {
    write(`src/lib/${name}.ts`, `export function ${name}Helper(): string { return '${name}'; }\n`);
  }
  // Three pricing implementations. Only one says "pricing" in its own name; the other two
  // are pricing implementations by role — the pricing engine and the pricing report use them.
  write('src/lib/pricingRules.ts', [
    'export interface PriceRule { rate: number }',
    'export function computeTotal(amount: number, rule: PriceRule): number {',
    '  return amount * rule.rate;',
    '}',
  ].join('\n') + '\n');
  write('src/lib/discountRules.ts', 'export function applyDiscount(amount: number): number { return amount * 0.9; }\n');
  write('src/lib/taxCalculation.ts', 'export function addTax(amount: number): number { return amount * 1.2; }\n');

  // Callers of computeTotal. Each also references the PriceRule type above the call line,
  // which is how the type reference used to win the call site's place in file order.
  const caller = (file: string, extra = ''): void => write(file, [
    "import { computeTotal, PriceRule } from '../lib/pricingRules';",
    "import { applyDiscount } from '../lib/discountRules';",
    "import { addTax } from '../lib/taxCalculation';",
    'const rule: PriceRule = { rate: 1 };',
    `export function run(amount: number): number {${extra}`,
    '  return addTax(applyDiscount(computeTotal(amount, rule)));',
    '}',
  ].join('\n') + '\n');
  caller('src/services/pricingEngine.ts');
  caller('src/reports/pricingReport.ts');
  caller('src/checkout/cartTotals.ts');

  // A helper whose name is an English word: the word "call" in a question matches it.
  write('scripts/smoke.ts', 'function call(url: string): string { return url; }\nexport const ping = call("/health");\n');

  // Two UI files tied on the words an elaboration clause uses.
  write('src/ui/inputPanel.ts', 'export function handleInputs(): void {}\nexport function exportedFunctions(): void {}\n');
  write('src/ui/inputList.ts', 'export function handleInputs(): void {}\nexport function exportedFunctions(): void {}\n');
  // A clear second subject for a coordinated request.
  write('src/audit/auditLedger.ts', 'export function recordAuditLedgerEntry(): void {}\n');

  git('add', '-A');
  git('commit', '-q', '-m', 'price carts with rules, discounts and tax');

  service = new StrataService(repoDir);
  service.init();
  service.indexCode();
  service.recordChange({
    id: 'REC-CLAIM',
    title: 'pricingRules.ts: totals are computed per rule',
    intent: 'Recorded from Git history. The first version computed totals with a flat rate, and '
      + 'a later commit introduced per-rule rates.',
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/lib/pricingRules.ts', changeType: 'modify' }],
    attempts: [{ approach: 'A single flat rate for every cart', status: 'superseded',
                 failureReason: 'Replaced by per-rule rates.', confidence: 'DECLARED' }],
    consequences: [{ statement: 'Every caller must pass a rule.', confidence: 'DECLARED', evidence: [] }],
    result: { status: 'success' },
  });
}, 60_000);

afterAll(() => {
  service?.close();
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
});

/*
  One build per question and budget, shared by every test that asks it.

  A pack build spends most of its time starting git processes, and the full suite runs
  every file's builds in parallel: the two budget tests below built four and five packs
  inside one five-second test and took ~3.1 s each under the suite. Packs are only read
  and rendered here, never modified, and nothing in this file changes the store or the
  index after setup, so each question is built once.
*/
const asked = new Map<string, ReturnType<StrataService['getContextPack']>>();
const ask = (q: string, maxTokens = 40_000) => {
  const key = `${q}|${maxTokens}`;
  let pack = asked.get(key);
  if (!pack) {
    pack = service.getContextPack(q, { maxTokens });
    asked.set(key, pack);
  }
  return pack;
};

// ------------------------------------------------------------------ directory targets

describe('a named directory keeps its scope and resolves to the files meant', () => {
  const Q = 'The three pricing implementations under src/lib/ — which of them does checkout reach?';

  it('ranks the files the request is about above arbitrary ones in the same directory', () => {
    const files = ask(Q).target.files;
    expect(files).toEqual(expect.arrayContaining(
      ['src/lib/pricingRules.ts', 'src/lib/discountRules.ts', 'src/lib/taxCalculation.ts']));
    // The five shortest names in the directory are exactly what used to be returned.
    for (const noise of ['ids', 'log', 'time', 'util', 'hash']) {
      expect(files).not.toContain(`src/lib/${noise}.ts`);
    }
  });

  it('counts what uses a file as evidence of its role, not only its own name', () => {
    // discountRules and taxCalculation share no word with the request; the pricing engine
    // and the pricing report both use them.
    const files = ask(Q).target.files;
    expect(files).toContain('src/lib/discountRules.ts');
    expect(files).toContain('src/lib/taxCalculation.ts');
  });

  it('keeps the directory scope: nothing outside it becomes a named target', () => {
    const anchors = ask(Q).target.anchors.filter((a) => a.kind === 'explicit_path');
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) expect(a.file.startsWith('src/lib/')).toBe(true);
  });

  it('falls back to the previous order when no other word discriminates', () => {
    const files = ask('src/lib/').target.files;
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThanOrEqual(5);
    for (const f of files) expect(f.startsWith('src/lib/')).toBe(true);
  });
});

// ------------------------------------------------------------------ symbols

describe('a named symbol outranks a word that merely spells one', () => {
  const Q = 'Which files call computeTotal, and what would break if it gained a required parameter?';

  it('makes the defining file the primary target, not the helper named "call"', () => {
    const pack = ask(Q);
    expect(pack.target.files[0]).toBe('src/lib/pricingRules.ts');
    expect(pack.target.files).not.toContain('scripts/smoke.ts');
  });

  it('still anchors a plain word that is exactly a symbol when nothing code-shaped is named', () => {
    expect(ask('where is call defined').target.files).toContain('scripts/smoke.ts');
  });

  it('treats camelCase, snake_case, digits and backticks as code, and plain words as prose', () => {
    expect(isCodeShaped('computeTotal', '')).toBe(true);
    expect(isCodeShaped('MAX_RATE', '')).toBe(true);
    expect(isCodeShaped('v2', '')).toBe(true);
    expect(isCodeShaped('call', 'which files call x')).toBe(false);
    expect(isCodeShaped('call', 'where is `call` used')).toBe(true);
  });

  it("quotes the named symbol's own signature first, so the budget keeps it", () => {
    const pack = ask(Q, 700);
    const sigs = pack.currentBehavior.flatMap((b) => b.signatures.map((s) => s.name));
    expect(sigs[0]).toBe('computeTotal');
  });
});

// ------------------------------------------------------------------ call-site coverage

describe('call-site coverage survives a tight budget', () => {
  const Q = 'Which files call computeTotal, and what would break if it gained a required parameter?';
  const CALLERS = ['src/services/pricingEngine.ts', 'src/reports/pricingReport.ts', 'src/checkout/cartTotals.ts'];

  it('lists every call of the named symbol ahead of references to its types', () => {
    const sites = ask(Q).callSites;
    const calls = sites.filter((c) => c.symbol === 'computeTotal').map((c) => c.from);
    expect(calls.sort()).toEqual([...CALLERS].sort());
    // Priority order: all named calls come before any other reference.
    const firstOther = sites.findIndex((c) => c.symbol !== 'computeTotal');
    const lastNamed = sites.map((c) => c.symbol).lastIndexOf('computeTotal');
    if (firstOther !== -1) expect(lastNamed).toBeLessThan(firstOther);
  });

  it('keeps every named call under a budget that trims call sites', () => {
    const pack = ask(Q, 700);
    expect(pack.diagnostics.sectionsTruncated.length).toBeGreaterThan(0);
    const calls = pack.callSites.filter((c) => c.symbol === 'computeTotal').map((c) => c.from);
    expect(calls.sort()).toEqual([...CALLERS].sort());
  });

  it('gives each file of a named directory a call site, and a call before a type reference', () => {
    const pack = ask('The three pricing implementations under src/lib/ — which of them does checkout reach?', 900);
    const targets = new Set(pack.callSites.map((c) => c.target));
    for (const f of ['src/lib/pricingRules.ts', 'src/lib/discountRules.ts', 'src/lib/taxCalculation.ts']) {
      expect(targets.has(f), `no call site kept for ${f}`).toBe(true);
    }
    // pricingRules is referenced as a type above its call; the call is what survives first.
    const forRules = pack.callSites.filter((c) => c.target === 'src/lib/pricingRules.ts');
    expect(forRules[0]!.symbol).toBe('computeTotal');
  });

  it('renders call sites grouped by file, whatever their priority order', () => {
    const lines = service.renderContextPack(ask(Q)).split('\n');
    const start = lines.indexOf('- used at:');
    expect(start).toBeGreaterThan(-1);
    const used: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (!/^ {4}\S+:\d+ {2}/.test(l)) break;
      used.push(l.trim().split(':')[0]!);
    }
    expect(used.length).toBeGreaterThan(1);
    expect(used).toEqual([...used].sort());
  });
});

// ------------------------------------------------------------------ sibling clauses

describe('clauses that describe a named target do not add tied guesses', () => {
  it('drops tied lexical guesses when the request names its target outright', () => {
    const pack = ask('In src/lib/pricingRules.ts; describe what the exported functions do; what inputs they handle');
    expect(pack.target.files).toEqual(['src/lib/pricingRules.ts']);
  });

  it('keeps a second subject that the words single out', () => {
    const pack = ask('update src/lib/pricingRules.ts and keep the audit ledger behaviour');
    expect(pack.target.files).toContain('src/lib/pricingRules.ts');
    expect(pack.target.files).toContain('src/audit/auditLedger.ts');
  });

  it('does not change a request that names nothing outright', () => {
    // Every clause is a guess: nothing is dropped, because nothing was named instead.
    expect(ask('handle inputs in the panel').target.files.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ DECLARED memory

describe('DECLARED memory reads as a claim; VERIFIED evidence stays authoritative', () => {
  const Q = 'src/lib/pricingRules.ts';

  it('renders a DECLARED record statement as the record\'s words, with a verification notice', () => {
    const text = service.renderContextPack(ask(Q));
    expect(text).toContain(DECLARED_RECORD_NOTICE);
    expect(DECLARED_RECORD_NOTICE).toMatch(/unverified/i);
    expect(DECLARED_RECORD_NOTICE).toMatch(/Do not extend it/);
    // The record's own "Recorded from Git history" is inside the quotation: it is the claim.
    expect(text).toMatch(/\(DECLARED\) \[REC-CLAIM\][^\n]* UNVERIFIED CLAIM: "Recorded from Git history\./);
  });

  it('prints the notice once, however many record sections carry claims', () => {
    const text = service.renderContextPack(ask(Q));
    expect(text.split(DECLARED_RECORD_NOTICE).length - 1).toBe(1);
    expect((text.match(/UNVERIFIED CLAIM: "/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('never converts DECLARED to VERIFIED, and never rewrites the statement itself', () => {
    const pack = ask(Q);
    const mine = [...pack.decisionsAndConstraints, ...pack.previousAttempts, ...pack.consequences]
      .filter((s) => s.evidence.includes('REC-CLAIM'));
    expect(mine.length).toBeGreaterThan(0);
    for (const s of mine) {
      expect(s.provenance).toBe('DECLARED');
      // The framing is rendering only; the structured statement is untouched.
      expect(s.statement).not.toContain(DECLARED_CLAIM_HEADER);
    }
  });

  it('leaves VERIFIED lines unframed', () => {
    const text = service.renderContextPack(ask(Q));
    for (const line of text.split('\n').filter((l) => l.includes('(VERIFIED)'))) {
      expect(line).not.toContain(DECLARED_CLAIM_HEADER);
    }
    // What VERIFIED means is stated by the legend every pack carries.
    expect(text).toContain('VERIFIED = exact git/file content');
  });

  it('adds no notice to a pack with no DECLARED record statement', () => {
    const text = service.renderContextPack(ask('src/audit/auditLedger.ts'));
    expect(text).not.toContain(DECLARED_RECORD_NOTICE);
    expect(text).not.toContain(DECLARED_CLAIM_HEADER);
  });

  // One test per budget, so each builds at most one pack; the assertions are the loop's.
  it.each([500, 700, 900, 1200])('under a budget that bites (%i tokens), yields the notice before any evidence, and keeps the boundary', (budget) => {
    const pack = ask(Q, budget);
    const text = service.renderContextPack(pack);
    const order = pack.diagnostics.sectionsTruncated;
    // The notice is the first thing the budget removes: nothing is trimmed before it.
    if (order.includes(FRAMING_STEP)) expect(order.indexOf(FRAMING_STEP)).toBe(0);
    // Notice or not, a record line stays labelled, bounded and quoted.
    for (const line of text.split('\n').filter((l) => l.includes('[REC-CLAIM]') && l.startsWith('- ('))) {
      expect(line).toMatch(/^- \(DECLARED\) \[REC-CLAIM\][^\n]* UNVERIFIED CLAIM: "/);
    }
    expect(estimateTokens(text) <= budget || pack.diagnostics.budgetExceeded).toBe(true);
  });

  it.each([500, 700, 900, 1200, 1600])('restores the notice when trimming later made room for it (%i tokens)', (budget) => {
    // Whenever the framing is compacted in the final pack, putting it back must not fit.
    const pack = ask(Q, budget);
    if (!pack.diagnostics.claimsCompact) return;
    const restored = { ...pack, diagnostics: { ...pack.diagnostics, claimsCompact: false } };
    expect(estimateTokens(service.renderContextPack(restored))).toBeGreaterThan(budget);
  });
});
