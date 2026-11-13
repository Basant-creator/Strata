import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { extractReferences, stripPunctuation } from '../src/code/references.js';
import { compareHistoryCandidates, HistoryCandidate } from '../src/context/history.js';
import { ContextPack } from '../src/context/pack.js';

/**
 * Target anchoring: history follows the code the developer named, not the words they used.
 *
 * The failure these tests pin down
 * -------------------------------
 * Delivery of historical evidence worked. *Selection* did not. The same question, asked
 * three ways, produced three different targets, and on one phrasing the commit that
 * created the file under discussion vanished from the pack entirely — outranked by newer
 * commits that had touched its neighbours and by commits whose messages happened to share
 * the query's vocabulary.
 *
 * The fixture reproduces that shape without reproducing the case. Nothing here shares a
 * name, a path or a commit id with the repository the failure was found in, because a fix
 * that only works on the case that exposed it is not a fix.
 *
 *     src/priceCacheService.ts   the target — defines normalizeCacheKey
 *     db/schema.sql              changed in the same commit; nothing imports it
 *     tests/testPriceCache.ts    added with the fix, deleted later, absent at HEAD
 *     src/priceApi.ts            one import edge from the target
 *     src/cacheHelpers.ts        a decoy: its name contains the query's words
 *     src/reportBuilder.ts       unconnected, and the subject of the newest commits
 *
 * The decisive commit is deliberately the *worst* candidate on every signal except the one
 * that matters: it is the oldest, its subject says nothing ("Fixing assorted issues"), and
 * three newer commits describe themselves in exactly the query's words.
 */
describe('target anchoring', () => {
  const repoDir = path.join(process.cwd(), '.test_repo_anchoring');
  let service: StrataService;
  const sha: Record<string, string> = {};
  const when: Record<string, string> = {};

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' });
  const write = (rel: string, body: string): void => {
    const abs = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf-8');
  };
  /** Commit at a fixed date, so "older" is a fact about the fixture and not about timing. */
  const commit = (label: string, date: string, message: string): void => {
    git('add', '-A');
    execFileSync('git', ['commit', '-q', '-m', message], {
      cwd: repoDir,
      encoding: 'utf-8',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    sha[label] = git('rev-parse', 'HEAD').trim();
    when[label] = date;
  };
  const shortOf = (label: string): string => sha[label]!.slice(0, 7);

  beforeAll(() => {
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(repoDir, { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'user.name', 'Fixture Author');

    write('db/schema.sql', [
      'CREATE TABLE quote (',
      '  rawId TEXT PRIMARY KEY,',
      '  price INTEGER',
      ');',
      '',
    ].join('\n'));
    write('src/priceApi.ts', [
      'export function fetchQuote(rawId: string): number { return rawId.length; }',
      '',
    ].join('\n'));
    /*
      Decoys. Their *names* carry the query's vocabulary and the query never names them.

      Three of them, because one is not a test. Word scoring keeps every file within half
      the top score, so a query about a cache reaches `cacheHelpers`, `lookupRouter` and
      `reliableQueue` alongside the real target — and each then contributes its own
      neighbourhood and its own recent commits to compete with the target's history. That
      compounding is what actually lost the decisive commit; a single decoy would let a
      broken resolver still look correct.
    */
    write('src/cacheHelpers.ts', [
      'export function formatCacheEntry(value: number): string { return String(value); }',
      '',
    ].join('\n'));
    write('src/lookupRouter.ts', [
      "import { formatCacheEntry } from './cacheHelpers.js';",
      'export function routeLookup(id: string): string { return formatCacheEntry(id.length); }',
      '',
    ].join('\n'));
    write('src/reliableQueue.ts', [
      "import { routeLookup } from './lookupRouter.js';",
      'export function enqueueReliably(id: string): string { return routeLookup(id); }',
      '',
    ].join('\n'));
    write('src/reportBuilder.ts', [
      'export function buildReport(rows: number[]): number { return rows.length; }',
      '',
    ].join('\n'));
    commit('c1', '2024-01-05T10:00:00+00:00', 'Initial plumbing');

    /*
      The decisive commit. Everything about it is unhelpful except what it did.

      Its subject explains nothing, it is the oldest change to the target, and it is about
      to be followed by three commits that describe themselves in the query's own words.
      If ranking can be talked out of surfacing this commit, it will be.
    */
    write('db/schema.sql', [
      'CREATE TABLE quote (',
      '  cacheKey TEXT PRIMARY KEY, -- normalized: vendor + product, lowercased',
      '  rawId    TEXT,',
      '  price    INTEGER',
      ');',
      '',
    ].join('\n'));
    write('src/priceCacheService.ts', [
      "import { fetchQuote } from './priceApi.js';",
      'export function normalizeCacheKey(vendor: string, product: string): string {',
      '  return `${vendor.toLowerCase()}:::${product.toLowerCase()}`;',
      '}',
      'export const priceCache = new Map<string, number>();',
      'export function warm(v: string, p: string): void {',
      '  priceCache.set(normalizeCacheKey(v, p), fetchQuote(v));',
      '}',
      '',
    ].join('\n'));
    /*
      Two tiny changes in a corner of the tree the query has nothing to do with.

      Both are smaller than the schema change. Choosing related files by size alone puts
      them both in and pushes the schema out — which is how a copy edit in a marketing
      component ended up sitting next to a cache question, using the budget the key flip
      needed.
    */
    write('web/landing.tsx', 'export const heading = "Quotes, fast";\n');
    write('web/footer.tsx', 'export const footer = "(c) 2024";\n');
    write('tests/testPriceCache.ts', [
      "import { normalizeCacheKey } from '../src/priceCacheService.js';",
      '// Two vendor spellings of one product must collapse to a single row.',
      'const a = normalizeCacheKey("Vendor", "Product");',
      'const b = normalizeCacheKey("vendor", "product");',
      'console.log(a === b ? "SUCCESS: one row per product, not per rawId" : "FAIL");',
      '',
    ].join('\n'));
    commit('decisive', '2024-02-01T10:00:00+00:00', 'Fixing assorted issues');

    // Three newer commits that say what the query says, and change nothing it asks about.
    write('src/reportBuilder.ts', 'export function buildReport(rows: number[]): number { return rows.length + 1; }\n');
    commit('loud1', '2024-06-01T10:00:00+00:00', 'Make cache lookups reliable in the report exporter');
    write('src/reportBuilder.ts', 'export function buildReport(rows: number[]): number { return rows.length + 2; }\n');
    commit('loud2', '2024-06-02T10:00:00+00:00', 'Reliable cache lookups around normalizeCacheKey callers');
    write('src/reportBuilder.ts', 'export function buildReport(rows: number[]): number { return rows.length + 3; }\n');
    commit('loud3', '2024-06-03T10:00:00+00:00', 'More reliable cache lookups everywhere');

    /*
      And newer commits sweeping across the decoys, several files at a time.

      This is the shape that beat the old ranking outright. Overlap was counted against
      the whole neighbourhood from a list already capped at four paths, so a broad recent
      commit saturated the count, tied with every other broad commit, and won the tie on
      date — while the commit that created the target touched one file and lost.
    */
    write('src/cacheHelpers.ts', 'export function formatCacheEntry(value: number): string { return `v${value}`; }\n');
    write('src/lookupRouter.ts', "import { formatCacheEntry } from './cacheHelpers.js';\nexport function routeLookup(id: string): string { return formatCacheEntry(id.length + 1); }\n");
    write('src/reliableQueue.ts', "import { routeLookup } from './lookupRouter.js';\nexport function enqueueReliably(id: string): string { return routeLookup(id.trim()); }\n");
    commit('sweep1', '2024-06-10T10:00:00+00:00', 'Sweep the lookup helpers');
    write('src/cacheHelpers.ts', 'export function formatCacheEntry(value: number): string { return `v${value}!`; }\n');
    write('src/lookupRouter.ts', "import { formatCacheEntry } from './cacheHelpers.js';\nexport function routeLookup(id: string): string { return formatCacheEntry(id.length + 2); }\n");
    write('src/reliableQueue.ts', "import { routeLookup } from './lookupRouter.js';\nexport function enqueueReliably(id: string): string { return routeLookup(id.trimEnd()); }\n");
    write('src/reportBuilder.ts', 'export function buildReport(rows: number[]): number { return rows.length + 4; }\n');
    commit('sweep2', '2024-06-20T10:00:00+00:00', 'Second pass over the reliable cache lookups');

    // A recent neighbour change: directly related, but it is not the target.
    write('src/priceApi.ts', [
      'export function fetchQuote(rawId: string): number { return rawId.length * 2; }',
      '',
    ].join('\n'));
    commit('neighbour', '2024-07-01T10:00:00+00:00', 'Double the quote scale in the price API');

    // The evidence is deleted. At HEAD nothing in the working tree records it.
    fs.rmSync(path.join(repoDir, 'tests/testPriceCache.ts'));
    commit('cleanup', '2024-08-01T10:00:00+00:00', 'Drop the scratch harness');

    service = new StrataService(repoDir);
    service.init();
    service.indexCode();
  });

  afterAll(() => {
    service.close();
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  /*
    One build per question, shared by every test that asks it.

    A pack build spends most of its time starting git processes, and the full suite runs
    every file's builds in parallel: tests here that built two or three packs took ~3.1-3.4 s
    of their five seconds under the suite. Several tests ask the same question, packs are
    only read and rendered, and nothing in this file changes the store or the index after
    setup, so each question is built once.
  */
  const built = new Map<string, ContextPack>();
  const buildOnce = (query: string, options: { depth: number; maxTokens: number }): ContextPack => {
    const key = `${query}|${options.depth}|${options.maxTokens}`;
    let pack = built.get(key);
    if (!pack) {
      pack = service.getContextPack(query, options);
      built.set(key, pack);
    }
    return pack;
  };
  const packFor = (query: string, maxTokens = 4000): ContextPack => buildOnce(query, { depth: 1, maxTokens });
  const hashesIn = (pack: ContextPack): string[] => pack.historicalContext.map((h) => h.shortHash);
  const relationOf = (pack: ContextPack, label: string): string | undefined =>
    pack.historicalContext.find((h) => h.hash === sha[label])?.relation;

  // ------------------------------------------------------------------ 1

  it('1. an old direct commit beats a recent unrelated lexical match', () => {
    const pack = packFor('make cache lookups reliable in src/priceCacheService.ts');
    const order = hashesIn(pack);

    expect(order[0], 'the commit that changed the target ranks first').toBe(shortOf('decisive'));
    expect(pack.historicalContext[0]!.relation).toBe('DIRECT_TARGET');

    // It wins from behind on every signal except relationship to the target.
    expect(new Date(when.decisive!).getTime())
      .toBeLessThan(new Date(when.loud3!).getTime());
    for (const loud of ['loud1', 'loud2', 'loud3']) {
      const at = order.indexOf(shortOf(loud));
      if (at === -1) continue; // trimmed out entirely is also a pass
      expect(at, `${loud} must not outrank the direct change`).toBeGreaterThan(0);
      expect(relationOf(pack, loud)).toBe('LEXICAL_ONLY');
    }
  });

  // ------------------------------------------------------------------ 2

  it('2. an explicit file path beats generic keyword matches', () => {
    const pack = packFor('make cache lookups reliable in src/priceCacheService.ts');
    expect(pack.target.resolution).toBe('embedded_path');
    expect(pack.target.files).toEqual(['src/priceCacheService.ts']);
    // "cache" reaches cacheHelpers.ts lexically. A named path is not a vote to be counted
    // alongside it; it settles the question.
    expect(pack.target.files).not.toContain('src/cacheHelpers.ts');
    expect(pack.target.anchors![0]!.kind).toBe('explicit_path');
  });

  // ------------------------------------------------------------------ 3

  it('3. a symbol name beats unrelated file names containing the same words', () => {
    const pack = packFor('normalizeCacheKey');
    expect(pack.target.resolution).toBe('exact_symbol');
    expect(pack.target.files).toEqual(['src/priceCacheService.ts']);
    expect(pack.target.files).not.toContain('src/cacheHelpers.ts');
  });

  // Its own test, so each test builds one pack.
  it('3b. case is part of the name: a different casing is a different symbol', () => {
    const wrongCase = packFor('normalizecachekey');
    expect(wrongCase.target.resolution).not.toBe('exact_symbol');
  });

  // ------------------------------------------------------------------ 4

  it('4. a directly changed file stays in history despite a useless commit message', () => {
    // "Fixing assorted issues" shares no word with this query. Under the previous model
    // that cost it rank; under anchoring the message is not consulted at all.
    const pack = packFor('why is the key normalized in src/priceCacheService.ts');
    expect(hashesIn(pack)).toContain(shortOf('decisive'));
    expect(pack.historicalContext[0]!.shortHash).toBe(shortOf('decisive'));

    const subject = pack.historicalContext[0]!.subject;
    expect(subject).toBe('Fixing assorted issues');
    for (const term of ['key', 'normalized', 'cache']) {
      expect(subject.toLowerCase()).not.toContain(term);
    }
  });

  // ------------------------------------------------------------------ 5

  it('5. unrelated recent commits cannot bury direct target history', () => {
    const pack = packFor('make cache lookups reliable in src/priceCacheService.ts');
    const direct = pack.historicalContext.filter((h) => h.relation === 'DIRECT_TARGET');
    const rest = pack.historicalContext.filter((h) => h.relation !== 'DIRECT_TARGET');
    expect(direct.length).toBeGreaterThan(0);

    // The classes do not interleave: no amount of recency moves a commit across.
    for (const d of direct) {
      for (const r of rest) {
        expect(pack.historicalContext.indexOf(d))
          .toBeLessThan(pack.historicalContext.indexOf(r));
      }
    }
    // The newest commit in the repository touches neither the target nor its imports.
    expect(relationOf(pack, 'cleanup') ?? 'absent').not.toBe('DIRECT_TARGET');
    // A neighbour change is related, and still ranks under the target's own history.
    const neighbour = relationOf(pack, 'neighbour');
    if (neighbour) expect(neighbour).toBe('DIRECTLY_RELATED');
  });

  // ------------------------------------------------------------------ 6

  it('6. an invalid explicit path returns TARGET_NOT_FOUND rather than a fuzzy fallback', () => {
    const pack = packFor('src/priceCacheServiceOld.ts');
    expect(pack.target.resolution).toBe('target_not_found');
    expect(pack.targetNotFound).toBe(true);
    expect(pack.target.files).toEqual([]);
    expect(pack.target.unresolved).toEqual(['src/priceCacheServiceOld.ts']);
    expect(pack.historicalContext).toEqual([]);

    const text = service.renderContextPack(pack);
    expect(text).toContain('TARGET_NOT_FOUND');
    // Critically: it does not answer about the file with the most similar name.
    expect(text).not.toContain('src/priceCacheService.ts');
  });

  it('6b. a path named inside a sentence is still reported when it does not exist', () => {
    const pack = packFor('make cache lookups reliable in src/nowhere/missingService.ts');
    expect(pack.target.resolution).toBe('target_not_found');
    expect(pack.target.unresolved).toContain('src/nowhere/missingService.ts');
  });

  it('6c. a slash that is not a path claim is not reported as a missing file', () => {
    // "and/or" has a slash and no extension. Reporting it as a missing file would make
    // TARGET_NOT_FOUND fire on ordinary English and train the reader to ignore it.
    const pack = packFor('does the cache handle vendor and/or product changes');
    expect(pack.target.resolution).not.toBe('target_not_found');
    expect(pack.target.unresolved ?? []).not.toContain('and/or');
  });

  // ------------------------------------------------------------------ 7

  /*
    One test per phrasing, not one test for all four.

    Each phrasing is a separate request, and the reader's git cache is cleared per request
    by design — HEAD can move between requests. So four phrasings of one target were four
    full sets of the same git questions, about eighty-five serial git processes inside a
    single five-second timeout. Measured: ~2.0 s alone, ~3.2 s with the rest of the suite
    spawning git in parallel, and over the limit on a busier machine, because process
    start-up on Windows costs ~26 ms idle and ~40 ms under that load.

    Every assertion is unchanged. Each phrasing is still checked against the same target
    and the same direct commit, which is what "resolve to the same entity" means; it is
    simply timed on its own.
  */
  const phrasings = [
    'src/priceCacheService.ts',
    'make cache lookups reliable in priceCacheService, normalizeCacheKey versus rawId',
    'Make cache lookups reliable in src/priceCacheService.ts, normalizeCacheKey versus rawId',
    'why does priceCacheService normalize the key instead of using rawId',
  ];

  it.each(phrasings.map((q, i) => [i + 1, q] as const))(
    '7. wording variation %i resolves to the same target entity', (i, q) => {
      const pack = packFor(q);
      expect(pack.target.files[0], `phrasing ${i} resolved elsewhere`)
        .toBe('src/priceCacheService.ts');
      expect(hashesIn(pack)[0], `phrasing ${i} lost the direct commit`)
        .toBe(shortOf('decisive'));
    });

  // ------------------------------------------------------------------ 8

  it('8. deleted historical evidence is reachable through the commit that changed the target', () => {
    expect(fs.existsSync(path.join(repoDir, 'tests/testPriceCache.ts'))).toBe(false);

    const pack = packFor('Make cache lookups reliable in src/priceCacheService.ts, normalizeCacheKey versus rawId');
    const text = service.renderContextPack(pack);
    expect(text).toContain('tests/testPriceCache.ts');
    expect(text).toContain('one row per product, not per rawId');

    const recovered = pack.historicalContext.flatMap((h) => h.historicalFiles ?? []);
    expect(recovered.every((f) => f.provenance === 'VERIFIED')).toBe(true);
    // Reading history never writes to the tree.
    expect(fs.existsSync(path.join(repoDir, 'tests/testPriceCache.ts'))).toBe(false);
  });

  it('8c. a small change in an unrelated tree does not displace the schema', () => {
    const pack = packFor('Make cache lookups reliable in src/priceCacheService.ts');
    const decisive = pack.historicalContext.find((h) => h.hash === sha.decisive)!;
    const diffed = (decisive.changes ?? []).map((c) => c.path);

    // Both web files are smaller than the schema change; neither can crowd it out.
    expect(diffed).toContain('db/schema.sql');
    expect(diffed.filter((p) => p.startsWith('web/')).length).toBeLessThan(2);
    // And whatever is left out is still named, not hidden.
    const named = [...diffed, ...(decisive.alsoChanged ?? [])];
    expect(named).toContain('web/landing.tsx');
  });

  it('8b. the schema change in the same commit travels with it', () => {
    // Nothing imports a .sql file, so no code edge can reach it. It arrives because the
    // commit that changed the target changed it too.
    const pack = packFor('Make cache lookups reliable in src/priceCacheService.ts, normalizeCacheKey versus rawId');
    const text = service.renderContextPack(pack);
    expect(text).toContain('db/schema.sql');
    expect(text).toContain('cacheKey TEXT PRIMARY KEY');
    expect(text).toContain('-  rawId TEXT PRIMARY KEY');
  });

  // ------------------------------------------------------------------ 9

  it('9. nothing in the engine is keyed to a particular commit or repository', () => {
    const srcDir = path.join(process.cwd(), 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.name.endsWith('.ts')) files.push(abs);
      }
    };
    walk(srcDir);
    expect(files.length).toBeGreaterThan(5);

    for (const file of files) {
      const code = stripComments(fs.readFileSync(file, 'utf-8'));
      const rel = path.relative(process.cwd(), file);
      // No commit id can be baked into behaviour, however tempting a shortcut it is.
      for (const literal of code.match(/['"`][^'"`\n]*['"`]/g) ?? []) {
        expect(/^['"`][0-9a-f]{7,40}['"`]$/.test(literal), `${rel} contains a SHA literal ${literal}`)
          .toBe(false);
      }
      // Nor can the repository the failure was found in.
      for (const token of ['trackCache', 'YoutubeTrack', 'normalizeTrackKey', 'tuneit']) {
        expect(code.toLowerCase().includes(token.toLowerCase()),
          `${rel} refers to fixture-specific ${token} in code`).toBe(false);
      }
    }
  });

  it('9b. the same mechanism works for a second, differently named target', () => {
    // The rules are about "the file the query named", not about this file. Point them at
    // an unrelated target in the same repository and the shape of the answer is the same.
    const pack = packFor('src/reportBuilder.ts');
    expect(pack.target.files).toEqual(['src/reportBuilder.ts']);
    expect(pack.historicalContext[0]!.relation).toBe('DIRECT_TARGET');
    expect(pack.historicalContext[0]!.anchorFiles).toContain('src/reportBuilder.ts');
    // And its own origin is identified the same mechanical way.
    expect(pack.historicalContext.some((h) => h.introducedAnchor)).toBe(true);
  });

  // ------------------------------------------------------------------ budget

  it('10. generic neighbourhood material does not consume the budget before the diffs', () => {
    const tight = buildOnce('Make cache lookups reliable in src/priceCacheService.ts', { depth: 2, maxTokens: 900 });

    /*
      The evidence survives, in whichever form fits.

      Not "a raw diff survives". A decision carries the same before/after in a quarter of
      the tokens and adds whether the change still holds, so under real pressure it is the
      diff that should go and the decision that should stay. Measured on the real
      repository: at 900 tokens the raw diff is gone and the quoted key change is still
      there. The contract is that the historical content reaches the agent, not that a
      particular rendering of it does.
    */
    const direct = tight.historicalContext.filter((h) => h.relation === 'DIRECT_TARGET');
    const viaDiff = direct.some((h) => h.changes?.length);
    const viaDecision = tight.historicalDecisions.some(
      (d) => d.historicalState.length > 0 || d.currentState.length > 0);
    expect(viaDiff || viaDecision,
      'the historical change reaches the agent as a diff or as a decision').toBe(true);

    const order = tight.diagnostics.sectionsTruncated;
    for (const cheap of ['history(lexical-only)', 'neighborhood(distance>=2)', 'history(indirect)']) {
      if (!order.includes(cheap) || !order.includes('diff-hunks')) continue;
      expect(order.indexOf(cheap)).toBeLessThan(order.indexOf('diff-hunks'));
    }
  });

  // One test per budget, so each builds at most one pack; the assertions are the loop's.
  it.each([900, 1500, 4000])('11. the reported token count describes the text the caller receives (%i tokens)', (budget) => {
    const pack = buildOnce('Make cache lookups reliable in src/priceCacheService.ts', { depth: 2, maxTokens: budget });
    const actual = Math.ceil(service.renderContextPack(pack).length / 4);
    expect(pack.diagnostics.estimatedTokens).toBe(actual);
    if (!pack.diagnostics.budgetExceeded) expect(actual).toBeLessThanOrEqual(budget);
  });

  // ------------------------------------------------------------------ chain

  it('12. a development chain is preserved, not collapsed to its newest link', () => {
    const pack = packFor('src/priceCacheService.ts');
    const direct = pack.historicalContext.filter((h) => h.relation === 'DIRECT_TARGET');
    expect(direct.some((h) => h.introducedAnchor), 'the commit that created it is kept').toBe(true);
    expect(direct.map((h) => h.shortHash)).toContain(shortOf('decisive'));
  });
});

/**
 * Reference extraction, tested on its own.
 *
 * These are the decisions that make a sentence resolvable, and they are pure syntax, so
 * they can be checked without a repository. Every case below is one that was observed to
 * matter — either in the failure this work fixes, or in a false positive it could cause.
 */
describe('explicit reference extraction', () => {
  it('finds a path written inside a sentence', () => {
    const refs = extractReferences('Make cache lookups reliable in src/a/b/thing.ts, now');
    expect(refs.find((r) => r.kind === 'path')?.text).toBe('src/a/b/thing.ts');
  });

  it('strips trailing punctuation without eating the extension', () => {
    expect(stripPunctuation('thing.ts,')).toBe('thing.ts');
    expect(stripPunctuation('(thing.ts).')).toBe('thing.ts');
    expect(stripPunctuation('"src/a.ts";')).toBe('src/a.ts');
  });

  it('does not mistake a URL for a repository path', () => {
    const refs = extractReferences('redirects to http://127.0.0.1:5173/callback after login');
    expect(refs.some((r) => r.kind === 'path')).toBe(false);
  });

  it('does not assert a file for prose that merely contains a dot or a slash', () => {
    for (const query of ['handle vendor and/or product', 'e.g. the cache key', 'version 1.2.3']) {
      expect(extractReferences(query).filter((r) => r.assertsFile)).toEqual([]);
    }
  });

  it('keeps identifiers and drops the English around them', () => {
    const refs = extractReferences('make normalizeCacheKey reliable for the rawId case');
    const identifiers = refs.filter((r) => r.kind === 'identifier').map((r) => r.text);
    expect(identifiers).toContain('normalizeCacheKey');
    expect(identifiers).toContain('rawId');
    expect(identifiers).not.toContain('the');
    expect(identifiers).not.toContain('make');
  });

  it('reports the first mention only, in the order written', () => {
    const refs = extractReferences('src/a.ts calls src/b.ts and then src/a.ts again');
    expect(refs.filter((r) => r.kind === 'path').map((r) => r.text))
      .toEqual(['src/a.ts', 'src/b.ts']);
  });
});

/**
 * The ordering contract, checked directly.
 *
 * The comparator is lexicographic rather than a weighted sum for one reason: in a sum a
 * large enough value in any single term buries every other term, and that is precisely how
 * an old, quiet, decisive commit lost to a recent, noisy, irrelevant one. These cases say
 * that no later signal can ever overturn an earlier one, which is what "cannot be buried"
 * means operationally.
 */
describe('history ranking contract', () => {
  const candidate = (over: Partial<HistoryCandidate>): HistoryCandidate => ({
    hash: 'aaaa', authoredAt: 0, anchorFiles: [], relatedFiles: [], indirectFiles: [],
    relation: 'LEXICAL_ONLY', explicitHits: 0, symbolHits: 0, wordHits: 0, revertChain: 0, lineHits: 0, structuralRole: 0, ...over,
  });

  it('a direct change outranks a newer commit of every other class', () => {
    const direct = candidate({
      hash: 'old', relation: 'DIRECT_TARGET', anchorFiles: ['a.ts'], explicitHits: 1, authoredAt: 1,
    });
    for (const relation of ['DIRECTLY_RELATED', 'INDIRECTLY_RELATED', 'LEXICAL_ONLY'] as const) {
      const newer = candidate({
        hash: 'new', relation, relatedFiles: ['b.ts'], authoredAt: 9_999_999_999,
      });
      expect([newer, direct].sort(compareHistoryCandidates)[0]!.hash).toBe('old');
    }
  });

  it('recency decides only between otherwise identical commits', () => {
    const base = { relation: 'DIRECT_TARGET' as const, anchorFiles: ['a.ts'], explicitHits: 1 };
    const older = candidate({ ...base, hash: 'old', authoredAt: 1 });
    const newer = candidate({ ...base, hash: 'new', authoredAt: 2 });
    expect([older, newer].sort(compareHistoryCandidates)[0]!.hash).toBe('new');

    // Give the older one any stronger signal and recency stops mattering.
    const stronger = candidate({ ...base, hash: 'old', authoredAt: 1, structuralRole: 2 });
    expect([newer, stronger].sort(compareHistoryCandidates)[0]!.hash).toBe('old');
  });

  it('a named target outranks a lexically guessed one within the same class', () => {
    const named = candidate({
      hash: 'named', relation: 'DIRECT_TARGET', anchorFiles: ['a.ts'], explicitHits: 1, authoredAt: 1,
    });
    const guessed = candidate({
      hash: 'guess', relation: 'DIRECT_TARGET', anchorFiles: ['b.ts'], explicitHits: 0,
      authoredAt: 9_999_999_999,
    });
    expect([guessed, named].sort(compareHistoryCandidates)[0]!.hash).toBe('named');
  });

  it('is a total order: sorting is stable and independent of input order', () => {
    const items = [
      candidate({ hash: 'a', relation: 'DIRECT_TARGET', anchorFiles: ['x'], authoredAt: 3 }),
      candidate({ hash: 'b', relation: 'DIRECTLY_RELATED', relatedFiles: ['y'], authoredAt: 9 }),
      candidate({ hash: 'c', relation: 'DIRECT_TARGET', anchorFiles: ['x'], authoredAt: 7 }),
      candidate({ hash: 'd', relation: 'LEXICAL_ONLY', authoredAt: 99 }),
    ];
    const forward = [...items].sort(compareHistoryCandidates).map((c) => c.hash);
    const backward = [...items].reverse().sort(compareHistoryCandidates).map((c) => c.hash);
    expect(forward).toEqual(backward);
    expect(forward).toEqual(['c', 'a', 'b', 'd']);
  });
});

/** Remove comments so source assertions look at behaviour, not at prose about behaviour. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//');
      if (at === -1) return line;
      const before = line.slice(0, at);
      // Only strip when the `//` is not inside a string or a regex literal.
      const quotes = (before.match(/['"`]/g) ?? []).length;
      return quotes % 2 === 0 ? before : line;
    })
    .join('\n');
}
