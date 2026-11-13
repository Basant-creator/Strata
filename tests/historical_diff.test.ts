import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { StrataMCPHandler } from '../src/mcp/server.js';
import { CommitChangeReader } from '../src/history/changes.js';
import { estimateTokens, ContextPack } from '../src/context/pack.js';

/**
 * Historical diff evidence.
 *
 * The feature exists because a measured experiment showed that naming a commit is worth
 * almost nothing: an agent handed `44ce16f — Fixing Major Issues and Benchmarks` still ran
 * `git show` to find that the commit had flipped a database primary key, and saved nothing
 * against a baseline doing its own archaeology.
 *
 * The fixture reproduces that shape in miniature — a key flip in a schema, a service that
 * grew around it, a test added alongside and later deleted, a rename, and an unrelated
 * file changed in the same commit that must stay out of the way.
 */
describe('historical diff evidence', () => {
  const repoDir = path.join(process.cwd(), '.test_repo_histdiff');
  let service: StrataService;
  let reader: CommitChangeReader;
  const sha: Record<string, string> = {};

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' });
  /** Working-tree state, ignoring the store `init` creates. */
  const dirtyFiles = (): string[] =>
    git('status', '--porcelain').split('\n').map((l) => l.trim())
      .filter(Boolean).filter((l) => !l.includes('.strata'));
  const write = (rel: string, body: string): void => {
    const abs = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf-8');
  };
  const commit = (label: string, msg: string): void => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    sha[label] = git('rev-parse', 'HEAD').trim();
  };

  beforeAll(() => {
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(repoDir, { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'user.name', 'Fixture Author');

    // 1. The original design: cache keyed on the exact upload id.
    write('schema.prisma', [
      'model CachedTrack {',
      '  videoId  String @id',
      '  title    String',
      '}',
      '',
    ].join('\n'));
    write('src/cache.ts', [
      "import { analyze } from './analyze.js';",
      'export function lookupKey(videoId: string): string { return videoId; }',
      'export const cache = new Map<string, number>();',
      'export function warm(id: string): void { cache.set(lookupKey(id), analyze(id)); }',
      '',
    ].join('\n'));
    write('src/analyze.ts', 'export function analyze(id: string): number { return id.length; }\n');
    write('src/unrelated.ts', 'export const unrelated = 1;\n');
    commit('first', 'Add cache keyed on videoId');

    // 2. The fix: key flipped, a test added to prove it, an unrelated file touched too.
    write('schema.prisma', [
      'model CachedTrack {',
      '  trackKey String @id',
      '  videoId  String?',
      '  title    String',
      '}',
      '',
    ].join('\n'));
    write('src/cache.ts', [
      "import { analyze } from './analyze.js';",
      'export function lookupKey(artist: string, title: string): string {',
      '  return `${artist.toLowerCase()}:::${title.toLowerCase()}`;',
      '}',
      'export const cache = new Map<string, number>();',
      'export function warm(a: string, t: string): void { cache.set(lookupKey(a, t), analyze(t)); }',
      '',
    ].join('\n'));
    write('tests/testCache.ts', [
      "import { lookupKey } from '../src/cache.js';",
      '// Same song, two different uploads, one cache entry.',
      'const a = lookupKey("Artist", "Song");',
      'const b = lookupKey("artist", "song");',
      'console.log(a === b ? "SUCCESS: cache hit across different videoIds" : "FAIL");',
      '',
    ].join('\n'));
    write('src/unrelated.ts', 'export const unrelated = 2;\n');
    commit('fix', 'Fix cache key so uploads of one song share a row');

    // 3. The test is deleted and a module renamed.
    fs.rmSync(path.join(repoDir, 'tests/testCache.ts'));
    git('mv', 'src/analyze.ts', 'src/analyzer.ts');
    write('src/cache.ts', [
      "import { analyze } from './analyzer.js';",
      'export function lookupKey(artist: string, title: string): string {',
      '  return `${artist.toLowerCase()}:::${title.toLowerCase()}`;',
      '}',
      'export const cache = new Map<string, number>();',
      'export function warm(a: string, t: string): void { cache.set(lookupKey(a, t), analyze(t)); }',
      '',
    ].join('\n'));
    commit('cleanup', 'Drop the scratch test and rename analyze');

    service = new StrataService(repoDir);
    service.init();
    service.indexCode();
    reader = new CommitChangeReader(repoDir);
  });

  afterAll(() => {
    service.close();
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ 1-2

  it('1. a relevant commit carries the relevant diff', () => {
    const d = reader.changesFor(sha.fix!, ['src/cache.ts']);
    const cache = d.files.find((f) => f.path === 'src/cache.ts')!;
    expect(cache.status).toBe('modify');
    const text = cache.hunks.join('\n');
    expect(text).toContain('-export function lookupKey(videoId: string): string');
    expect(text).toContain('artist.toLowerCase()');
  });

  it('2. an irrelevant file changed in the same commit is not diffed as if it were the target', () => {
    const d = reader.changesFor(sha.fix!, ['src/cache.ts']);
    const targets = d.files.filter((f) => f.path === 'src/unrelated.ts');
    // It may be picked up as a small related file, but it is never the requested target,
    // and it must never displace the file that was asked about.
    expect(d.files[0]!.path).toBe('src/cache.ts');
    expect(targets.length).toBeLessThanOrEqual(1);
  });

  it('2b. the schema key flip is surfaced even though nothing imports a schema', () => {
    const d = reader.changesFor(sha.fix!, ['src/cache.ts']);
    const schema = d.files.find((f) => f.path === 'schema.prisma');
    expect(schema, 'schema should be picked up as a small related change').toBeTruthy();
    const text = schema!.hunks.join('\n');
    expect(text).toContain('-  videoId  String @id');
    expect(text).toContain('+  trackKey String @id');
  });

  // ------------------------------------------------------------------ 3-7

  it('3. a deleted historical file can be surfaced from the object store', () => {
    const content = reader.fileAtCommit(sha.cleanup!, 'tests/testCache.ts');
    expect(content).toBeTruthy();
    expect(content!.status).toBe('deleted');
    expect(content!.lines.join('\n')).toContain('cache hit across different videoIds');
  });

  it('4. surfacing a deleted file never restores it to the working tree', () => {
    reader.fileAtCommit(sha.cleanup!, 'tests/testCache.ts');
    expect(fs.existsSync(path.join(repoDir, 'tests/testCache.ts'))).toBe(false);
    expect(dirtyFiles()).toEqual([]);
  });

  it('5. a rename is reported as a rename, with the previous path', () => {
    const d = reader.changesFor(sha.cleanup!, ['src/analyzer.ts']);
    const renamed = d.files.find((f) => f.path === 'src/analyzer.ts')!;
    expect(renamed.status).toBe('rename');
    expect(renamed.previousPath).toBe('src/analyze.ts');
  });

  it('6. an added file is reported as added', () => {
    const d = reader.changesFor(sha.first!, ['src/cache.ts']);
    expect(d.files.find((f) => f.path === 'src/cache.ts')!.status).toBe('add');
  });

  it('7. a historical test added alongside the change is found', () => {
    expect(reader.relatedTestFiles(sha.fix!, ['src/cache.ts'])).toContain('tests/testCache.ts');
  });

  it('7b. the deleted-test search reads only the newest commits of the window', () => {
    // A whole-history walk per target cost ~2 s each on a VS Code clone, so the search
    // reads the commit cache's window. Here the deletion is the third-newest commit.
    const dir = path.join(process.cwd(), '.test_repo_deleted_window');
    const run = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'));
    try {
      run('init', '-q');
      run('config', 'user.email', 'fixture@example.com');
      run('config', 'user.name', 'Fixture Author');
      fs.writeFileSync(path.join(dir, 'src/widget.ts'), 'export const size = 1;\n');
      fs.writeFileSync(path.join(dir, 'tests/widget.test.ts'), 'expect(size).toBe(1);\n');
      run('add', '-A'); run('commit', '-q', '-m', 'Add widget');
      run('rm', '-q', 'tests/widget.test.ts'); run('commit', '-q', '-m', 'Drop widget test');
      for (const n of [2, 3]) {
        fs.writeFileSync(path.join(dir, 'src/widget.ts'), `export const size = ${n};\n`);
        run('commit', '-q', '-am', `Widget size ${n}`);
      }

      const found = (window: number): string[] =>
        new CommitChangeReader(dir, { deletedTestWindow: window })
          .deletedRelatedTests('src/widget.ts').map((d) => d.path);
      expect(found(2)).toEqual([]);
      expect(found(3)).toEqual(['tests/widget.test.ts']);
      expect(new CommitChangeReader(dir).deletedRelatedTests('src/widget.ts')
        .map((d) => d.subject)).toEqual(['Drop widget test']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /*
    One generous pack, one build per test.

    This was a single test building three packs of the same query. Each build is its own
    request, and the reader clears its git cache per request by design — HEAD can move
    between requests — so the test was about 115 serial git processes inside one
    five-second timeout. Measured: ~2.5 s alone, ~4.3 s with the rest of the suite
    spawning git in parallel, and over the limit on a busier machine, because process
    start-up on Windows costs ~26 ms idle and ~40 ms under that load.

    Each budget is now its own test, so each timed unit builds one pack, and the generous
    pack every test from 8 on reads is built once rather than once per contract — tests 8,
    9, 10, 12 and 14 used to build it again each. Every assertion is unchanged. Nothing
    reads the pack mutably: it is only rendered and inspected.
  */
  let roomyPack: ContextPack | undefined;
  const roomy = (): ContextPack =>
    (roomyPack ??= service.getContextPack('src/cache.ts', { depth: 1, maxTokens: 4000 }));

  // ------------------------------------------------------------------ 8-10 provenance

  it('8. git content is VERIFIED', () => {
    const pack = roomy();
    const withDiff = pack.historicalContext.find((h) => h.changes?.length)!;
    expect(withDiff).toBeTruthy();
    for (const c of withDiff.changes!) expect(c.provenance).toBe('VERIFIED');
    for (const f of withDiff.historicalFiles ?? []) expect(f.provenance).toBe('VERIFIED');
  });

  it('9. the commit subject stays DECLARED even when a diff proves what changed', () => {
    const pack = roomy();
    const rendered = service.renderContextPack(pack);
    expect(rendered).toContain("subject is the author's own description, DECLARED");
    // A diff existing must not promote the author's wording to fact.
    expect(rendered).not.toMatch(/subject.*VERIFIED/);
  });

  it('10. an absent explanation stays UNKNOWN', () => {
    const pack = roomy();
    // No records exist in this fixture, so the record-fed sections must say so rather
    // than borrowing an explanation from the diff.
    expect(pack.previousAttempts).toEqual([]);
    expect(service.renderContextPack(pack)).toMatch(/## PREVIOUS ATTEMPTS\n- UNKNOWN/);
  });

  // ------------------------------------------------------------------ 11-14

  it('11. a generous token budget is met', () => {
    expect(estimateTokens(service.renderContextPack(roomy()))).toBeLessThanOrEqual(4000);
  });

  it('11a. a tight token budget is met or declared unmeetable, and shrinks the pack', () => {
    const tight = service.getContextPack('src/cache.ts', { depth: 1, maxTokens: 700 });
    // Either the budget is met, or it is declared unmeetable. Never silently exceeded.
    const tightSize = estimateTokens(service.renderContextPack(tight));
    expect(tightSize <= 700 || tight.diagnostics.budgetExceeded).toBe(true);
    expect(tightSize).toBeLessThan(estimateTokens(service.renderContextPack(roomy())));
  });

  it('11b. diffs are the last thing dropped', () => {
    /*
      Diff evidence is the last thing sacrificed.

      Not "undiffed commits are always dropped first" — a pack whose every commit carries
      a diff has none to drop, and that step simply never fires. The contract is the
      ordering: the cheap sections go before the evidence does.

      Asserted over the steps that actually fired, not over a fixed list. The previous
      version required `relationships` to appear, which this fixture has exactly one of —
      below the step's own floor, so it can never fire. That made the whole block
      unreachable, and it went unnoticed because the pack used to shed history early
      enough that `diff-hunks` was never reached either. Both halves were vacuous.
    */
    /*
      Forced, not hoped for.

      At 700 tokens whether hunk trimming is reached depends on how large the diffs come
      back, which made an earlier version of this assertion pass in isolation and fail
      under load. The precondition is stated outright — there must be a diff to trim —
      and then the budget is squeezed until trimming has no choice.
    */
    expect(roomy().historicalContext.some((h) => h.changes?.length),
      'fixture must carry at least one diff for this to mean anything').toBe(true);
    const squeezed = service.getContextPack('src/cache.ts', { depth: 1, maxTokens: 300 });
    const order = squeezed.diagnostics.sectionsTruncated;
    expect(order).toContain('diff-hunks');
    /*
      Everything cheaper than the evidence goes first, whichever of them the pack had.

      `undiffed-commits` is deliberately not in this list. It sits above `diff-hunks` in
      the trim order, but hunk trimming can strip a commit's last hunk and *create* an
      undiffed commit, which the next pass then removes — so seeing it recorded after
      `diff-hunks` is the order working, not a violation of it.
    */
    for (const cheap of ['evidence', 'change-chains', 'symbol-lists', 'why',
                         'historical-file-excerpts']) {
      if (!order.includes(cheap)) continue;
      expect(order.indexOf(cheap),
        `${cheap} must be trimmed before diff hunks`).toBeLessThan(order.indexOf('diff-hunks'));
    }
    /*
      And nothing cheap is trimmed after the diffs.

      What may follow are the last-resort steps and the distilled historical evidence —
      a decision's quoted before/after outranks the raw diff it was derived from, because
      it says the same thing in four lines instead of forty and adds whether the change
      still stands.
    */
    for (const later of order.slice(order.indexOf('diff-hunks') + 1)) {
      expect(later, `${later} must not be trimmed after diff hunks`)
        .toMatch(/\(minimal\)$|^decision-detail$|^current-behavior$|^uncertainty$|^undiffed-commits$/);
    }
  });

  it('12. JSON output exposes historical evidence structurally', () => {
    const pack = JSON.parse(JSON.stringify(roomy()));
    const withDiff = pack.historicalContext.find((h: { changes?: unknown[] }) => h.changes?.length);
    expect(withDiff).toBeTruthy();
    expect(withDiff.changes[0]).toHaveProperty('path');
    expect(withDiff.changes[0]).toHaveProperty('status');
    expect(withDiff.changes[0]).toHaveProperty('hunks');
    expect(withDiff.changes[0]).toHaveProperty('provenance');
  });

  // One MCP request per test: each request builds its own pack, and the text and JSON forms
  // are separate requests. Same assertions as when both were one test.
  it('13. the MCP response carries the same historical evidence', async () => {
    const handler = new StrataMCPHandler(repoDir);
    try {
      const text = await handler.handleToolCall('strata_context',
        { query: 'src/cache.ts', depth: 1, maxTokens: 4000 });
      // The contract is that MCP carries whatever diff evidence the pack holds — not
      // that a particular commit was ranked into it. Which commit gets diffed is a
      // ranking question, covered by test 2b against the reader directly.
      expect(text.content[0]!.text).toMatch(/@@ /);
      expect(text.content[0]!.text).toMatch(/\(VERIFIED\)/);
    } finally {
      handler.close();
    }
  });

  it('13b. the MCP JSON response carries the same historical evidence', async () => {
    const handler = new StrataMCPHandler(repoDir);
    try {
      const asJson = await handler.handleToolCall('strata_context',
        { query: 'src/cache.ts', depth: 1, maxTokens: 4000, format: 'json' });
      const parsed = JSON.parse(asJson.content[0]!.text);
      expect(parsed.historicalContext.some((h: { changes?: unknown[] }) => h.changes?.length)).toBe(true);
    } finally {
      handler.close();
    }
  });

  it('14. existing context behaviour is intact', () => {
    const pack = roomy();
    expect(pack.target.resolution).toBe('exact_file');
    expect(pack.codeNeighborhood[0]!.path).toBe('src/cache.ts');
    expect(pack.relationships.length).toBeGreaterThan(0);
    expect(pack.provenanceSummary.VERIFIED).toBeGreaterThan(0);
    // The working tree is untouched by any amount of context building.
    expect(dirtyFiles()).toEqual([]);
  });
});
