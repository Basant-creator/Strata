import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { StrataDatabase } from '../src/storage/db.js';
import { buildPromptContext } from '../src/integrations/claude-hook.js';

/**
 * The prompt hook refreshes the store before it builds a pack.
 *
 * Before this, the hook read whatever the last `strata index` left behind. A commit or
 * a new file made since then was missing from every pack until someone re-indexed by
 * hand, and nothing told the agent the pack was out of date. The refresh is the same
 * incremental pass as `strata index`, made cheap enough to run on every prompt: hashes
 * are compared before anything is parsed, the commit cache is re-read only when HEAD
 * moved, and the file -> commit edges are rebuilt in one transaction, only when the
 * cache they project changed.
 *
 * Every test runs against a real git repository: what is being checked is whether the
 * hook sees the repository as it is now.
 */
describe('the prompt hook refreshes the store', () => {
  const repoDir = path.join(process.cwd(), '.test_repo_hook_refresh');
  const logFile = path.join(process.cwd(), '.test_hook_refresh.log');

  const write = (rel: string, body: string): void => {
    const abs = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf-8');
  };
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' }).trim();
  const commit = (message: string): string => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', '--short', 'HEAD');
  };
  const indexByHand = (): void => {
    const service = new StrataService(repoDir);
    try { service.indexCode(); } finally { service.close(); }
  };
  const contextOf = (r: ReturnType<typeof buildPromptContext>): string =>
    r.output?.hookSpecificOutput.additionalContext ?? '';

  beforeAll(() => {
    for (const p of [repoDir, logFile]) if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    fs.mkdirSync(repoDir, { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'user.name', 'Fixture Author');
    write('src/billing/refund.ts', [
      'export function refundAmount(paid: number): number {',
      '  return paid;',
      '}',
      '',
    ].join('\n'));
    commit('Refund the full amount paid');

    const service = new StrataService(repoDir);
    service.init();
    service.close();
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(() => {
    for (const p of [repoDir, logFile]) if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  });

  it('1. the first index after init builds the file -> commit edges', () => {
    // init fills the commit cache but builds no edges. An index that trusted "the cache
    // did not change on this run" would skip the build and leave every history empty.
    indexByHand();
    const service = new StrataService(repoDir);
    try {
      const pack = service.getContextPack('src/billing/refund.ts');
      expect(pack.historicalContext.length).toBeGreaterThan(0);
    } finally {
      service.close();
    }
  });

  it('2. a commit made after the last index is in the pack, without re-indexing', () => {
    write('src/billing/refund.ts', [
      'export function refundAmount(paid: number): number {',
      '  return Math.max(0, paid - 5);',
      '}',
      '',
    ].join('\n'));
    const fresh = commit('Keep a five unit fee on refunds, per finance');

    const r = buildPromptContext({ prompt: 'Why does src/billing/refund.ts keep a fee?', cwd: repoDir });

    expect(r.decision).toBe('delivered');
    expect(r.refresh).toMatchObject({ commitsRefreshed: true, filesIndexed: 1 });
    expect(r.refresh!.error).toBeUndefined();
    expect(contextOf(r)).toContain(fresh);
    expect(contextOf(r)).toContain('Keep a five unit fee on refunds');
  });

  it('3. a file added since the last index can be the target', () => {
    write('src/billing/chargeback.ts', [
      'export function chargebackWindowDays(): number {',
      '  return 60;',
      '}',
      '',
    ].join('\n'));

    const stale = buildPromptContext({ prompt: 'What does chargebackWindowDays return?', cwd: repoDir, }, { refresh: false });
    expect(stale.targets ?? []).not.toContain('src/billing/chargeback.ts');

    const r = buildPromptContext({ prompt: 'What does chargebackWindowDays return?', cwd: repoDir });
    expect(r.targets).toContain('src/billing/chargeback.ts');
    expect(r.refresh!.filesIndexed).toBe(1);
  });

  it('4. when nothing moved, the refresh re-reads no history and re-parses no file', () => {
    const r = buildPromptContext({ prompt: 'Why does src/billing/refund.ts keep a fee?', cwd: repoDir });
    expect(r.refresh).toMatchObject({ commitsRefreshed: false, filesIndexed: 0, filesRemoved: 0 });
    // The edges were kept, not dropped: the history is still there.
    expect(contextOf(r)).toContain('Keep a five unit fee on refunds');
  });

  it('5. refresh: false builds from the store as it was', () => {
    write('src/billing/notes.ts', 'export const refundNote = "fees apply";\n');
    const later = commit('Explain refund fees to customers');

    const r = buildPromptContext({ prompt: 'Why does src/billing/refund.ts keep a fee?', cwd: repoDir }, { refresh: false });
    expect(r.refresh).toBeUndefined();
    expect(contextOf(r)).not.toContain(later);
  });

  it('6. a refresh that fails is logged, and the pack is still delivered from the store', () => {
    vi.spyOn(StrataService.prototype, 'indexCode').mockImplementation(() => {
      throw new Error('database is locked');
    });

    const r = buildPromptContext(
      { prompt: 'Why does src/billing/refund.ts keep a fee?', cwd: repoDir, session_id: 'refresh-fail' },
      { deliveryLog: logFile },
    );

    expect(r.decision).toBe('delivered');
    expect(r.refresh!.error).toBe('database is locked');
    expect(contextOf(r)).toContain('Keep a five unit fee on refunds');
    const logged = fs.readFileSync(logFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(logged.find((e) => e.session === 'refresh-fail').refresh.error).toBe('database is locked');
  });

  // ---------------------------------------------------------------- the file-time shortcut
  //
  // The hook skips hashing a file whose size is unchanged and whose modification time is
  // well before its content was last confirmed. These pin down both sides of that trade.

  const confirmedAt = (rel: string): number => {
    const db = new StrataDatabase({ repoRoot: repoDir });
    try {
      return (db.getRawDb().prepare('SELECT indexed_at FROM code_files WHERE path = ?').get(rel) as
        { indexed_at: number }).indexed_at;
    } finally {
      db.close();
    }
  };
  const setModified = (rel: string, ms: number): void => {
    fs.utimesSync(path.join(repoDir, rel), new Date(ms), new Date(ms));
  };

  it('7. a same-size edit whose time lands just before the content was confirmed is still caught', () => {
    buildPromptContext({ prompt: 'What does chargebackWindowDays return?', cwd: repoDir });
    const rel = 'src/billing/chargeback.ts';
    const before = fs.readFileSync(path.join(repoDir, rel), 'utf-8');
    fs.writeFileSync(path.join(repoDir, rel), before.replace('return 60;', 'return 90;'), 'utf-8');
    // The racy case: written while the last index was reading it, so the file looks
    // older than its confirmation by less than the window.
    setModified(rel, confirmedAt(rel) - 500);

    const r = buildPromptContext({ prompt: 'What does chargebackWindowDays return?', cwd: repoDir });
    expect(r.refresh!.filesIndexed).toBe(1);
  });

  it('8. an edit that keeps the size and moves the time back is missed by the hook; strata index catches it', () => {
    const rel = 'src/billing/chargeback.ts';
    const before = fs.readFileSync(path.join(repoDir, rel), 'utf-8');
    fs.writeFileSync(path.join(repoDir, rel), before.replace('return 90;', 'return 45;'), 'utf-8');
    setModified(rel, confirmedAt(rel) - 60 * 60 * 1000);

    const hooked = buildPromptContext({ prompt: 'What does chargebackWindowDays return?', cwd: repoDir });
    expect(hooked.refresh!.filesIndexed).toBe(0);

    const service = new StrataService(repoDir);
    try {
      expect(service.indexCode().filesIndexed).toBe(1);
    } finally {
      service.close();
    }
  });

  it('9. a file touched without changing is not re-parsed, nor even looked at', () => {
    const rel = 'src/billing/refund.ts';
    const stamped = confirmedAt(rel);
    setModified(rel, Date.now());

    const first = buildPromptContext({ prompt: 'Why does src/billing/refund.ts keep a fee?', cwd: repoDir });
    expect(first.refresh!.filesIndexed).toBe(0);
    // Git does not call it changed, so the hook trusted HEAD for it and left its row alone.
    expect(confirmedAt(rel)).toBe(stamped);
  });

  // ------------------------------------------------------------ the `git status` shortcut
  //
  // With HEAD where the last scan left it, the hook looks only at the paths `git status`
  // calls changed now or called changed then. These pin down the cases a list of what is
  // changed *now* would miss.

  it('10. an edit put back to its committed content is re-indexed', () => {
    const rel = 'src/billing/refund.ts';
    const committed = fs.readFileSync(path.join(repoDir, rel), 'utf-8');
    write(rel, `${committed}export const REFUND_FEE = 5;\n`);
    expect(buildPromptContext({ prompt: 'Why does src/billing/refund.ts keep a fee?', cwd: repoDir })
      .refresh!.filesIndexed).toBe(1);

    // Clean again, so Git no longer names it; the store still holds the edit.
    git('checkout', '--', rel);
    expect(buildPromptContext({ prompt: 'Why does src/billing/refund.ts keep a fee?', cwd: repoDir })
      .refresh!.filesIndexed).toBe(1);
  });

  it('11. a new file is indexed and a deleted one removed', () => {
    write('src/billing/credit.ts', 'export function creditNote(): number {\n  return 1;\n}\n');
    const added = buildPromptContext({ prompt: 'What does creditNote return?', cwd: repoDir });
    expect(added.refresh!.filesIndexed).toBe(1);

    fs.rmSync(path.join(repoDir, 'src/billing/credit.ts'));
    const removed = buildPromptContext({ prompt: 'What does creditNote return?', cwd: repoDir });
    expect(removed.refresh!.filesRemoved).toBe(1);
  });

  it('12. a changed .gitignore scans in full, so a newly ignored file leaves the index', () => {
    write('src/generated/client.ts', 'export const generatedClient = 1;\n');
    expect(buildPromptContext({ prompt: 'Where is generatedClient defined?', cwd: repoDir })
      .refresh!.filesIndexed).toBe(1);

    // Git now reports nothing about the file at all; only a full listing drops it.
    write('.gitignore', 'src/generated/\n');
    const r = buildPromptContext({ prompt: 'Where is generatedClient defined?', cwd: repoDir });
    expect(r.refresh!.filesRemoved).toBe(1);
  });
});
