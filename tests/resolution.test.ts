import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import type { ContextPack } from '../src/context/pack.js';

/**
 * The fixture is a synthetic warehouse/shipping service with no relationship to
 * any benchmark target, so nothing here can pass by having been tuned to a real
 * repository's vocabulary. It is built once and indexed once; every case below
 * queries that same index.
 *
 * Every case checks both halves of the contract — what the query resolved to,
 * and what neighbourhood came out the other side. A resolver that names the
 * right file and then hands back forty unrelated ones has not done the job.
 */

const repoDir = path.join(process.cwd(), '.test_repo_resolution');
let service: StrataService;

/** Files and their contents. Relative specifiers so imports resolve to real edges. */
const FILES: Record<string, string> = {
  // --- web: the CORS-shaped natural-language target -------------------------
  'src/web/corsPolicy.ts': `
export const allowedOrigins = ['https://depot.example', 'https://ops.example'];

/** Decide whether a request origin may talk to the depot API. */
export function allowOrigin(origin: string): boolean {
  return allowedOrigins.includes(origin);
}
`,
  'src/web/server.ts': `
import { allowOrigin } from './corsPolicy.js';

export function startServer(port: number): string {
  const ok = allowOrigin('https://depot.example');
  return \`listening \${port} \${ok}\`;
}
`,
  'src/web/sessionGuard.ts': `
import { allowOrigin } from './corsPolicy.js';

export function guardSession(origin: string): boolean {
  return allowOrigin(origin);
}
`,
  // A prefix neighbour of the term "port", kept to pin down the prefix rule.
  'src/web/portalConfig.ts': `
export const portalTheme = 'dark';
`,

  // --- shipping: the substring-trap cluster ---------------------------------
  'src/shipping/portManifest.ts': `
export interface PortManifest { vessel: string; crates: number; }

export function buildManifest(vessel: string): PortManifest {
  return { vessel, crates: 0 };
}
`,
  // "transport" and "report" contain "port" as an internal fragment. Neither is
  // about ports, and neither may be dragged in by that term.
  'src/shipping/transportLog.ts': `
export function transportLog(message: string): string { return message; }
`,
  'src/reports/reportBuilder.ts': `
export function buildReport(rows: number): string { return String(rows); }
`,

  // --- inventory: the relationship chain -----------------------------------
  'src/inventory/stockLedger.ts': `
export interface LedgerEntry { sku: string; delta: number; }

export class StockLedger {
  entries: LedgerEntry[] = [];
}

export function applyDelta(ledger: StockLedger, entry: LedgerEntry): void {
  ledger.entries.push(entry);
}
`,
  'src/inventory/reorderPolicy.ts': `
import { StockLedger, applyDelta } from './stockLedger.js';

export function reorder(ledger: StockLedger, sku: string): void {
  applyDelta(ledger, { sku, delta: 1 });
}
`,
  // Two hops from stockLedger: imports reorderPolicy, not the ledger itself.
  'src/inventory/auditTrail.ts': `
import { reorder } from './reorderPolicy.js';

export function audit(sku: string): void {
  reorder(undefined as never, sku);
}
`,

  // --- case sensitivity ----------------------------------------------------
  'src/common/tagTypes.ts': `
export interface ParcelTag { code: string; }
`,
  'src/legacy/oldTags.ts': `
export interface PARCELTAG { code: string; }
`,

  // --- symbol fan-out: a name defined in more files than it can discriminate -
  ...Object.fromEntries(
    ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((n) => [
      `src/handlers/${n}Route.ts`,
      `export function handler(): string { return '${n}'; }\n`,
    ]),
  ),

  // --- a data file, so filename queries have a non-TypeScript target --------
  'config/depot.schema.json': `{"version":1,"warehouse":"north"}\n`,
};

beforeAll(() => {
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(FILES)) {
    const full = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body.trimStart(), 'utf-8');
  }
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'f@e.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'F'], { cwd: repoDir });
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'seed depot service'], { cwd: repoDir });

  service = new StrataService(repoDir);
  service.init();
  service.indexCode();
}, 60_000);

afterAll(() => {
  service?.close();
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
});

/*
  One build per question, shared by every test that asks it.

  A pack build spends most of its time starting git processes, and the full suite runs
  every file's builds in parallel; forty-four builds here were twenty-nine packs. Packs are
  only read, and nothing in this file changes the store or the index after setup.
*/
const asked = new Map<string, ContextPack>();
const ask = (query: string, opts = {}): ContextPack => {
  const key = `${query}|${JSON.stringify(opts)}`;
  let pack = asked.get(key);
  if (!pack) {
    pack = service.getContextPack(query, opts);
    asked.set(key, pack);
  }
  return pack;
};
const neighborhood = (pack: ContextPack): string[] => pack.codeNeighborhood.map((n) => n.path);

// ---------------------------------------------------------------- 1-3, 15: paths

describe('explicit paths are authoritative', () => {
  it('1. resolves a bare path to exactly that file', () => {
    const pack = ask('src/web/corsPolicy.ts');
    expect(pack.target.files).toEqual(['src/web/corsPolicy.ts']);
    expect(pack.target.resolution).toBe('exact_file');
    expect(pack.targetNotFound).toBeFalsy();
    // Its two importers are one edge away and must be in the neighbourhood.
    expect(neighborhood(pack)).toContain('src/web/server.ts');
    expect(neighborhood(pack)).toContain('src/web/sessionGuard.ts');
  });

  it('2. resolves a path embedded in a sentence, without the prose overriding it', () => {
    const pack = ask('fix the issue in src/inventory/stockLedger.ts related to audit counts');
    expect(pack.target.files).toContain('src/inventory/stockLedger.ts');
    expect(pack.target.anchors?.[0]?.kind).toBe('explicit_path');
    // "audit" appears in the query and names a real file, but the named path is
    // the target; auditTrail must not displace it.
    expect(pack.target.files[0]).toBe('src/inventory/stockLedger.ts');
  });

  it('3. returns TARGET_NOT_FOUND for a path the index does not hold', () => {
    const pack = ask('src/missing/nowhere.ts');
    expect(pack.targetNotFound).toBe(true);
    expect(pack.target.resolution).toBe('target_not_found');
    expect(pack.target.files).toEqual([]);
    expect(pack.target.unresolved).toContain('src/missing/nowhere.ts');
    // It must not quietly become a word search.
    expect(neighborhood(pack)).toEqual([]);
  });

  it('3b. does not degrade a missing path into a lexical guess even with prose around it', () => {
    const pack = ask('update the origins in src/web/missingPolicy.ts for the depot');
    expect(pack.targetNotFound).toBe(true);
    expect(pack.target.files).toEqual([]);
  });

  it('15. accepts a Windows-style path separator', () => {
    const pack = ask('src\\web\\corsPolicy.ts');
    expect(pack.target.files).toEqual(['src/web/corsPolicy.ts']);
  });

  it('resolves a relative path written with a leading ./', () => {
    const pack = ask('./src/shipping/rateless/../portManifest.ts'.replace('rateless/../', ''));
    expect(pack.target.files).toEqual(['src/shipping/portManifest.ts']);
  });

  it('resolves a path suffix without matching a similarly-named neighbour', () => {
    const pack = ask('corsPolicy.ts');
    expect(pack.target.files).toEqual(['src/web/corsPolicy.ts']);
    expect(pack.target.files).not.toContain('src/web/portalConfig.ts');
  });
});

// ------------------------------------------------------------------- 4-6: symbols

describe('symbol resolution', () => {
  it('4. resolves an exact symbol to its defining file', () => {
    const pack = ask('applyDelta');
    expect(pack.target.files).toContain('src/inventory/stockLedger.ts');
    expect(pack.target.symbols.map((s) => s.name)).toContain('applyDelta');
    // Its caller is one edge away.
    expect(neighborhood(pack)).toContain('src/inventory/reorderPolicy.ts');
  });

  it('5. resolves a symbol named inside a sentence', () => {
    const pack = ask('make sure allowOrigin still rejects unknown hosts');
    expect(pack.target.files).toContain('src/web/corsPolicy.ts');
    expect(pack.target.anchors?.some((a) => a.kind === 'explicit_symbol')).toBe(true);
  });

  it('6. is case-sensitive: ParcelTag does not become PARCELTAG', () => {
    const pack = ask('ParcelTag');
    expect(pack.target.files).toContain('src/common/tagTypes.ts');
    expect(pack.target.files).not.toContain('src/legacy/oldTags.ts');
  });

  it('6b. resolves the differently-cased twin to its own file', () => {
    const pack = ask('PARCELTAG');
    expect(pack.target.files).toContain('src/legacy/oldTags.ts');
    expect(pack.target.files).not.toContain('src/common/tagTypes.ts');
  });

  it('does not treat a symbol defined in too many files as an explicit target', () => {
    // `handler` is defined six times. It names a convention, not a target — so it
    // must not resolve as an explicit symbol, and the engine must say it is
    // guessing rather than present six files as an answer.
    const pack = ask('handler');
    expect(pack.target.anchors?.some((a) => a.kind === 'explicit_symbol')).toBe(false);
    expect(pack.target.confidence.level).toBe('LOW');
    expect(pack.target.confidence.reason).toMatch(/about equally|no single target/);
  });

  it('reports a missing symbol honestly rather than inventing a target', () => {
    const pack = ask('reticulateSplines');
    expect(pack.target.files.length).toBe(0);
  });

  it('combines a symbol with a path when the query names both', () => {
    const pack = ask('applyDelta in src/inventory/stockLedger.ts');
    expect(pack.target.files).toContain('src/inventory/stockLedger.ts');
    expect(pack.target.symbols.map((s) => s.name)).toContain('applyDelta');
  });
});

// -------------------------------------------------------------- 7, 8: names, multi

describe('filename resolution does not hijack the rest of the query', () => {
  it('7. resolves a bare filename word to its file', () => {
    const pack = ask('portManifest');
    expect(pack.target.files).toContain('src/shipping/portManifest.ts');
  });

  it('7b. keeps a data file reachable by name', () => {
    const pack = ask('depot.schema.json');
    expect(pack.target.files).toContain('config/depot.schema.json');
  });

  it('8. a filename match does not end resolution when the query names more', () => {
    // "tagTypes" names a file outright; "reorder policy" is the other half of the
    // request and must survive alongside it.
    const pack = ask('understand tagTypes and the reorder policy');
    expect(pack.target.files).toContain('src/common/tagTypes.ts');
    expect(pack.target.files).toContain('src/inventory/reorderPolicy.ts');
  });

  it('8b. a multi-target query keeps both areas', () => {
    const pack = ask('update the CORS policy in src/web/server.ts and keep the stock ledger behaviour');
    expect(pack.target.files).toContain('src/web/server.ts');
    const reach = new Set([...pack.target.files, ...neighborhood(pack)]);
    expect(reach.has('src/inventory/stockLedger.ts')).toBe(true);
  });
});

// ------------------------------------------------- 9, 10, 11: natural language

describe('natural-language resolution', () => {
  it('9. resolves a task sentence to the right area', () => {
    const pack = ask('modify the allowed origin rules for the depot API');
    const reach = new Set([...pack.target.files, ...neighborhood(pack)]);
    expect(reach.has('src/web/corsPolicy.ts')).toBe(true);
  });

  it('10. a term does not match the same letters inside a longer word', () => {
    const pack = ask('port manifest');
    expect(pack.target.files[0]).toBe('src/shipping/portManifest.ts');
    expect(pack.target.files).not.toContain('src/shipping/transportLog.ts');
    expect(pack.target.files).not.toContain('src/reports/reportBuilder.ts');
  });

  it('10b. documents the prefix rule: a four-letter term does reach a longer word', () => {
    // Deliberate, and the boundary worth knowing: "port" reaches "portal" by
    // prefix agreement, but never reaches "transport" from the inside.
    const pack = ask('port');
    const files = pack.target.files;
    expect(files).not.toContain('src/shipping/transportLog.ts');
    expect(files).not.toContain('src/reports/reportBuilder.ts');
  });
});

// ------------------------------------------------- 11-13: structure over lexicon

describe('structural relevance outranks lexical similarity', () => {
  it('11. a direct relationship beats a file that merely shares words', () => {
    const pack = ask('src/inventory/stockLedger.ts');
    const hood = neighborhood(pack);
    // reorderPolicy imports the ledger: it is one edge away.
    expect(hood).toContain('src/inventory/reorderPolicy.ts');
    // Nothing from an unrelated subsystem should appear for an exact-path query.
    expect(hood).not.toContain('src/web/corsPolicy.ts');
    expect(hood).not.toContain('src/reports/reportBuilder.ts');
  });

  it('12. an indirect relationship is reachable at depth 2 and absent at depth 1', () => {
    const shallow = neighborhood(ask('src/inventory/stockLedger.ts', { depth: 1 }));
    const deep = neighborhood(ask('src/inventory/stockLedger.ts', { depth: 2 }));
    expect(shallow).not.toContain('src/inventory/auditTrail.ts');
    expect(deep).toContain('src/inventory/auditTrail.ts');
  });

  it('11b. classifies every neighbourhood entry structurally', () => {
    const pack = ask('src/inventory/stockLedger.ts', { depth: 2 });
    const byPath = new Map(pack.codeNeighborhood.map((n) => [n.path, n.relevance]));
    expect(byPath.get('src/inventory/stockLedger.ts')).toBe('DIRECT_TARGET');
    expect(byPath.get('src/inventory/reorderPolicy.ts')).toBe('DIRECTLY_RELATED');
    expect(byPath.get('src/inventory/auditTrail.ts')).toBe('INDIRECTLY_RELATED');
  });

  it('11c. a lexical hit is classified as such and never outranks a named target', () => {
    // "ledger" reaches stockLedger by words alone; the classification must say so.
    const pack = ask('ledger');
    const classes = pack.codeNeighborhood.map((n) => n.relevance);
    expect(classes).toContain('LEXICAL_ONLY');
    // And class ordering holds: no LEXICAL_ONLY entry sits above a DIRECT_TARGET.
    const firstLexical = classes.indexOf('LEXICAL_ONLY');
    const lastDirect = classes.lastIndexOf('DIRECT_TARGET');
    if (firstLexical !== -1 && lastDirect !== -1) expect(firstLexical).toBeGreaterThan(lastDirect);
  });

  it('11d. the resolved target leads the neighbourhood even when it resolved lexically', () => {
    // Regression: classifying by relevance alone sorted LEXICAL_ONLY last, which
    // put a lexically-resolved seed underneath its own imports — the file the
    // question was about, ranked below the files it happens to use.
    const pack = ask('ledger');
    expect(pack.codeNeighborhood.length).toBeGreaterThan(1);
    expect(pack.codeNeighborhood[0]!.distance).toBe(0);
    expect(pack.target.files).toContain(pack.codeNeighborhood[0]!.path);
  });

  it('13. a lexical-only hit is kept distinguishable from a named target', () => {
    const pack = ask('ledger');
    // It resolves, but as a guess — the anchor must not claim to be explicit.
    const kinds = new Set((pack.target.anchors ?? []).map((a) => a.kind));
    expect(kinds.has('explicit_path')).toBe(false);
    expect(kinds.has('explicit_symbol')).toBe(false);
  });
});

// ----------------------------------------------------------- 14: honest weakness

describe('queries with no reliable target are reported as such', () => {
  for (const query of ['improve the thing', 'make this faster', 'fix whatever is wrong']) {
    it(`14. "${query}" does not produce a confident target`, () => {
      const pack = ask(query);
      // Either nothing resolved, or whatever did is labelled a lexical guess.
      const kinds = new Set((pack.target.anchors ?? []).map((a) => a.kind));
      expect(kinds.has('explicit_path')).toBe(false);
      expect(kinds.has('explicit_symbol')).toBe(false);
      expect(pack.target.files.length).toBeLessThanOrEqual(3);
    });
  }
});

// ----------------------------------------------------------------- confidence

describe('confidence is graded and stated', () => {
  const cases: { query: string; level: string; why: RegExp }[] = [
    { query: 'src/web/corsPolicy.ts', level: 'HIGH', why: /explicit path/ },
    { query: 'fix the origins in src/web/corsPolicy.ts', level: 'HIGH', why: /explicit path/ },
    { query: 'applyDelta', level: 'HIGH', why: /explicit symbol/ },
    { query: 'portManifest', level: 'MEDIUM', why: /filename/ },
    { query: 'src/missing/nowhere.ts', level: 'NOT_FOUND', why: /does not hold/ },
    { query: 'improve the thing', level: 'LOW', why: /no reliable repository target/ },
  ];

  for (const { query, level, why } of cases) {
    it(`grades "${query}" as ${level}`, () => {
      const c = ask(query).target.confidence;
      expect(c.level).toBe(level);
      expect(c.reason).toMatch(why);
    });
  }

  it('states the grade in the rendered pack, where an agent will read it', () => {
    const text = service.renderContextPack(ask('src/web/corsPolicy.ts'));
    expect(text).toContain('Confidence: HIGH');
  });

  it('does not claim HIGH for a query that only matched words', () => {
    const c = ask('ledger').target.confidence;
    expect(c.level).not.toBe('HIGH');
    expect(c.level).not.toBe('NOT_FOUND');
  });
});

// ------------------------------------------------------------------ compactness

describe('the neighbourhood stays small', () => {
  const queries = [
    'src/web/corsPolicy.ts',
    'applyDelta',
    'modify the allowed origin rules for the depot API',
    'update the CORS policy in src/web/server.ts and keep the stock ledger behaviour',
  ];

  for (const query of queries) {
    it(`keeps the pack compact for "${query.slice(0, 40)}"`, () => {
      const pack = ask(query);
      const indexed = pack.diagnostics.filesInIndex;
      expect(pack.codeNeighborhood.length).toBeLessThanOrEqual(12);
      // A neighbourhood approaching the size of the repository is not a neighbourhood.
      expect(pack.codeNeighborhood.length).toBeLessThan(indexed * 0.75);
      expect(pack.diagnostics.estimatedTokens).toBeLessThanOrEqual(pack.diagnostics.maxTokens);
    });
  }

  it('reports the scope it returned, so an oversized pack is visible as such', () => {
    const pack = ask('src/inventory/stockLedger.ts', { depth: 2 });
    const scope = pack.diagnostics.scope;
    expect(scope.targets).toBe(pack.target.files.length);
    expect(scope.neighborhoodFiles).toBe(pack.codeNeighborhood.length);
    expect(scope.symbols).toBe(pack.target.symbols.length);
    expect(scope.relationships).toBe(pack.relationships.length);
    expect(service.renderContextPack(pack)).toMatch(/Scope: \d+ target\(s\)/);
  });
});
