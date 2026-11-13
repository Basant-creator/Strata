import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { StrataService } from '../src/records/service.js';
import { GitClient } from '../src/git/git.js';
import { compareHistoryCandidates, HistoryCandidate } from '../src/context/history.js';

/**
 * A target's history beyond the commit cache.
 *
 * The cache holds the newest commits of the whole repository. The fixture narrows the
 * cache to the newest three commits and puts the change, its revert and the file's
 * creation behind them.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-depth-'));
const repo = path.join(base, 'repo');
const saved = { ...process.env };
const sha: Record<string, string> = {};
let svc: StrataService;
let completeBefore: string | null = null;

let clock = Date.parse('2026-01-01T00:00:00Z') / 1000;
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
// One hour apart, so "oldest" and "newest" never depend on hash order.
const dated = (...args: string[]): string => {
  const at = `${clock += 3600} +0000`;
  return execFileSync('git', args, {
    cwd: repo, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
};
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, 'utf-8');
};
const commit = (tag: string, message: string): void => {
  git('add', '-A');
  dated('commit', '-q', '-m', message);
  sha[tag] = git('rev-parse', 'HEAD').trim();
};

const LIMITER = 'src/limiter.ts';

beforeAll(() => {
  const globalConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(globalConfig, '', 'utf-8');
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  fs.mkdirSync(repo, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  git('config', 'core.autocrlf', 'false');

  write(LIMITER, 'export function allow(count: number): boolean {\n  return count < 10;\n}\n');
  commit('created', 'Add a request limiter');
  write(LIMITER, 'export function allow(tokens: number): boolean {\n  return tokens > 0; // token bucket\n}\n');
  commit('change', 'Switch the limiter to a token bucket');
  write(LIMITER, 'export function allow(count: number): boolean {\n  return count < 10;\n}\n');
  commit('revert', `Revert "Switch the limiter to a token bucket"\n\nThis reverts commit ${sha['change']}.\n\nBursts were dropped under load.`);
  for (let i = 1; i <= 6; i++) {
    write(`src/other${i}.ts`, `export const other${i} = ${i};\n`);
    commit(`noise${i}`, `Unrelated work ${i}`);
  }
  write(LIMITER, 'export function allow(tokens: number, burst = 5): boolean {\n  return tokens > 0 || burst > 0; // token bucket\n}\n');
  commit('reland', 'Re-land the token bucket with a burst allowance');

  svc = new StrataService(repo);
  svc.init();
  svc.indexCode();

  // Narrow the cache to the newest three commits, as a busy repository's would be.
  const db = new DatabaseSync(path.join(repo, '.strata', 'strata.db'));
  completeBefore = (db.prepare(`SELECT value FROM code_index_meta WHERE key = 'commit_cache_complete'`)
    .get() as { value: string } | undefined)?.value ?? null;
  const keep = [sha['noise5'], sha['noise6'], sha['reland']];
  const slots = keep.map(() => '?').join(',');
  db.prepare(`DELETE FROM git_commits_cache WHERE hash NOT IN (${slots})`).run(...keep);
  db.prepare(`DELETE FROM code_file_commits WHERE commit_hash NOT IN (${slots})`).run(...keep);
  db.prepare(`UPDATE code_index_meta SET value = '0' WHERE key = 'commit_cache_complete'`).run();
  db.close();
}, 120_000);

afterAll(() => {
  svc?.close();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(base, { recursive: true, force: true });
});

const short = (tag: string): string => sha[tag]!.slice(0, 7);

describe('GitClient.getFileHistory', () => {
  it('reads the newest commits to the path, with their full file lists', () => {
    const commits = new GitClient(repo).getFileHistory([LIMITER], 2);
    expect(commits.slice(0, 2).map((c) => c.hash)).toEqual([sha['reland'], sha['revert']]);
  });

  it('always adds the commit that created the path, however far back', () => {
    const commits = new GitClient(repo).getFileHistory([LIMITER], 1);
    expect(commits.map((c) => c.hash)).toEqual([sha['reland'], sha['created']]);
  });

  it('reads nothing for no paths, and nothing for a path git does not know', () => {
    expect(new GitClient(repo).getFileHistory([], 10)).toEqual([]);
    expect(new GitClient(repo).getFileHistory(['src/nowhere.ts'], 10)).toEqual([]);
  });
});

describe('a cache that is the whole history', () => {
  it('is marked complete when the read reached the first commit, so nothing is read past it', () => {
    expect(completeBefore).toBe('1');
  });
});

describe('a pack about the target', () => {
  const ask = () => svc.getContextPack(`how did ${LIMITER} come to use a token bucket?`);

  it('shows the change and its revert, though both lie beyond the cache', () => {
    const hashes = ask().historicalContext.map((h) => h.shortHash);
    expect(hashes).toEqual(expect.arrayContaining([short('change'), short('revert'), short('reland')]));
  });

  it('shows the commit that created the file', () => {
    const created = ask().historicalContext.find((h) => h.shortHash === short('created'));
    expect(created?.introducedAnchor).toBe(true);
  });

  it('marks the commits it found by what they say, and keeps them under a tight budget', () => {
    const full = ask().historicalContext;
    expect(full.filter((h) => h.matchesRequest).map((h) => h.shortHash).sort())
      .toEqual([short('change'), short('revert')].sort());
    // A budget that sheds history: the unmarked commits go first.
    const tight = svc.getContextPack(`how did ${LIMITER} come to use a token bucket?`, { maxTokens: 1200 });
    expect(tight.historicalContext.length).toBeLessThan(full.length);
    const kept = tight.historicalContext.filter((h) => h.matchesRequest).map((h) => h.shortHash);
    expect(kept).toEqual(expect.arrayContaining([short('change'), short('revert')]));
  }, 30_000); // Two builds, each reading the file's history from git.

  /*
    The budget shed it and kept theirs. The pack here is rearranged the same way: the top
    commits' diffs moved to one below, and no decision citing the top commits, which would
    otherwise protect them.
  */
  it('never sheds a commit the ranking put first while a lower one still carries a diff', () => {
    const full = svc.getContextPack(`how did ${LIMITER} come to use a token bucket?`, { maxTokens: 100_000 });
    const top = full.historicalContext.filter((h) => h.matchesRequest).map((h) => h.shortHash);
    const low = full.historicalContext.find((h) => !h.matchesRequest)!;
    for (const h of full.historicalContext) {
      if (!top.includes(h.shortHash) || !h.changes) continue;
      low.changes = [...(low.changes ?? []), ...h.changes];
      delete h.changes;
    }
    expect(low.changes?.length).toBeGreaterThan(0);
    full.historicalDecisions = full.historicalDecisions.filter((d) => !top.includes(d.commit));

    const engine = (svc as unknown as { contextEngine: { applyBudget(p: unknown, n: number): void } }).contextEngine;
    let shedAny = false;
    for (let maxTokens = 2000; maxTokens >= 300; maxTokens -= 100) {
      const pack = structuredClone(full);
      engine.applyBudget(pack, maxTokens);
      const kept = pack.historicalContext.map((h) => h.shortHash);
      if (top.every((h) => kept.includes(h))) continue;
      shedAny = true;
      const diffedBelow = pack.historicalContext.filter((h) => !top.includes(h.shortHash) && h.changes?.length);
      expect({ maxTokens, diffedBelow: diffedBelow.map((h) => h.shortHash) }).toEqual({ maxTokens, diffedBelow: [] });
    }
    expect(shedAny).toBe(true); // the sweep reaches budgets that shed the top
  }, 60_000);
});

describe('history ranking contract: what a commit says', () => {
  const candidate = (over: Partial<HistoryCandidate>): HistoryCandidate => ({
    hash: 'aaaa', authoredAt: 0, anchorFiles: ['a.ts'], relatedFiles: [], indirectFiles: [],
    relation: 'DIRECT_TARGET', explicitHits: 1, symbolHits: 0, wordHits: 0, revertChain: 0,
    lineHits: 0, structuralRole: 0, ...over,
  });

  it('the request\'s words outrank touching more of the target', () => {
    const wide = candidate({ hash: 'wide', anchorFiles: ['a.ts', 'b.ts', 'c.ts'], structuralRole: 2 });
    const worded = candidate({ hash: 'worded', wordHits: 1 });
    expect([wide, worded].sort(compareHistoryCandidates)[0]!.hash).toBe('worded');
  });

  it('a revert chain outranks a commit that only touched the target', () => {
    const plain = candidate({ hash: 'plain', authoredAt: 9 });
    const reverted = candidate({ hash: 'reverted', revertChain: 1, authoredAt: 1 });
    expect([plain, reverted].sort(compareHistoryCandidates)[0]!.hash).toBe('reverted');
  });

  it('neither crosses a named target', () => {
    const named = candidate({ hash: 'named', explicitHits: 2 });
    const worded = candidate({ hash: 'worded', explicitHits: 1, wordHits: 3, revertChain: 1 });
    expect([worded, named].sort(compareHistoryCandidates)[0]!.hash).toBe('named');
  });
});
