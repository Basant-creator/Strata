import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { StrataMCPHandler } from '../src/mcp/server.js';
import { ContextPack, Statement } from '../src/context/pack.js';

/**
 * The redesigned context pack: current state, historical decisions, and whether they hold.
 *
 * What these tests are for
 * ------------------------
 * Retrieval stopped being the problem. The last history-dependent run surfaced the
 * decisive commit, its diff and a deleted test every time — and one agent read all of it
 * and reversed the decision anyway, calling the reversal a deliberate trade. Nothing in
 * the pack had told it that the thing it was undoing was still in force, or that its own
 * task was walking straight back into it.
 *
 * So the contract under test here is not "the evidence is present". It is:
 *
 *   - current state and historical state are told apart
 *   - a decision says whether it still holds, and how that was established
 *   - measurement is VERIFIED, reading is INFERRED, and neither borrows the other's label
 *   - a collision between the task and a live decision is raised, not resolved
 *   - what is not known is said rather than omitted
 *
 * The fixture is synthetic. No path, symbol or commit here appears in any repository this
 * work was measured against — a pack that only works on the case that motivated it is not
 * a product feature.
 *
 *     config/schema.sql        the identity: uploadId -> contentKey       (stays: ACTIVE)
 *     src/identityService.ts   the target; partly rewritten later         (UNKNOWN)
 *     src/legacy.ts            a change that is later undone              (SUPERSEDED)
 *     tests/identityProbe.ts   added with the flip, deleted later         (recovered)
 *     src/apiClient.ts         calls the target                          (call site)
 */
describe('context pack v2', () => {
  const repoDir = path.join(process.cwd(), '.test_repo_packv2');
  let service: StrataService;
  const sha: Record<string, string> = {};

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' });
  const write = (rel: string, body: string): void => {
    const abs = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf-8');
  };
  const commit = (label: string, date: string, message: string): void => {
    git('add', '-A');
    execFileSync('git', ['commit', '-q', '-m', message], {
      cwd: repoDir, encoding: 'utf-8',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    sha[label] = git('rev-parse', 'HEAD').trim();
  };
  const short = (label: string): string => sha[label]!.slice(0, 7);

  beforeAll(() => {
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(repoDir, { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'user.name', 'Fixture Author');

    // ---- c1: the original design, keyed on the upload id.
    write('config/schema.sql', [
      'CREATE TABLE asset (',
      '  uploadId TEXT PRIMARY KEY,',
      '  label    TEXT',
      ');',
      '',
    ].join('\n'));
    write('src/identityService.ts', [
      'export interface IdentityParams { uploadId: string; label: string; }',
      'export function resolveIdentity(params: IdentityParams): string {',
      '  return params.uploadId;',
      '}',
      'export const identityCache = new Map<string, string>();',
      '',
    ].join('\n'));
    write('src/apiClient.ts', [
      "import { resolveIdentity } from './identityService.js';",
      'export function fetchAsset(uploadId: string, label: string): string {',
      '  return resolveIdentity({ uploadId, label });',
      '}',
      '',
    ].join('\n'));
    write('src/legacy.ts', 'export const legacyMode = false;\n');
    write('src/stable.ts', 'export const stableFlag = true;\n');
    commit('c1', '2024-01-10T09:00:00+00:00', 'Initial asset plumbing');

    /*
      c2: the decision. Identity moves off the upload id, and a probe is written that
      states, in the author's own words, what the change is for. The commit message says
      nothing useful — deliberately, because a useful message would let a reader off the
      hook that these tests exist to check.
    */
    write('config/schema.sql', [
      'CREATE TABLE asset (',
      '  contentKey TEXT PRIMARY KEY,',
      '  uploadId   TEXT,',
      '  label      TEXT',
      ');',
      '',
    ].join('\n'));
    write('src/identityService.ts', [
      'export interface IdentityParams { uploadId?: string; label: string; owner: string; }',
      'export function resolveIdentity(params: IdentityParams): string {',
      '  return `${params.owner.toLowerCase()}:::${params.label.toLowerCase()}`;',
      '}',
      'export const identityCache = new Map<string, string>();',
      'export function warmIdentity(owner: string, label: string): void {',
      '  identityCache.set(resolveIdentity({ owner, label }), owner);',
      '}',
      '',
    ].join('\n'));
    write('tests/identityProbe.ts', [
      "import { resolveIdentity } from '../src/identityService.js';",
      'const a = resolveIdentity({ owner: "Owner", label: "Thing", uploadId: "upload_one" });',
      'const b = resolveIdentity({ owner: "owner", label: "thing", uploadId: "upload_two" });',
      'console.log(a === b ? "SUCCESS: one row for two uploadId values" : "FAIL");',
      '',
    ].join('\n'));
    write('src/apiClient.ts', [
      "import { resolveIdentity } from './identityService.js';",
      'export function fetchAsset(owner: string, label: string): string {',
      '  return resolveIdentity({ owner, label });',
      '}',
      '',
    ].join('\n'));
    commit('c2', '2024-02-14T09:00:00+00:00', 'Assorted fixes');

    // ---- c3: a change to legacy.ts that will not last.
    write('src/legacy.ts', [
      'export const legacyMode = false;',
      'export const legacyRetryBudget = 7;',
      '',
    ].join('\n'));
    commit('c3', '2024-03-01T09:00:00+00:00', 'Add a retry budget');

    // ---- c4: the probe is deleted, and c3 is undone.
    fs.rmSync(path.join(repoDir, 'tests/identityProbe.ts'));
    write('src/legacy.ts', 'export const legacyMode = false;\n');
    commit('c4', '2024-04-01T09:00:00+00:00', 'Drop the scratch probe and the retry budget');

    // ---- c5: part of c2's service rewrite is replaced; stable.ts gains a line that lasts.
    write('src/identityService.ts', [
      'export interface IdentityParams { uploadId?: string; label: string; owner: string; }',
      'export function resolveIdentity(params: IdentityParams): string {',
      '  return `${params.owner.trim().toLowerCase()}:::${params.label.trim().toLowerCase()}`;',
      '}',
      'export const identityCache = new Map<string, string>();',
      'export function warmIdentity(owner: string, label: string): void {',
      '  identityCache.set(resolveIdentity({ owner, label }), owner);',
      '}',
      '',
    ].join('\n'));
    write('src/stable.ts', [
      'export const stableFlag = true;',
      'export const stableThreshold = 42;',
      '',
    ].join('\n'));
    commit('c5', '2024-05-01T09:00:00+00:00', 'Trim whitespace when building identities');

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
    every file's builds in parallel. Measured: tests 4b and 7 built two packs each and took
    4.6-4.9 s of their 5 s under the suite, against ~2.8 s alone, and timed out whenever the
    machine was busier. Most tests here ask one of the same seven questions, so each is
    built once and shared, as historical_diff does. Nothing modifies a pack: tests only read
    and render them. The two tests that change what a pack would contain — a new record, an
    edited file — clear the cache when they do.
  */
  const built = new Map<string, ContextPack>();
  const packFor = (query: string, maxTokens = 6000): ContextPack => {
    const key = `${query}|${maxTokens}`;
    let pack = built.get(key);
    if (!pack) {
      pack = service.getContextPack(query, { depth: 1, maxTokens });
      built.set(key, pack);
    }
    return pack;
  };
  /** The decision about *file*, from whichever commit decided it. */
  const decisionOn = (pack: ContextPack, file: string, commitLabel?: string) =>
    pack.historicalDecisions.find(
      (d) => d.path === file && (!commitLabel || d.commit === short(commitLabel)));

  // ------------------------------------------------------------------ 1

  it('1. tells current state and historical state apart', () => {
    const pack = packFor('key lookups on uploadId in src/identityService.ts');
    const d = decisionOn(pack, 'config/schema.sql', 'c2');
    expect(d, 'the schema decision is surfaced').toBeTruthy();

    expect(d!.historicalState.join('\n')).toContain('uploadId TEXT PRIMARY KEY');
    expect(d!.currentState.join('\n')).toContain('contentKey TEXT PRIMARY KEY');
    // The two must never be confusable: what is gone is not presented as what is there.
    expect(d!.currentState.join('\n')).not.toContain('uploadId TEXT PRIMARY KEY');
    expect(d!.currentIsAtHead).toBe(true);

    const text = service.renderContextPack(pack);
    expect(text).toContain('HISTORICAL  (what used to be there)');
    expect(text).toContain('CURRENT  (what replaced it, still present at HEAD)');
  });

  // ------------------------------------------------------------------ 2-4

  it('2. reports ACTIVE when the change is still in the file at HEAD', () => {
    const d = decisionOn(packFor('src/identityService.ts uploadId'), 'config/schema.sql', 'c2')!;
    expect(d.status).toBe('ACTIVE');
    expect(d.statusProvenance).toBe('VERIFIED');
    expect(d.statusReason).toMatch(/are in config\/schema\.sql at HEAD/);
    expect(d.supersededBy).toBeUndefined();
  });

  it('3. reports SUPERSEDED when a later commit removed the change, and names it', () => {
    const d = decisionOn(packFor('src/legacy.ts'), 'src/legacy.ts', 'c3');
    expect(d, 'the legacy change is surfaced').toBeTruthy();
    expect(d!.status).toBe('SUPERSEDED');
    expect(d!.statusProvenance).toBe('VERIFIED');
    // Not merely "something changed later" — the commit that did it.
    expect(d!.supersededBy?.shortHash).toBe(short('c4'));
    expect(d!.statusReason).toMatch(/None of the .* line\(s\) this commit added/);
  });

  it('4. reports UNKNOWN when a change only partly survived, with the ratio', () => {
    /*
      Asserted on the rule, not on one commit.

      Several changes in this fixture were partly rewritten later, and which of them ranks
      into the pack is a separate question from whether partial survival is reported
      honestly. Pinning the test to one commit would make it a test of the ranking.
    */
    const pack = packFor('src/identityService.ts');
    const unknown = pack.historicalDecisions.filter((d) => d.status === 'UNKNOWN');
    expect(unknown.length, 'a partly-surviving change is surfaced').toBeGreaterThan(0);

    for (const d of unknown) {
      // Honest about which way it is unknown, and never dressed up as either answer.
      expect(d.statusReason).toMatch(/\d+ of \d+ line\(s\) this commit added/);
      expect(d.statusReason).toMatch(/partly rewritten/);
      expect(d.statusReason).toMatch(/not established/);
      expect(d.statusProvenance).toBe('UNKNOWN');
      // Neither confident label is implied anywhere on it.
      expect(d.supersededBy).toBeUndefined();
      expect(d.survivingLines).toBeGreaterThan(0);
      expect(d.survivingLines).toBeLessThan(d.addedLines);
    }
  });

  it('4b. does not call a decision ACTIVE merely because the commit is old', () => {
    // c3 is older than c5 and SUPERSEDED; c2's schema change is older still and ACTIVE.
    // Age predicts neither, which is the point.
    const legacy = decisionOn(packFor('src/legacy.ts'), 'src/legacy.ts', 'c3')!;
    const schema = decisionOn(packFor('src/identityService.ts uploadId'), 'config/schema.sql', 'c2')!;
    expect(schema.authoredAt).toBeLessThan(legacy.authoredAt);
    expect(schema.status).toBe('ACTIVE');
    expect(legacy.status).toBe('SUPERSEDED');
  });

  // ------------------------------------------------------------------ 5-7

  it('5. links the decision to the evidence that travelled with it', () => {
    const d = decisionOn(packFor('key lookups on uploadId in src/identityService.ts'),
                         'config/schema.sql', 'c2')!;
    expect(d.support.length).toBeGreaterThan(0);
    expect(d.support[0]!.reference).toContain('tests/identityProbe.ts');
    expect(d.support[0]!.provenance).toBe('VERIFIED');
  });

  it('6. still attaches the underlying diff to the commit', () => {
    const pack = packFor('key lookups on uploadId in src/identityService.ts');
    const withDiff = pack.historicalContext.find((h) => h.changes?.length);
    expect(withDiff).toBeTruthy();
    expect(service.renderContextPack(pack)).toMatch(/@@ /);
  });

  it('7. recovers the deleted probe and quotes the line that states its point', () => {
    expect(fs.existsSync(path.join(repoDir, 'tests/identityProbe.ts'))).toBe(false);

    const d = decisionOn(packFor('key lookups on uploadId in src/identityService.ts'),
                         'config/schema.sql', 'c2')!;
    // Not forty lines of setup: the one line that says what the change was for.
    expect(d.support[0]!.quote).toContain('one row for two uploadId values');
    expect(service.renderContextPack(packFor('key lookups on uploadId in src/identityService.ts')))
      .toContain('one row for two uploadId values');
  });

  // ------------------------------------------------------------------ 8-9

  it('8. keeps measurement VERIFIED and reading INFERRED, never the other way round', () => {
    const pack = packFor('key lookups on uploadId in src/identityService.ts');
    const d = decisionOn(pack, 'config/schema.sql', 'c2')!;

    // What was measured.
    expect(d.statusProvenance).toBe('VERIFIED');
    expect(d.support.every((s) => s.provenance === 'VERIFIED')).toBe(true);
    expect(d.whyItMatters.filter((w) => w.provenance === 'VERIFIED').length).toBeGreaterThan(0);

    // What was read from it. The absence-of-evidence sentence is never VERIFIED.
    const readings = d.whyItMatters.filter((w) => /no later change reversing/.test(w.statement));
    expect(readings.length).toBe(1);
    expect(readings[0]!.provenance).toBe('INFERRED');
    expect(d.caution?.provenance).toBe('INFERRED');

    // And the commit's own words stay the author's claim throughout.
    expect(service.renderContextPack(pack)).toContain("subject is the author's own description, DECLARED");
  });

  it('9. says what it could not establish instead of leaving the section empty', () => {
    const pack = packFor('src/identityService.ts');
    expect(pack.previousAttempts).toEqual([]);
    expect(pack.uncertainty.join(' ')).toMatch(/no previous attempt is recorded/);
    expect(pack.uncertainty.join(' ')).toMatch(/not evidence that none was made/);
    // A decision it could not settle is named as unsettled.
    expect(pack.uncertainty.join(' ')).toMatch(/still holds could not be determined/);
    expect(service.renderContextPack(pack)).toContain('## UNCERTAINTY');
  });

  // ------------------------------------------------------------------ 10-12 records

  it('10-12. links a record to the file, symbol and commit it is about', () => {
    service.recordChange({
      title: 'Owner+label identity, not the upload id',
      intent: 'Two uploads of one asset must share a row, so identity cannot be the upload id',
      intentConfidence: 'DECLARED',
      files: [{ path: 'src/identityService.ts', changeType: 'modify',
                symbols: ['resolveIdentity', 'noSuchSymbol'] }],
      attempts: [{
        approach: 'Key the cache on uploadId',
        status: 'failed',
        failureReason: 'Re-uploads of one asset were analysed twice and overwrote each other',
        confidence: 'DECLARED',
      }],
      consequences: ['Callers must pass owner and label, not only an uploadId'],
      evidence: [{ type: 'git_commit', reference: sha.c2!, confidence: 'VERIFIED' }],
      result: { status: 'success' },
    });
    // Packs built before the record do not carry it.
    built.clear();

    const pack = packFor('src/identityService.ts');

    // 11. the attempt names the code it is about.
    const attempt = pack.previousAttempts.find((a) => /Key the cache on uploadId/.test(a.statement));
    expect(attempt, 'the failed attempt is surfaced').toBeTruthy();
    expect(attempt!.statement).toContain('src/identityService.ts');
    expect(attempt!.statement).toContain('resolveIdentity');
    expect(attempt!.provenance).toBe('DECLARED');

    // 10. the links themselves: file, symbol and commit, each verified against the index.
    expect(attempt!.evidence).toContain('file:src/identityService.ts');
    expect(attempt!.evidence).toContain('symbol:src/identityService.ts#resolveIdentity');
    expect(attempt!.evidence.some((e) => e.startsWith('commit:'))).toBe(true);
    // A symbol the index cannot confirm is not asserted.
    expect(attempt!.evidence.join(' ')).not.toContain('noSuchSymbol');

    // 12. the consequence is linked the same way.
    const consequence = pack.consequences.find((c) => /Callers must pass owner/.test(c.statement));
    expect(consequence, 'the consequence is surfaced').toBeTruthy();
    expect(consequence!.statement).toContain('src/identityService.ts');
    expect(consequence!.evidence).toContain('file:src/identityService.ts');

    // And the constraint the record states, still DECLARED.
    const constraint = pack.decisionsAndConstraints.find((c) => /must share a row/.test(c.statement));
    expect(constraint?.provenance).toBe('DECLARED');
  });

  // ------------------------------------------------------------------ 13

  it('13. renders the chain and marks the steps nothing accounts for', () => {
    const pack = packFor('src/identityService.ts');
    const chain = pack.changeChains[0];
    expect(chain, 'the service has a chain').toBeTruthy();
    expect(chain!.sequence.length).toBeGreaterThanOrEqual(2);

    // Oldest first, so the chain reads forwards.
    const order = chain!.sequence.map((s) => s.shortHash);
    expect(order[0]).toBe(short('c1'));

    const text = service.renderContextPack(pack);
    expect(text).toContain('## CHANGE CHAINS');
    // Ordering is a fact; causation is not claimed anywhere.
    expect(text).toContain('that one step caused the next is not claimed');
    // A step with no diff and no record is marked rather than left to read as explained.
    if (chain!.sequence.some((s) => !s.explained)) {
      expect(text).toContain('[why: UNKNOWN]');
      expect(chain!.gaps.length).toBeGreaterThan(0);
    }
  });

  // ------------------------------------------------------------------ 14

  it('14. keeps the live decision when the budget bites', () => {
    const tight = service.getContextPack(
      'key lookups on uploadId in src/identityService.ts', { depth: 2, maxTokens: 900 });

    const d = decisionOn(tight, 'config/schema.sql', 'c2');
    expect(d, 'the decision survives a budget a third of normal').toBeTruthy();
    // Both halves of it, or it cannot be checked.
    expect(d!.historicalState.join('\n') + d!.currentState.join('\n')).toContain('contentKey');
    expect(d!.status).toBe('ACTIVE');
    expect(tight.diagnostics.estimatedTokens).toBeLessThanOrEqual(900);
  });

  // ------------------------------------------------------------------ 15

  it('15. raises a collision between the task and a live decision, without settling it', () => {
    const colliding = packFor('key lookups on uploadId in src/identityService.ts');
    const d = decisionOn(colliding, 'config/schema.sql', 'c2')!;
    expect(d.caution, 'the task names what the decision moved away from').toBeTruthy();
    expect(d.caution!.statement).toContain('uploadId');
    expect(d.caution!.statement).toMatch(/would reverse that change/);
    // It hands the choice back rather than taking it.
    expect(d.caution!.statement).toMatch(/the decision is yours/);
    expect(service.renderContextPack(colliding)).toContain('CAUTION');
  });

  it('15b. does not raise a collision when the task names nothing the decision removed', () => {
    const quiet = packFor('src/identityService.ts');
    const d = decisionOn(quiet, 'config/schema.sql', 'c2');
    // A warning that always fires is a warning nobody reads.
    expect(d?.caution).toBeUndefined();
  });

  it('15c. does not fire on a partial word match', () => {
    // "upload" is a prefix of "uploadId"; naming the shorter word is not naming the field.
    const pack = packFor('upload handling in src/identityService.ts');
    const d = decisionOn(pack, 'config/schema.sql', 'c2');
    expect(d?.caution).toBeUndefined();
  });

  // ------------------------------------------------------------------ 16

  it('16. states no motive it cannot evidence', () => {
    const pack = packFor('key lookups on uploadId in src/identityService.ts');
    const statements: Statement[] = [
      ...pack.whyThisAreaMatters,
      ...pack.historicalDecisions.flatMap((d) => d.whyItMatters),
    ];
    expect(statements.length).toBeGreaterThan(0);

    /*
      Nothing labelled VERIFIED may explain *why* anyone did anything.

      A diff proves what changed and cannot prove the reason. This is the promotion the
      whole system exists to refuse, and it is the easiest one to make by accident when
      generating prose about a commit.
    */
    const motive = /\bbecause\b|\bin order to\b|\bwanted\b|\bintended\b|\bso that\b|\bdecided to\b/i;
    for (const s of statements.filter((x) => x.provenance === 'VERIFIED')) {
      expect(motive.test(s.statement), `VERIFIED statement claims a motive: ${s.statement}`).toBe(false);
    }
    // And every statement carries a label; none is unattributed.
    for (const s of statements) {
      expect(['VERIFIED', 'DECLARED', 'INFERRED', 'UNKNOWN']).toContain(s.provenance);
      expect(s.statement.trim().length).toBeGreaterThan(0);
    }
  });

  // ------------------------------------------------------------------ 17-19

  it('17. exposes the new structure in JSON', () => {
    const parsed = JSON.parse(JSON.stringify(
      packFor('key lookups on uploadId in src/identityService.ts')));

    for (const key of ['target', 'currentBehavior', 'callSites', 'historicalDecisions',
                       'historicalContext', 'changeChains', 'previousAttempts',
                       'consequences', 'decisionsAndConstraints', 'uncertainty',
                       'evidence', 'provenanceSummary', 'diagnostics']) {
      expect(parsed, `pack is missing ${key}`).toHaveProperty(key);
    }
    const d = parsed.historicalDecisions.find((x: { path: string }) => x.path === 'config/schema.sql');
    for (const key of ['path', 'commit', 'status', 'statusReason', 'statusProvenance',
                       'historicalState', 'currentState', 'currentIsAtHead',
                       'consequences', 'support', 'whyItMatters']) {
      expect(d, `decision is missing ${key}`).toHaveProperty(key);
    }
    expect(['ACTIVE', 'SUPERSEDED', 'UNKNOWN']).toContain(d.status);
  });

  // One MCP request per test: each request builds its own pack, and the text and JSON forms
  // are separate requests. Same assertions as when both were one test.
  it('18. carries the same structure over MCP', async () => {
    const handler = new StrataMCPHandler(repoDir);
    try {
      const rendered = await handler.handleToolCall('strata_context', {
        query: 'key lookups on uploadId in src/identityService.ts', depth: 1, maxTokens: 6000,
      });
      const text = rendered.content[0]!.text;
      expect(text).toContain('## HISTORICAL DECISIONS');
      expect(text).toContain('STATUS: ACTIVE');
      expect(text).toContain('CAUTION');
      expect(text).toContain('## CURRENT BEHAVIOR');
    } finally {
      handler.close();
    }
  });

  it('18b. carries the same structure over MCP as JSON', async () => {
    const handler = new StrataMCPHandler(repoDir);
    try {
      const asJson = await handler.handleToolCall('strata_context', {
        query: 'key lookups on uploadId in src/identityService.ts', maxTokens: 6000, format: 'json',
      });
      const parsed = JSON.parse(asJson.content[0]!.text);
      expect(parsed.historicalDecisions.length).toBeGreaterThan(0);
      expect(parsed.currentBehavior.length).toBeGreaterThan(0);
    } finally {
      handler.close();
    }
  });

  it('19. renders every section it has evidence for, and no empty ones', () => {
    const text = service.renderContextPack(
      packFor('key lookups on uploadId in src/identityService.ts'));
    for (const section of ['# STRATA CONTEXT', '## WHY THIS AREA MATTERS', '## CODE NEIGHBORHOOD',
                           '## CURRENT BEHAVIOR', '## HISTORICAL DECISIONS', '## RELATIONSHIPS',
                           '## HISTORICAL CONTEXT', '## PROVENANCE']) {
      expect(text, `missing ${section}`).toContain(section);
    }
    // The provenance key is spelled out, so the labels mean something to a first-time reader.
    expect(text).toContain('VERIFIED = exact git/file content');
  });

  // ------------------------------------------------------------------ current behaviour

  it('20. quotes what the target does now, with the line numbers it already knew', () => {
    const pack = packFor('src/identityService.ts');
    const behavior = pack.currentBehavior.find((b) => b.file === 'src/identityService.ts');
    expect(behavior, 'the target has quoted behaviour').toBeTruthy();
    expect(behavior!.provenance).toBe('VERIFIED');

    const names = behavior!.signatures.map((s) => s.name);
    expect(names).toContain('resolveIdentity');
    const sig = behavior!.signatures.find((s) => s.name === 'resolveIdentity')!;
    expect(sig.text).toContain('export function resolveIdentity');
    expect(sig.line).toBeGreaterThan(0);

    // And where it is used — a line number, not an instruction to go and grep.
    const call = pack.callSites.find((c) => c.from === 'src/apiClient.ts');
    expect(call, 'the caller is located').toBeTruthy();
    expect(call!.symbol).toBe('resolveIdentity');
    expect(call!.line).toBeGreaterThan(0);
    expect(service.renderContextPack(pack)).toContain(`src/apiClient.ts:${call!.line}`);
  });

  it('21. quotes the file as it is on disk, not as it was committed', () => {
    const target = path.join(repoDir, 'src/identityService.ts');
    const original = fs.readFileSync(target, 'utf-8');
    try {
      fs.writeFileSync(target, original.replace('resolveIdentity', 'resolveIdentityEdited'), 'utf-8');
      service.indexCode();
      built.clear();
      const pack = packFor('src/identityService.ts');
      const names = pack.currentBehavior.flatMap((b) => b.signatures.map((s) => s.name));
      // An agent mid-edit must be shown what it is editing, not the last commit of it.
      expect(names).toContain('resolveIdentityEdited');
    } finally {
      fs.writeFileSync(target, original, 'utf-8');
      service.indexCode();
      built.clear();
    }
  });
});
