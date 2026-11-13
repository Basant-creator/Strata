import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitClient } from '../src/git/git.js';

/**
 * Regression tests for commit parsing.
 *
 * These exist because `getCommits` shipped for months storing commit *prose* in
 * `changedFiles`. Two faults compounded: the record separator trailed the format, so
 * `--name-only` output landed in the following record and was discarded, and with the
 * file list gone a heuristic decided where the message ended by asking whether a line
 * "looked like a path" — which any sentence containing a slash does.
 *
 * Every test below is written against a **real** git repository rather than a captured
 * string. The bug lived in the seam between what git prints and what the parser expects,
 * and a fixture string is authored from the same misunderstanding that caused the bug, so
 * it would have agreed with the broken parser and passed.
 */
describe('GitClient.getCommits — changed-file parsing', () => {
  const repoDir = path.join(process.cwd(), '.test_repo_gitcommits');
  let client: GitClient;

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' });

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

    // 1. Root commit. No parent, so a naive diff against a parent finds nothing.
    write('src/alpha.ts', 'export const alpha = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'Root commit adding alpha');

    // 2. The commit that reproduces the original corruption: a body full of slashes and
    //    file-extension-shaped words, none of which are paths.
    write('src/beta.ts', 'export const beta = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', [
      'Rework the sequencing pass',
      '',
      'The engine reads src/ and writes to dist/ during the build, and the',
      'ratio of hits/misses moved from 0.4 to 0.9 after the change.',
      'See docs/DESIGN.md for the rationale and notes.txt for measurements.',
    ].join('\n'));

    // 3. Multi-file commit, including a nested path.
    write('src/gamma.ts', 'export const gamma = 3;\n');
    write('src/nested/deep/delta.ts', 'export const delta = 4;\n');
    write('README.md', '# fixture\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'Add gamma, delta and a readme');

    // 4. A merge, so first-parent behaviour has something to be correct about.
    git('checkout', '-q', '-b', 'side');
    write('src/side.ts', 'export const side = 5;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'Side branch work');
    git('checkout', '-q', 'master');
    // The default branch name varies by git config; resolve it rather than assume.
    git('merge', '-q', '--no-ff', 'side', '-m', 'Merge side into trunk');

    client = new GitClient(repoDir);
  });

  afterAll(() => {
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  const bySubject = (subject: string) => {
    const found = client.getCommits(50).find((c) => c.message.startsWith(subject));
    if (!found) throw new Error(`no commit whose message starts with ${subject!}`);
    return found;
  };

  it('1. does not treat message prose containing "/" as a changed path', () => {
    const c = bySubject('Rework the sequencing pass');
    // The original parser stored every one of these as a file path.
    for (const prose of ['src/ and writes to dist/', 'hits/misses', 'docs/DESIGN.md for the rationale']) {
      expect(c.changedFiles.some((f) => f.includes(prose))).toBe(false);
    }
    expect(c.changedFiles).toEqual(['src/beta.ts']);
  });

  it('2. does not leak one commit\'s file list into another', () => {
    const commits = client.getCommits(50);
    const root = commits.find((c) => c.message.startsWith('Root commit'))!;
    const multi = commits.find((c) => c.message.startsWith('Add gamma'))!;

    expect(root.changedFiles).toEqual(['src/alpha.ts']);
    // The trailing-separator bug put each commit's files into the *next* record.
    expect(root.changedFiles).not.toContain('src/beta.ts');
    expect(multi.changedFiles).not.toContain('src/beta.ts');
    expect(multi.changedFiles).not.toContain('src/alpha.ts');
  });

  it('3. still parses real paths containing "/" correctly', () => {
    const c = bySubject('Add gamma');
    expect(c.changedFiles).toContain('src/gamma.ts');
    expect(c.changedFiles).toContain('src/nested/deep/delta.ts');
  });

  it('4. handles the root commit, which has no parent', () => {
    const c = bySubject('Root commit');
    expect(c.changedFiles).toEqual(['src/alpha.ts']);
    expect(c.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('5. handles a commit touching several files', () => {
    const c = bySubject('Add gamma');
    expect(c.changedFiles).toHaveLength(3);
    expect(new Set(c.changedFiles)).toEqual(
      new Set(['src/gamma.ts', 'src/nested/deep/delta.ts', 'README.md']),
    );
  });

  it('6. keeps the message and the changed-file list separate', () => {
    const c = bySubject('Rework the sequencing pass');
    expect(c.message).toContain('hits/misses moved from 0.4 to 0.9');
    expect(c.message).toContain('See docs/DESIGN.md');
    // The body must not have absorbed the file list, nor the reverse.
    expect(c.message).not.toContain('src/beta.ts');
    for (const f of c.changedFiles) {
      expect(c.message.includes(f)).toBe(false);
    }
  });

  it('7. reports a merge commit without inventing files for it', () => {
    const c = bySubject('Merge side into trunk');
    // `git log --name-only` prints no file list for a merge unless asked with -m or
    // --first-parent. The contract is that the parser reports what git reports and does
    // not fabricate: an empty list here is correct, prose is not.
    expect(Array.isArray(c.changedFiles)).toBe(true);
    for (const f of c.changedFiles) {
      expect(f).not.toContain(' ');       // no sentence fragments
      expect(f).not.toMatch(/^Merge /);   // not the subject line
    }
  });

  it('8. parses author, committer and timestamps alongside the files', () => {
    const c = bySubject('Root commit');
    expect(c.authorName).toBe('Fixture Author');
    expect(c.authorEmail).toBe('fixture@example.com');
    expect(c.committerName).toBe('Fixture Author');
    expect(typeof c.authoredAt).toBe('number');
    expect(c.authoredAt).toBeGreaterThan(0);
    expect(c.shortHash.length).toBeGreaterThanOrEqual(7);
  });

  it('9. every indexed path corresponds to a file git actually reports', () => {
    // The strongest form of the regression: cross-check the whole index against git.
    for (const c of client.getCommits(50)) {
      const raw = execFileSync(
        'git',
        ['show', '--pretty=format:', '--name-only', c.hash],
        { cwd: repoDir, encoding: 'utf-8' },
      );
      const truth = new Set(raw.split('\n').map((l) => l.trim()).filter(Boolean));
      for (const f of c.changedFiles) {
        expect(truth.has(f)).toBe(true);
      }
    }
  });
});
