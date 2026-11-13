import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import {
  DECLARED_RECORD_NOTICE, DECLARED_CLAIM_HEADER, UNKNOWN_DECISION_NOTICE,
} from '../src/context/pack.js';

/**
 * Provenance boundaries that a reader cannot merge with its own inference.
 *
 * Measured failure: a DECLARED record said some origins came from "the … frontend …
 * expected on port 5173"; an agent quoted it correctly and then wrote, in its own voice,
 * that the frontend had been built on a particular tool and later migrated — none of which
 * the record said. Separately, a decision marked UNKNOWN was credited with a feature it
 * never contained.
 *
 * The fixture reproduces the shape with its own names: a record that mentions a port and
 * an era without naming any technology, and a history in which one change was partly
 * rewritten, so its status is genuinely UNKNOWN. Nothing below refers to the repository
 * the failure was measured on.
 */

const repoDir = path.join(process.cwd(), '.test_repo_provenance_bounds');
let service: StrataService;

const git = (...a: string[]): string => execFileSync('git', a, { cwd: repoDir, encoding: 'utf-8' });
const write = (rel: string, lines: string[]): void => {
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, lines.join('\n') + '\n', 'utf-8');
};
const commit = (msg: string): void => { git('add', '-A'); git('commit', '-q', '-m', msg); };

// The record's exact words. Short enough to render uncapped, so exactness is checkable.
const CLAIM = 'The origins on port 4321 date from the earlier client era; a later commit moved the default to port 8080.';
const LONG_CLAIM = 'y'.repeat(900);
const PAIR_CLAIM = 'Both entry points were meant to share the check from the start; the older one was converted last.';

beforeAll(() => {
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  fs.mkdirSync(repoDir, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture Author');

  write('src/net/origins.ts', [
    "export const DEFAULT_PORT = 4321;",
    "export const ORIGINS = ['http://localhost:4321', 'http://127.0.0.1:4321'];",
    'export function allowed(origin: string): boolean { return ORIGINS.includes(origin); }',
  ]);
  commit('serve the client');
  // A change that is later partly rewritten: its status cannot be established.
  write('src/net/origins.ts', [
    'export const DEFAULT_PORT = 8080;',
    "export const ORIGINS = ['http://localhost:4321', 'http://127.0.0.1:4321', 'http://localhost:8080'];",
    'export function allowed(origin: string): boolean { return ORIGINS.includes(origin); }',
  ]);
  commit('move the default port');
  write('src/net/origins.ts', [
    'export const DEFAULT_PORT = 8080;',
    "export const ORIGINS = Array.from(new Set(['http://localhost:4321', 'http://localhost:8080']));",
    'export function allowed(origin: string): boolean { return ORIGINS.includes(origin); }',
  ]);
  commit('dedupe the origins');
  // Callers in other files, so a symbol query crosses files and a directory query spans them.
  write('src/net/server.ts', [
    "import { allowed, DEFAULT_PORT } from './origins';",
    'export function accept(origin: string): number { return allowed(origin) ? DEFAULT_PORT : -1; }',
  ]);
  write('src/net/proxy.ts', [
    "import { allowed } from './origins';",
    'export function forward(origin: string): boolean { return allowed(origin); }',
  ]);
  commit('route requests through the origin check');

  service = new StrataService(repoDir);
  service.init();
  service.indexCode();
  service.recordChange({
    id: 'REC-PORT',
    title: 'origins.ts: the 4321 origins are older than the default port',
    intent: CLAIM,
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/net/origins.ts', changeType: 'modify' }],
    attempts: [{ approach: 'Serve the client on 4321', status: 'superseded',
                 failureReason: 'The default moved to 8080.', confidence: 'DECLARED' }],
    consequences: [{ statement: LONG_CLAIM, confidence: 'DECLARED', evidence: [] }],
    result: { status: 'success' },
  });
  // A record that spans two files, like one written about a module's layout.
  service.recordChange({
    id: 'REC-PAIR',
    title: 'server.ts and proxy.ts share one origin check',
    intent: PAIR_CLAIM,
    intentConfidence: 'DECLARED',
    files: [{ path: 'src/net/server.ts', changeType: 'add' }, { path: 'src/net/proxy.ts', changeType: 'add' }],
    attempts: [{ approach: 'Check origins separately in each entry point', status: 'superseded',
                 failureReason: 'The two lists drifted apart.', confidence: 'DECLARED' }],
    consequences: [{ statement: 'z'.repeat(700), confidence: 'DECLARED', evidence: [] }],
    result: { status: 'success' },
  });
}, 60_000);

afterAll(() => {
  service?.close();
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
});

const Q = 'src/net/origins.ts';
/*
  One build per budget, shared by every test that asks for it.

  A pack build spends most of its time starting git processes, and the full suite runs
  every file's builds in parallel; some fifteen tests here read the same full pack. Packs
  are only read and rendered — a test that needs a variant renders a copy — and nothing
  in this file changes the store or the index after setup.
*/
const rendered = new Map<number, { pack: ReturnType<StrataService['getContextPack']>; text: string }>();
const render = (maxTokens = 40_000): { pack: ReturnType<StrataService['getContextPack']>; text: string } => {
  let built = rendered.get(maxTokens);
  if (!built) {
    const pack = service.getContextPack(Q, { maxTokens });
    built = { pack, text: service.renderContextPack(pack) };
    rendered.set(maxTokens, built);
  }
  return built;
};
const lines = (text: string): string[] => text.split('\n');

describe('a DECLARED claim is the record\'s words, bounded', () => {
  it('1. quotes the claim exactly', () => {
    const { text } = render();
    expect(text).toContain(`"${CLAIM}"`);
  });

  it('2. marks every DECLARED record claim UNVERIFIED on its own line', () => {
    // Record statements, not lines that merely cite the record as evidence.
    const claimLines = lines(render().text).filter((l) => /^- \(\w+\) \[REC-PORT\]/.test(l));
    expect(claimLines.length).toBeGreaterThan(0);
    for (const l of claimLines) {
      expect(l).toMatch(/^- \(DECLARED\) \[REC-PORT\]/);
      expect(l).toContain(DECLARED_CLAIM_HEADER);
      expect(DECLARED_CLAIM_HEADER).toMatch(/UNVERIFIED/);
    }
  });

  it('3. states, before the claims, that a claim may not be extended', () => {
    const text = render().text;
    expect(DECLARED_RECORD_NOTICE).toMatch(/The quoted text is the record's claim\. Do not extend it/);
    expect(DECLARED_RECORD_NOTICE).toMatch(/not stated or independently evidenced/);
    const notice = text.indexOf(DECLARED_RECORD_NOTICE);
    const firstClaim = text.indexOf(DECLARED_CLAIM_HEADER);
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(firstClaim);
    expect(text.split(DECLARED_RECORD_NOTICE).length - 1).toBe(1);
  });

  it('never upgrades the claim: its words appear only inside a DECLARED quotation', () => {
    const { pack, text } = render();
    for (const l of lines(text).filter((x) => x.includes('port 4321 date from'))) {
      expect(l).toMatch(/^- \(DECLARED\) \[REC-PORT\][^\n]* UNVERIFIED CLAIM: "/);
    }
    // The structured statement is unchanged and still DECLARED; the framing is rendering only.
    const intent = pack.decisionsAndConstraints.find((s) => s.evidence.includes('REC-PORT'))!;
    expect(intent.provenance).toBe('DECLARED');
    expect(intent.statement).toContain(CLAIM);
    expect(intent.statement).not.toContain(DECLARED_CLAIM_HEADER);
  });
});

describe('UNKNOWN is rendered as NOT ESTABLISHED, never as a softer positive', () => {
  it('4. marks an UNKNOWN decision NOT ESTABLISHED and does not call it a decision', () => {
    const { pack, text } = render();
    const unknown = pack.historicalDecisions.filter((d) => d.status === 'UNKNOWN');
    expect(unknown.length, 'fixture must produce an UNKNOWN decision').toBeGreaterThan(0);
    for (const d of unknown) {
      expect(text).toContain(`changed in ${d.commit}`);
      expect(text).not.toContain(`decided in ${d.commit}`);
    }
    expect(text).toContain('STATUS: UNKNOWN — NOT ESTABLISHED  (UNKNOWN)');
    expect(text).toContain(UNKNOWN_DECISION_NOTICE);
    expect(UNKNOWN_DECISION_NOTICE).toMatch(/does not establish this attribution/);
  });

  const uncertaintyItems = (text: string): { heading?: string; items: string[] } => {
    const all = lines(text);
    const start = all.findIndex((l) => l.startsWith('## UNCERTAINTY'));
    if (start < 0) return { items: [] };
    const items: string[] = [];
    for (const l of all.slice(start + 1)) {
      if (!l.startsWith('- ')) break;
      items.push(l);
    }
    return { heading: all[start], items };
  };

  it('states every uncertainty exactly once, as NOT ESTABLISHED', () => {
    const { pack, text } = render();
    expect(pack.uncertainty.length).toBeGreaterThan(0);
    const { heading, items } = uncertaintyItems(text);
    if (heading) expect(heading).toContain('NOT ESTABLISHED');
    for (const l of items) expect(l).toMatch(/^- UNKNOWN — /);
    const unknown = pack.historicalDecisions.filter((d) => d.status === 'UNKNOWN');
    for (const u of pack.uncertainty) {
      const listed = items.includes(`- UNKNOWN — ${u}`);
      // An item that restates an UNKNOWN decision is carried by that decision's own block.
      const restates = unknown.find((d) => u.includes(`change ${d.commit} made to ${d.path}`));
      if (restates) {
        expect(listed, 'said once, where the decision is').toBe(false);
        expect(text).toContain(`changed in ${restates.commit}`);
      } else {
        expect(listed).toBe(true);
      }
    }
  });

  it('lists a restated uncertainty again when its decision is not rendered', () => {
    const { pack } = render();
    expect(pack.historicalDecisions.some((d) => d.status === 'UNKNOWN')).toBe(true);
    // Rendering only: the same pack with its decisions left out.
    const text = service.renderContextPack({ ...pack, historicalDecisions: [] });
    const { heading, items } = uncertaintyItems(text);
    expect(heading).toContain('NOT ESTABLISHED');
    expect(items).toEqual(pack.uncertainty.map((u) => `- UNKNOWN — ${u}`));
  });
});

describe('VERIFIED evidence stays authoritative and unchanged', () => {
  it('5. renders a VERIFIED decision exactly as before, with no claim or uncertainty framing', () => {
    const { pack, text } = render();
    const verified = pack.historicalDecisions.filter((d) => d.status !== 'UNKNOWN');
    for (const d of verified) {
      expect(text).toContain(`decided in ${d.commit}`);
      expect(text).toContain(`STATUS: ${d.status}  (${d.statusProvenance})`);
    }
    for (const l of lines(text).filter((x) => x.includes('(VERIFIED)'))) {
      expect(l).not.toContain(DECLARED_CLAIM_HEADER);
      expect(l).not.toContain('NOT ESTABLISHED');
    }
    // What VERIFIED means is stated by the legend every pack carries.
    expect(text).toContain('VERIFIED = exact git/file content');
  });
});

/*
  The minimum boundary, under any budget.

  Measured on six real packs at the delivery budget: two of them compacted their framing
  to a label and quotation marks — `(DECLARED) [REC-n] … "…"` — which no longer says the
  text is an unverified claim. The notice may go; the boundary on the line may not. Three
  request shapes, as the real packs had them: a file, a symbol whose callers are in other
  files, and a directory whose record spans two files.
*/
const SHAPES = {
  file: Q,
  'symbol across files': 'Which callers depend on allowed, and what would break if its signature changed?',
  'directory with a two-file record': 'How are the entry points in src/net organised around the origin check?',
} as const;
type Shape = keyof typeof SHAPES;
const BOUNDED = /^- \(DECLARED\) \[REC-[^\]]+\][^\n]* UNVERIFIED CLAIM: "/;

/** Every rendered record claim carries the boundary, and none is left out of the count. */
const expectBoundary = (pack: ReturnType<StrataService['getContextPack']>, text: string): void => {
  const recordLines = lines(text).filter((l) => /^- \(\w+\) \[REC-/.test(l));
  const declared = [...pack.decisionsAndConstraints, ...pack.constraints, ...pack.previousAttempts,
                    ...pack.consequences].filter((s) => s.provenance === 'DECLARED' && s.statement.startsWith('[REC-'));
  expect(recordLines.length).toBe(declared.length);
  for (const l of recordLines) expect(l).toMatch(BOUNDED);
  const unknown = pack.historicalDecisions.filter((d) => d.status === 'UNKNOWN').length;
  expect((text.match(/STATUS: UNKNOWN — NOT ESTABLISHED {2}\(/g) ?? []).length).toBe(unknown);
};

describe('a minimum provenance boundary survives every budget', () => {
  const cases = (Object.keys(SHAPES) as Shape[]).flatMap((shape) =>
    [400, 1000, 1500, 40_000].map((budget) => [shape, budget] as const));
  // One pack per test, so each fits its timeout on a slow machine.
  it.each(cases)('%s at %i tokens: every claim DECLARED + UNVERIFIED, every UNKNOWN NOT ESTABLISHED', (shape, budget) => {
    const pack = service.getContextPack(SHAPES[shape], { maxTokens: budget });
    const text = service.renderContextPack(pack);
    expect(lines(text).some((l) => BOUNDED.test(l)), 'the pack shows a record claim').toBe(true);
    expectBoundary(pack, text);
  });

  it.each(Object.keys(SHAPES) as Shape[])('%s: a budget that removes the notices keeps the boundary', (shape) => {
    const pack = service.getContextPack(SHAPES[shape], { maxTokens: 1500 });
    const text = service.renderContextPack(pack);
    // Stated, not hoped for: at this budget the notices are gone.
    expect(pack.diagnostics.claimsCompact).toBe(true);
    expect(text).not.toContain(DECLARED_RECORD_NOTICE);
    expect(text).not.toContain(UNKNOWN_DECISION_NOTICE);
    expect(pack.diagnostics.sectionsTruncated[0]).toBe('provenance-notices');
    expectBoundary(pack, text);
  });

  it('removing the notices changes no VERIFIED line and no claim boundary', () => {
    const { pack, text: full } = render();
    expect(pack.diagnostics.claimsCompact).not.toBe(true);
    const compact = service.renderContextPack({ ...pack, diagnostics: { ...pack.diagnostics, claimsCompact: true } });
    const removed = lines(full).filter((l) => !lines(compact).includes(l));
    // Exactly the two notices, nothing else.
    expect(removed.sort()).toEqual([DECLARED_RECORD_NOTICE, UNKNOWN_DECISION_NOTICE].sort());
    expect(lines(compact).filter((l) => !lines(full).includes(l))).toEqual([]);
    expectBoundary(pack, compact);
  });

  it('pays for the boundary with repeated attribution, not with evidence', () => {
    // A record line names its record and files once; the bracket keeps every other citation.
    const { pack, text } = render();
    const claims = [...pack.decisionsAndConstraints, ...pack.previousAttempts, ...pack.consequences]
      .filter((s) => s.evidence.includes('REC-PORT'));
    expect(claims.length).toBeGreaterThan(0);
    for (const s of claims) {
      // Structured evidence is untouched.
      expect(s.evidence).toContain('REC-PORT');
      expect(s.evidence).toContain(`file:${Q}`);
      const body = s.statement.slice(s.statement.indexOf(' — ') + 3).slice(0, 30);
      const line = lines(text).find((l) => l.startsWith('- (DECLARED) [REC-PORT]') && l.includes(body))!;
      expect(line, `rendered line for ${body}`).toBeTruthy();
      const bracket = /"(?: \[TRUNCATED — original \d+ chars\])? {2}\[([^\]]*)\]$/.exec(line)?.[1] ?? '';
      const shown = bracket ? bracket.split(', ') : [];
      expect(line).toMatch(new RegExp(`^- \\(DECLARED\\) \\[REC-PORT\\] ${Q.replace(/\./g, '\\.')} — `));
      expect(shown).not.toContain('REC-PORT');
      expect(shown).not.toContain(`file:${Q}`);
      expect(shown).toEqual(s.evidence.filter((e) => e !== 'REC-PORT' && e !== `file:${Q}`));
    }
  });

  it('keeps truncation explicit when the notices are gone', () => {
    const { pack } = render();
    const compact = service.renderContextPack({ ...pack, diagnostics: { ...pack.diagnostics, claimsCompact: true } });
    for (const n of [900, 700]) {
      const cut = lines(compact).find((l) => l.includes(`TRUNCATED — original ${n} chars`));
      expect(cut, `the ${n}-character claim is capped and says so`).toBeTruthy();
      expect(cut!).toMatch(BOUNDED);
      expect(cut!).toMatch(new RegExp(` …" \\[TRUNCATED — original ${n} chars\\]`));
    }
  });
});

describe('labels and truncation hold under a budget that bites', () => {
  // One budget per test: each builds one pack, so each fits its timeout on a slow machine.
  it.each([400, 600, 900, 1500])('6. keeps every provenance label at a %i-token budget', (budget) => {
    const { pack, text } = render(budget);
    for (const l of lines(text).filter((x) => /^- \(\w+\) \[REC-PORT\]/.test(x))) {
      expect(l).toMatch(/^- \(DECLARED\) \[REC-PORT\][^\n]* UNVERIFIED CLAIM: "/);
    }
    if (pack.historicalDecisions.some((d) => d.status === 'UNKNOWN')) {
      expect(text).toContain('UNKNOWN — NOT ESTABLISHED');
    }
    // A DECLARED statement is never shown under any other label.
    for (const s of [...pack.decisionsAndConstraints, ...pack.previousAttempts, ...pack.consequences]) {
      if (s.evidence.includes('REC-PORT')) expect(s.provenance).toBe('DECLARED');
    }
  });

  it('7. keeps truncation explicit and outside the quotation', () => {
    const text = render().text;
    const cut = lines(text).find((l) => l.includes('TRUNCATED — original 900 chars'));
    expect(cut, 'the 900-character claim is capped and says so').toBeTruthy();
    expect(cut!).toMatch(/ …" \[TRUNCATED — original 900 chars\]/);
  });
});

describe('the rule is generic', () => {
  it('8. hard-codes no repository, technology or task wording', () => {
    for (const text of [DECLARED_RECORD_NOTICE, DECLARED_CLAIM_HEADER, UNKNOWN_DECISION_NOTICE]) {
      expect(text).not.toMatch(/vite|next\.?js|react|spotify|youtube|cors|5173|3000|4321|8080|REC-\d/i);
    }
  });

  it('renders the same notice for any repository', () => {
    // The notice is a constant: it does not vary with what a record says or omits.
    const text = render().text;
    expect(text).toContain(DECLARED_RECORD_NOTICE);
    expect(DECLARED_RECORD_NOTICE).not.toContain(CLAIM.slice(0, 20));
  });
});
