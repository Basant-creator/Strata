import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { StrataMCPHandler } from '../src/mcp/server.js';
import { analyzeFile, resolveImport, discoverSourceFiles } from '../src/code/indexer.js';
import { ContextPack, estimateTokens } from '../src/context/pack.js';

/**
 * Context-engine tests against a purpose-built fixture repository.
 *
 * The fixture is a real git repository with a real commit history, not a mocked one.
 * The engine's whole claim is that it connects code relationships to development history,
 * and a fake history would let a broken join pass. Building one costs a few milliseconds.
 *
 * Shape of the fixture:
 *
 *     config.ts      defines authConfig            (no imports)
 *     server.ts      imports config.ts, references authConfig
 *     controller.ts  imports config.ts, references authConfig
 *     unrelated.ts   imports nothing, shares no symbol  <- must never enter the pack
 *
 * `unrelated.ts` is the control. Most of the ways this engine can go wrong end with it
 * appearing in a pack about the auth files.
 */
describe('Context Engine', () => {
  const repoDir = path.join(process.cwd(), '.test_repo_context');
  let service: StrataService;

  const write = (rel: string, body: string): void => {
    const abs = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf-8');
  };

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' });

  beforeAll(() => {
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(repoDir, { recursive: true });

    git('init', '-q');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'user.name', 'Fixture Author');

    write('src/config.ts', [
      'export interface AuthConfig { frontendUrl: string; port: number; }',
      "export const authConfig: AuthConfig = { frontendUrl: 'http://127.0.0.1:3000', port: 3001 };",
      '',
    ].join('\n'));
    write('src/unrelated.ts', [
      'export function computeTotals(values: number[]): number {',
      '  return values.reduce((a, b) => a + b, 0);',
      '}',
      '',
    ].join('\n'));
    git('add', '-A');
    git('commit', '-q', '-m', 'Add auth config with 5173 frontend default');

    write('src/server.ts', [
      "import { authConfig } from './config.js';",
      '',
      'export function startServer(): string {',
      '  return authConfig.frontendUrl;',
      '}',
      '',
    ].join('\n'));
    git('add', '-A');
    git('commit', '-q', '-m', 'Wire server to auth config');

    write('src/controller.ts', [
      "import { authConfig } from './config.js';",
      "import { startServer } from './server.js';",
      '',
      'export function handleCallback(): string {',
      '  startServer();',
      '  return authConfig.frontendUrl;',
      '}',
      '',
    ].join('\n'));
    git('add', '-A');
    git('commit', '-q', '-m', 'Add OAuth callback controller redirecting to frontendUrl');

    service = new StrataService(repoDir);
    service.init();
    service.indexCode();
  });

  afterAll(() => {
    service.close();
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- 1-2 indexing

  it('1. indexes source files and skips vendored directories', () => {
    fs.mkdirSync(path.join(repoDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'node_modules', 'pkg', 'index.ts'), 'export const x = 1;');
    const files = discoverSourceFiles(repoDir);
    expect(files).toContain('src/config.ts');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('2. indexes symbols with kind, line range and export flag', () => {
    const analysis = analyzeFile(repoDir, 'src/config.ts')!;
    const cfg = analysis.symbols.find((s) => s.name === 'authConfig')!;
    expect(cfg.kind).toBe('const');
    expect(cfg.exported).toBe(true);
    expect(cfg.startLine).toBeGreaterThan(0);
    expect(analysis.symbols.find((s) => s.name === 'AuthConfig')!.kind).toBe('interface');
  });

  // ---------------------------------------------------------------- 3-5 relationships

  it('3. records import relationships and resolves them to real files', () => {
    const analysis = analyzeFile(repoDir, 'src/server.ts')!;
    const imp = analysis.imports.find((i) => i.specifier === './config.js')!;
    expect(imp.toFile).toBe('src/config.ts');   // .js specifier -> .ts on disk
    expect(imp.resolution).toBe('VERIFIED');
  });

  it('3b. leaves package imports unresolved rather than guessing', () => {
    expect(resolveImport(repoDir, 'src/server.ts', 'express')).toBeNull();
    expect(resolveImport(repoDir, 'src/server.ts', './does-not-exist.js')).toBeNull();
  });

  it('4. records references and binds them to the importing file', () => {
    const analysis = analyzeFile(repoDir, 'src/server.ts')!;
    const ref = analysis.references.find((r) => r.symbolName === 'authConfig')!;
    expect(ref.toFile).toBe('src/config.ts');
    expect(ref.confidence).toBe('VERIFIED');
  });

  it('4b. does not link an unbound name to a same-named symbol elsewhere', () => {
    write('src/lookalike.ts', 'export function f(): void { authConfig; }\n');
    const analysis = analyzeFile(repoDir, 'src/lookalike.ts')!;
    const ref = analysis.references.find((r) => r.symbolName === 'authConfig');
    // The name matches a real exported symbol in config.ts, but nothing binds it here.
    if (ref) {
      expect(ref.toFile).toBeNull();
      expect(ref.confidence).toBe('UNKNOWN');
    }
    fs.rmSync(path.join(repoDir, 'src/lookalike.ts'));
  });

  it('5. links files to the commits that changed them', () => {
    const pack = service.getContextPack('src/config.ts', { depth: 1 });
    expect(pack.historicalContext.length).toBeGreaterThan(0);
    const subjects = pack.historicalContext.map((h) => h.subject).join(' | ');
    expect(subjects).toMatch(/auth config/i);
  });

  // ---------------------------------------------------------------- 6-7 resolution & expansion

  // One query kind per test, so each test builds one pack; the assertions are unchanged.
  it('6. resolves file, symbol and task queries: an exact path', () => {
    expect(service.getContextPack('src/config.ts').target.resolution).toBe('exact_file');
  });

  it('6. resolves file, symbol and task queries: a path suffix', () => {
    expect(service.getContextPack('config.ts').target.resolution).toBe('path_suffix');
  });

  it('6. resolves file, symbol and task queries: a symbol', () => {
    const bySymbol = service.getContextPack('authConfig', { targetType: 'symbol' });
    expect(bySymbol.target.resolution).toBe('exact_symbol');
    expect(bySymbol.target.files).toContain('src/config.ts');
  });

  it('6. resolves file, symbol and task queries: a task', () => {
    const byTask = service.getContextPack('OAuth callback frontendUrl handling', { targetType: 'task' });
    expect(byTask.target.files.length).toBeGreaterThan(0);
  });

  it('7. expands the neighborhood by depth and stays bounded', () => {
    const d0 = service.getContextPack('src/config.ts', { depth: 0 });
    const d1 = service.getContextPack('src/config.ts', { depth: 1 });
    expect(d0.codeNeighborhood.length).toBe(1);
    expect(d1.codeNeighborhood.length).toBeGreaterThan(d0.codeNeighborhood.length);
    expect(d1.codeNeighborhood.map((n) => n.path)).toContain('src/server.ts');
  });

  // ---------------------------------------------------------------- 8-11 history, records, provenance

  it('8. attaches history tied to the neighborhood, not the newest commits', () => {
    const pack = service.getContextPack('src/controller.ts', { depth: 0 });
    for (const h of pack.historicalContext) {
      expect(h.touchedFiles.some((f) => f === 'src/controller.ts')).toBe(true);
    }
  });

  it('9. integrates a Strata record that touches the neighborhood', () => {
    service.recordChange({
      title: 'Keep the IP-form origin',
      intent: 'The OAuth callback redirects to the IP form of the frontend URL',
      intentConfidence: 'DECLARED',
      files: [{ path: 'src/config.ts', changeType: 'modify' }],
      attempts: [{
        approach: 'Collapse the two origins into one canonical host',
        status: 'failed',
        failureReason: 'The callback redirect uses the IP form, so CORS broke after login',
        confidence: 'DECLARED',
      }],
      consequences: ['Removing the IP origin breaks OAuth immediately after login'],
      evidence: [],
      result: { status: 'success' },
    });

    const pack = service.getContextPack('src/config.ts', { depth: 1 });
    expect(pack.previousAttempts.length).toBeGreaterThan(0);
    expect(pack.previousAttempts[0]!.statement).toMatch(/Collapse the two origins/);
    expect(pack.consequences.some((c) => /breaks OAuth/.test(c.statement))).toBe(true);
  });

  it('10. preserves record provenance without upgrading it', () => {
    const pack = service.getContextPack('src/config.ts', { depth: 1 });
    // The record declared DECLARED; nothing in the pipeline may promote it to VERIFIED.
    expect(pack.previousAttempts.every((a) => a.provenance === 'DECLARED')).toBe(true);
    // Code relationships are the only things allowed to be VERIFIED here.
    expect(pack.relationships.some((r) => r.provenance === 'VERIFIED')).toBe(true);
  });

  it('11. renders UNKNOWN when a section has no evidence', () => {
    const pack = service.getContextPack('src/unrelated.ts', { depth: 1 });
    expect(pack.previousAttempts.length).toBe(0);
    const text = service.renderContextPack(pack);
    expect(text).toMatch(/## PREVIOUS ATTEMPTS\n- UNKNOWN/);
  });

  // ---------------------------------------------------------------- 12-14 ranking, dedupe, budget

  it('12. ranks the target above its neighbors', () => {
    const pack = service.getContextPack('src/config.ts', { depth: 1 });
    expect(pack.codeNeighborhood[0]!.path).toBe('src/config.ts');
    expect(pack.codeNeighborhood[0]!.distance).toBe(0);
  });

  it('13. deduplicates relationships and evidence', () => {
    const pack = service.getContextPack('src/config.ts', { depth: 2 });
    const keys = pack.relationships.map((r) => `${r.from}|${r.kind}|${r.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(pack.evidence).size).toBe(pack.evidence.length);
  });

  /*
    One generous pack, shared, and one build per test.

    This test built the same generous pack twice — once to compare against, once to check
    the budget was met — and a tight one, inside one five-second timeout, and took ~2.7 s
    under the full suite. It is the pattern historical_diff 11 had, fixed the same way: the
    generous pack is built once, and each contract is its own test. Nothing modifies a pack
    here: they are only rendered and inspected.
  */
  let generousPack: ContextPack | undefined;
  const generous = (): ContextPack =>
    (generousPack ??= service.getContextPack('src/config.ts', { depth: 2, maxTokens: 4000 }));

  it('14. honours the token budget: a budget the pack can reach is actually honoured', () => {
    // Raised from 700 when historical diff evidence began riding along: the pack
    // legitimately carries more now, and a fixed number here was asserting the old size
    // rather than the contract.
    const roomy = generous();
    expect(estimateTokens(service.renderContextPack(roomy))).toBeLessThanOrEqual(4000);
    expect(roomy.diagnostics.budgetExceeded).toBe(false);
  });

  it('14. honours the token budget and records what it trimmed', () => {
    const tight = service.getContextPack('src/config.ts', { depth: 2, maxTokens: 220 });

    expect(tight.diagnostics.truncated).toBe(true);
    expect(tight.diagnostics.sectionsTruncated.length).toBeGreaterThan(0);
    expect(service.renderContextPack(tight).length)
      .toBeLessThan(service.renderContextPack(generous()).length);
    // The target itself survives trimming, always.
    expect(tight.target.files).toContain('src/config.ts');

    // A budget the pack cannot reach is reported, never silently overshot.
    if (tight.diagnostics.estimatedTokens > 220) {
      expect(tight.diagnostics.budgetExceeded).toBe(true);
      expect(service.renderContextPack(tight)).toMatch(/could not be met/);
    } else {
      expect(tight.diagnostics.budgetExceeded).toBe(false);
    }
  });

  // ---------------------------------------------------------------- 15-16 output surfaces

  it('15. exposes structured JSON sections for machine consumption', () => {
    const pack = service.getContextPack('src/config.ts', { depth: 1 });
    const parsed = JSON.parse(JSON.stringify(pack));
    for (const key of ['target', 'codeNeighborhood', 'relationships', 'historicalContext',
                       'decisionsAndConstraints', 'previousAttempts', 'consequences',
                       'evidence', 'provenanceSummary', 'diagnostics']) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed.provenanceSummary).toHaveProperty('VERIFIED');
  });

  // One MCP request per test: each request builds its own pack. Same assertions as when
  // both forms were one test.
  it('16. answers strata_context over MCP', async () => {
    const handler = new StrataMCPHandler(repoDir);
    try {
      const res = await handler.handleToolCall('strata_context',
        { query: 'src/config.ts', depth: 1 });
      expect(res.content[0]!.text).toContain('STRATA CONTEXT');
      expect(res.content[0]!.text).toContain('src/config.ts');
    } finally {
      handler.close();
    }
  });

  it('16. answers strata_context over MCP as JSON', async () => {
    const handler = new StrataMCPHandler(repoDir);
    try {
      const asJson = await handler.handleToolCall('strata_context',
        { query: 'src/config.ts', format: 'json' });
      expect(() => JSON.parse(asJson.content[0]!.text)).not.toThrow();
    } finally {
      handler.close();
    }
  });

  // ---------------------------------------------------------------- 17-20 incrementality & relevance

  it('17. updates incrementally and removes deleted files', () => {
    const first = service.indexCode();
    expect(first.filesUnchanged).toBeGreaterThan(0);
    expect(first.filesIndexed).toBe(0);

    write('src/temp_feature.ts', 'export const tempFeature = 1;\n');
    const second = service.indexCode();
    expect(second.filesIndexed).toBe(1);
    expect(service.getContextPack('tempFeature', { targetType: 'symbol' }).target.files)
      .toContain('src/temp_feature.ts');

    fs.rmSync(path.join(repoDir, 'src/temp_feature.ts'));
    const third = service.indexCode();
    expect(third.filesRemoved).toBe(1);
    expect(service.getContextPack('tempFeature', { targetType: 'symbol' }).target.files)
      .not.toContain('src/temp_feature.ts');
  });

  it('18. keeps unrelated repository content out of the pack', () => {
    const pack = service.getContextPack('src/config.ts', { depth: 2 });
    const paths = pack.codeNeighborhood.map((n) => n.path);
    expect(paths).not.toContain('src/unrelated.ts');
  });

  it('18b. drops records that match lexically but touch no file in the neighborhood', () => {
    service.recordChange({
      title: 'Unrelated caching work in another subsystem',
      intent: 'Cache totals to avoid recomputation in the reporting path',
      intentConfidence: 'DECLARED',
      files: [{ path: 'src/unrelated.ts', changeType: 'modify' }],
      attempts: [],
      evidence: [],
      consequences: [],
      result: { status: 'success' },
    });
    const pack = service.getContextPack('src/config.ts', { depth: 1 });
    const text = JSON.stringify(pack);
    expect(text).not.toMatch(/Unrelated caching work/);
  });

  it('19. prefers an exact target over a lexical match', () => {
    const exact = service.getContextPack('src/config.ts');
    expect(exact.target.resolution).toBe('exact_file');
    expect(exact.target.files).toEqual(['src/config.ts']);
  });

  it('20. ranks a direct dependency above a distant one', () => {
    const pack = service.getContextPack('src/config.ts', { depth: 2 });
    const byPath = new Map(pack.codeNeighborhood.map((n) => [n.path, n]));
    const server = byPath.get('src/server.ts');
    expect(server).toBeDefined();
    expect(server!.distance).toBe(1);
    const order = pack.codeNeighborhood.map((n) => n.path);
    const distances = pack.codeNeighborhood.map((n) => n.distance);
    // Ranking never places a distance-2 entry above a distance-1 entry.
    for (let i = 1; i < distances.length; i++) {
      if (distances[i]! < distances[i - 1]!) {
        throw new Error(`distance regressed at ${order[i]}`);
      }
    }
  });

  // ---------------------------------------------------------------- end-to-end

  it('E2E: a single query yields target, relationships, history and provenance together', () => {
    const pack = service.getContextPack('OAuth callback frontendUrl', { depth: 1, maxTokens: 1800 });
    const text = service.renderContextPack(pack);

    expect(pack.target.files.length).toBeGreaterThan(0);
    expect(pack.relationships.length).toBeGreaterThan(0);
    expect(pack.historicalContext.length).toBeGreaterThan(0);
    expect(text).toContain('## CODE NEIGHBORHOOD');
    expect(text).toContain('## HISTORICAL CONTEXT');
    expect(text).toContain('## PROVENANCE');
    expect(estimateTokens(text)).toBeLessThanOrEqual(1800);

    const counted = Object.values(pack.provenanceSummary).reduce((a, b) => a + b, 0);
    expect(counted).toBeGreaterThan(0);
  });
});
