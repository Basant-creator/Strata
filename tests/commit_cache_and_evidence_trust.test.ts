import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { StrataMCPHandler } from '../src/mcp/server.js';

/**
 * Regression tests for two faults found by using Strata on a real project.
 *
 * 1. The commit cache was written by `init` and nothing else. `strata index`, which the
 *    README says to run after changes, rebuilt the file -> commit edges from that cache
 *    without re-reading git, so every commit made after `init` was missing from
 *    histories and packs until someone ran `init` again. The history a user saw for an
 *    edited file then called the change "partly rewritten" without the commit that
 *    rewrote it.
 *
 * 2. Evidence a caller supplied was stored as VERIFIED. The CLI hard-coded the label and
 *    the schema defaulted to it, so evidence typed by a person or sent by an agent over
 *    MCP, which Strata never checked, carried the label reserved for what Strata read
 *    from git or disk itself.
 *
 * Both are tested against a real git repository: the first fault lived between what git
 * holds and what the cache holds, and a seeded cache would agree with whichever code
 * seeded it.
 */
describe('commit cache refresh and evidence trust', () => {
  const repoDir = path.join(process.cwd(), '.test_repo_cache_trust');
  let service: StrataService;

  const write = (rel: string, body: string): void => {
    const abs = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf-8');
  };

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' }).trim();

  const commitHashesFor = (file: string): string[] =>
    service.getHistory(file).timeline.filter((t) => t.type === 'git_commit').map((t) => t.commit!.hash);

  beforeAll(() => {
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(repoDir, { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'user.name', 'Fixture Author');

    write('src/greet.ts', 'export function greet(): string {\n  return "hi";\n}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'Add greet');

    service = new StrataService(repoDir);
    service.init();
    service.indexCode();
  });

  afterAll(() => {
    service?.close();
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- 1. commit cache

  it('1. a commit made after init reaches histories and packs after `index`, without re-running init', () => {
    write('src/greet.ts', 'export function greet(): string {\n  return "hello";\n}\n');
    git('commit', '-q', '-am', 'Make greet say hello to match the spec');
    const head = git('rev-parse', 'HEAD');

    const stats = service.indexCode();

    expect(commitHashesFor('src/greet.ts')).toContain(head);
    const pack = service.getContextPack('src/greet.ts');
    expect(pack.historicalContext.map((h) => h.hash)).toContain(head);
    expect(stats.commitsCached).toBe(2);
    expect(service.getStatus().totalCachedCommits).toBe(2);
  });

  it('2. an amended commit leaves the cache instead of lingering as VERIFIED history', () => {
    const before = git('rev-parse', 'HEAD');
    git('commit', '-q', '--amend', '-m', 'Make greet say hello, as the spec requires');
    const after = git('rev-parse', 'HEAD');
    expect(after).not.toBe(before);

    service.indexCode();

    const hashes = commitHashesFor('src/greet.ts');
    expect(hashes).toContain(after);
    expect(hashes).not.toContain(before);
    expect(service.getStatus().totalCachedCommits).toBe(2);
  });

  it('3. a git read that fails leaves the cache as it was rather than emptying it', () => {
    const cached = service.getStatus().totalCachedCommits;
    expect(cached).toBe(2);

    // Point git at a directory that is not a repository. Hiding `.git` would not do:
    // this fixture sits inside Strata's own checkout, so git would walk up and read
    // Strata's history instead of failing.
    const saved = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = path.join(repoDir, 'no-such-git-dir');
    try {
      const stats = service.indexCode();
      expect(stats.commitsCached).toBe(cached);
    } finally {
      if (saved === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = saved;
    }

    expect(service.getStatus().totalCachedCommits).toBe(cached);
    expect(commitHashesFor('src/greet.ts')).toContain(git('rev-parse', 'HEAD'));
  });

  // ---------------------------------------------------------------- 2. evidence trust

  it('4. evidence a caller supplies without a label is stored as DECLARED', () => {
    const record = service.recordChange({
      title: 'Greeting matches the spec',
      intent: 'The spec says hello',
      intentConfidence: 'DECLARED',
      files: [{ path: 'src/greet.ts', changeType: 'modify' }],
      evidence: [{ type: 'test_run', reference: 'manual check', description: 'printed hello' }],
      result: { status: 'success' },
    });

    const typed = record.evidence.find((e) => e.type === 'test_run')!;
    expect(typed.confidence).toBe('DECLARED');
    expect(service.getRecord(record.id)!.evidence.find((e) => e.type === 'test_run')!.confidence)
      .toBe('DECLARED');
  });

  it('5. a caller cannot label its own evidence VERIFIED; a lower label it chose is kept', () => {
    const record = service.recordChange({
      title: 'Claims with labels',
      intent: 'Check the ceiling on caller-supplied evidence',
      intentConfidence: 'DECLARED',
      files: [{ path: 'src/greet.ts', changeType: 'modify' }],
      evidence: [
        { type: 'git_commit', reference: git('rev-parse', '--short', 'HEAD'), confidence: 'VERIFIED' },
        { type: 'benchmark', reference: 'bench-1', confidence: 'INFERRED' },
      ],
      result: { status: 'success' },
    });

    const byType = new Map(record.evidence.map((e) => [e.type, e.confidence]));
    expect(byType.get('git_commit')).toBe('DECLARED');
    expect(byType.get('benchmark')).toBe('INFERRED');
    expect(record.evidence.some((e) => e.confidence === 'VERIFIED')).toBe(false);
  });

  it('6. the HEAD commit Strata attaches itself stays VERIFIED', () => {
    const record = service.recordChange({
      title: 'No commit evidence supplied',
      intent: 'Strata attaches HEAD on its own',
      intentConfidence: 'DECLARED',
      files: [{ path: 'src/greet.ts', changeType: 'modify' }],
      evidence: [{ type: 'log', reference: 'notes.txt' }],
      result: { status: 'success' },
    });

    const head = record.evidence.find((e) => e.type === 'git_commit')!;
    expect(head.reference).toBe(git('rev-parse', 'HEAD'));
    expect(head.confidence).toBe('VERIFIED');
    expect(record.evidence.find((e) => e.type === 'log')!.confidence).toBe('DECLARED');
  });

  it('7. evidence an agent sends over MCP is DECLARED, even when it claims VERIFIED', async () => {
    const handler = new StrataMCPHandler(repoDir);
    let id: string;
    try {
      const reply = await handler.handleToolCall('strata_record_change', {
        title: 'Recorded by an agent',
        intent: 'An agent reports what it checked',
        files: [{ path: 'src/greet.ts', changeType: 'modify' }],
        evidence: [
          { type: 'test_run', reference: 'npm test', description: 'all green' },
          { type: 'issue', reference: '#12', confidence: 'VERIFIED' },
        ],
        result: { status: 'success' },
      });
      id = /REC-\d+/.exec(reply.content[0]!.text)![0];
    } finally {
      handler.close();
    }

    const stored = service.getRecord(id)!;
    expect(stored.evidence.find((e) => e.type === 'test_run')!.confidence).toBe('DECLARED');
    expect(stored.evidence.find((e) => e.type === 'issue')!.confidence).toBe('DECLARED');
  });
});
