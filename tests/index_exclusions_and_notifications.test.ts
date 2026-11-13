import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { CodeGraph } from '../src/code/graph.js';
import { discoverSourceFiles } from '../src/code/indexer.js';
import { buildPromptContext, isSystemNotification } from '../src/integrations/claude-hook.js';

/**
 * Post-Phase-10 maintenance, found in real use.
 *
 * 1. Claude Code hands background-task notifications to the prompt hook as if they were
 *    prompts; the hook resolved their words and delivered LOW VALUE packs about nothing.
 * 2. The indexer walked the directory with a fixed skip list and ignored the repository's
 *    own ignore rules, indexing local settings, ignored generated code and worktree copies.
 *
 * Every repository here is a fresh temporary one outside the Strata tree, and Git's global
 * and system configuration are replaced for the duration, so nothing reads the user's own.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-maint-'));
const repo = path.join(base, 'repo');
const savedEnv = { ...process.env };

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' });
const write = (rel: string, text: string, root = repo): void => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf-8');
};

beforeAll(() => {
  // An isolated global configuration whose excludes file is part of the fixture.
  const globalIgnore = path.join(base, 'global-ignore');
  fs.writeFileSync(globalIgnore, 'global-excluded.ts\n', 'utf-8');
  const globalConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(globalConfig, `[core]\n\texcludesFile = ${globalIgnore.replace(/\\/g, '/')}\n`, 'utf-8');
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';

  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'fixture@example.com']);
  git(repo, ['config', 'user.name', 'Fixture']);
  git(repo, ['config', 'core.autocrlf', 'false']);

  write('.gitignore', [
    'ignored.ts', 'scratch/', 'generated/*', '!generated/keep.ts', '.claude/settings.local.json', '',
  ].join('\n'));
  write('src/tracked.ts', 'export function trackedThing(): number {\n  return 1;\n}\n');
  write('src/deleted.ts', 'export const DELETED = 1;\n');
  write('src/feature/.gitignore', 'local/\n');
  write('src/build/compile.ts', 'export const COMPILE = 1;\n');              // tracked source in a "build" dir
  write('vendor/lib.ts', 'export const LIB = 1;\n');                         // tracked third-party code
  write('node_modules/dep/index.js', 'export const DEP = 1;\n');             // tracked package
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'tracked files']);
  fs.rmSync(path.join(repo, 'src/deleted.ts')); // tracked, then deleted from the working tree

  write('src/untracked.ts', 'export function untrackedThing(): number {\n  return 2;\n}\n');
  write('src/feature/ok.ts', 'export const OK = 1;\n');
  write('src/feature/local/private.ts', 'export const PRIVATE = 1;\n');      // nested .gitignore
  write('src/scratch/tmp.ts', 'export const TMP = 1;\n');                    // nested ignored directory
  write('ignored.ts', 'export const IGNORED = 1;\n');                        // .gitignore
  write('generated/out.ts', 'export const OUT = 1;\n');                      // ignored by generated/*
  write('generated/keep.ts', 'export const KEEP = 1;\n');                    // re-included by a negation
  write('info-excluded.ts', 'export const INFO = 1;\n');                     // .git/info/exclude
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\ninfo-excluded.ts\n', 'utf-8');
  write('global-excluded.ts', 'export const GLOBAL = 1;\n');                 // global excludes file
  write('.claude/settings.local.json', '{ "local": true }\n');               // ignored local settings
  write('dist/built.js', 'export const BUILT = 1;\n');                       // untracked, not ignored: a build dir
  write('src/build/emitted.ts', 'export const EMITTED = 1;\n');              // untracked beside tracked source
  // A worktree checked out inside the repository, not ignored: Git lists it as one
  // directory entry and never lists its files.
  git(repo, ['worktree', 'add', '-q', path.join(repo, '.claude', 'worktrees', 'wt1').replace(/\\/g, '/'), '-b', 'wt1']);
}, 120_000);

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(base, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fix 2: git-aware discovery

describe('indexing honours the repository\'s Git ignore rules', () => {
  const listed = (): string[] => discoverSourceFiles(repo);

  it('1. a tracked source file is indexed', () => {
    expect(listed()).toContain('src/tracked.ts');
  });

  it('2. an untracked, non-ignored source file is indexed', () => {
    expect(listed()).toEqual(expect.arrayContaining(['src/untracked.ts', 'src/feature/ok.ts']));
  });

  it('3. a .gitignored file is excluded', () => {
    expect(listed()).not.toContain('ignored.ts');
    expect(listed()).not.toContain('.claude/settings.local.json');
  });

  it('4. a nested ignored directory is excluded, by a root rule and by a nested .gitignore', () => {
    expect(listed()).not.toContain('src/scratch/tmp.ts');
    expect(listed()).not.toContain('src/feature/local/private.ts');
  });

  it('5. a file excluded by .git/info/exclude is excluded', () => {
    expect(listed()).not.toContain('info-excluded.ts');
  });

  it('6. a file excluded by the configured global excludes file is excluded', () => {
    expect(listed()).not.toContain('global-excluded.ts');
  });

  it('7. a negated rule makes an otherwise ignored file indexable', () => {
    expect(listed()).toContain('generated/keep.ts');
    expect(listed()).not.toContain('generated/out.ts');
  });

  it('7a. a tracked file in a directory named like build output is indexed; an untracked one is not', () => {
    expect(listed()).toContain('src/build/compile.ts');
    expect(listed()).not.toContain('src/build/emitted.ts');
    expect(listed()).not.toContain('dist/built.js');
  });

  it('7b. third-party code is not indexed even when tracked', () => {
    expect(listed()).not.toContain('vendor/lib.ts');
    expect(listed()).not.toContain('node_modules/dep/index.js');
  });

  it('the whole list: exact, sorted, repository-relative, with no worktree copy, deleted file or build output', () => {
    expect(listed()).toEqual([
      'generated/keep.ts', 'src/build/compile.ts', 'src/feature/ok.ts', 'src/tracked.ts', 'src/untracked.ts',
    ]);
  });

  it('8. from a subdirectory, paths are relative to it and the root\'s rules still apply', () => {
    expect(discoverSourceFiles(path.join(repo, 'src'))).toEqual(['build/compile.ts', 'feature/ok.ts', 'tracked.ts', 'untracked.ts']);
    expect(discoverSourceFiles(path.join(repo, 'src', 'feature'))).toEqual(['ok.ts']);
  });

  it('a symlink is not followed', () => {
    const link = path.join(repo, 'src', 'link.ts');
    try {
      fs.symlinkSync(path.join(repo, 'src', 'tracked.ts'), link);
    } catch {
      return; // creating symlinks needs a privilege this machine may not grant
    }
    try {
      expect(listed()).not.toContain('src/link.ts');
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it('9. a Git listing failure inside a repository is reported, not replaced by a directory walk', () => {
    const broken = path.join(base, 'broken');
    fs.mkdirSync(broken, { recursive: true });
    git(broken, ['init', '-q']);
    write('src/a.ts', 'export const A = 1;\n', broken);
    write('.gitignore', 'secret.ts\n', broken);
    write('secret.ts', 'export const SECRET = 1;\n', broken);
    fs.writeFileSync(path.join(broken, '.git', 'index'), 'garbage', 'utf-8'); // ls-files now fails
    expect(() => discoverSourceFiles(broken)).toThrow(/git ls-files` failed/);

    const svc = new StrataService(broken);
    try {
      svc.init();
      expect(() => svc.indexCode()).toThrow(/does not fall back to walking the directory/);
    } finally {
      svc.close();
    }
  });

  it('10. outside any Git work tree the directory walk still works', () => {
    const plain = path.join(base, 'plain', 'project');
    write('src/a.ts', 'export const A = 1;\n', plain);
    write('node_modules/dep/index.js', 'export const DEP = 1;\n', plain);
    write('notes.md', '# not indexed\n', plain);
    // Git must not find a repository above the fixture, whatever the machine's temp directory is in.
    process.env['GIT_CEILING_DIRECTORIES'] = path.dirname(plain);
    try {
      expect(discoverSourceFiles(plain)).toEqual(['src/a.ts']);
    } finally {
      delete process.env['GIT_CEILING_DIRECTORIES'];
    }
  });

  it('11. indexing, explicit paths, symbols and context retrieval work over the listed files', () => {
    const svc = new StrataService(repo);
    try {
      svc.init();
      const stats = svc.indexCode();
      expect(stats.filesScanned).toBe(5);
      // An ignored file is not in the index; a request naming it says so.
      expect(svc.getContextPack('ignored.ts').targetNotFound).toBe(true);
      // An untracked, non-ignored file resolves by path and by symbol.
      const byPath = svc.getContextPack('src/untracked.ts');
      expect(byPath.target.anchors?.[0]).toMatchObject({ file: 'src/untracked.ts', kind: 'explicit_path' });
      const bySymbol = svc.getContextPack('Where is untrackedThing defined?');
      expect(bySymbol.target.anchors?.[0]).toMatchObject({ file: 'src/untracked.ts', kind: 'explicit_symbol' });
      expect(bySymbol.currentBehavior.map((b) => b.file)).toContain('src/untracked.ts');
      // A tracked file still carries its history.
      expect(svc.getContextPack('src/tracked.ts').historicalContext.length).toBeGreaterThan(0);
      // A tracked file under a "build" directory resolves by the path a request names.
      expect(svc.getContextPack('src/build/compile.ts').target.anchors?.[0])
        .toMatchObject({ file: 'src/build/compile.ts', kind: 'explicit_path' });
    } finally {
      svc.close();
    }
  });

  it('12. a refresh from Git\'s changes applies the same rule: a tracked edit there is read, a new untracked file is not', () => {
    const svc = new StrataService(repo);
    try {
      svc.init();
      svc.indexCode();
      write('src/build/compile.ts', 'export const COMPILE = 2;\nexport function compileAgain(): number {\n  return 2;\n}\n');
      write('src/build/later.ts', 'export const LATER = 1;\n');
      const stats = svc.indexCode({ trustFileTimes: true });
      expect(stats.filesIndexed).toBe(1);
      expect(svc.getContextPack('Where is compileAgain defined?').target.anchors?.[0])
        .toMatchObject({ file: 'src/build/compile.ts', kind: 'explicit_symbol' });
      expect(svc.getContextPack('src/build/later.ts').targetNotFound).toBe(true);
    } finally {
      git(repo, ['checkout', '--', 'src/build/compile.ts']);
      fs.rmSync(path.join(repo, 'src/build/later.ts'), { force: true });
      svc.close();
    }
  });
});

// ------------------------------------------------------------------ fix 1: system notifications

describe('the prompt hook skips Claude Code system notifications', () => {
  const NOTIFICATION = [
    '<task-notification>',
    '<task-id>b2x3kc86b</task-id>',
    '<status>completed</status>',
    '<summary>Background command "Run the tests" completed (exit code 0)</summary>',
    '</task-notification>',
  ].join('\n');

  afterEach(() => vi.restoreAllMocks());

  it('recognises the tag only at the start of the prompt', () => {
    expect(isSystemNotification(NOTIFICATION)).toBe(true);
    expect(isSystemNotification('  \n\t' + NOTIFICATION)).toBe(true);
    expect(isSystemNotification('<task-notification id="x">\n...</task-notification>')).toBe(true);
    expect(isSystemNotification('Why does src/tracked.ts return 1? <task-notification>')).toBe(false);
    expect(isSystemNotification('<task-notifications>not the tag</task-notifications>')).toBe(false);
    expect(isSystemNotification('task-notification')).toBe(false);
  });

  it('a subagent report handed back to the session is a notification too', () => {
    const REPORT = '<agent-message from="a8497b6356775fe1e">\n[Subagent hand-back] I graded all six answers …\n</agent-message>';
    expect(isSystemNotification(REPORT)).toBe(true);
    expect(isSystemNotification('\n ' + REPORT)).toBe(true);
    expect(isSystemNotification('Summarise this: <agent-message from="x">…</agent-message>')).toBe(false);
    expect(isSystemNotification('<agent-messages>not the tag</agent-messages>')).toBe(false);
    const r = buildPromptContext({ prompt: REPORT, cwd: repo });
    expect(r.output).toBeNull();
    expect(r.decision).toBe('skipped-system-notification');
  });

  it('a notification gets no context, and nothing is resolved, refreshed or built for it', () => {
    const svc = new StrataService(repo);
    svc.init();
    svc.close();
    const pack = vi.spyOn(StrataService.prototype, 'getContextPack');
    const index = vi.spyOn(StrataService.prototype, 'indexCode');
    const resolve = vi.spyOn(CodeGraph.prototype, 'resolveTarget');
    for (const prompt of [NOTIFICATION, '\n   ' + NOTIFICATION]) {
      const r = buildPromptContext({ prompt, cwd: repo });
      expect(r.output).toBeNull();
      expect(r.decision).toBe('skipped-system-notification');
    }
    expect(pack).not.toHaveBeenCalled();
    expect(index).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('an ordinary prompt is unchanged: resolved, built and delivered as before', () => {
    const pack = vi.spyOn(StrataService.prototype, 'getContextPack');
    const r = buildPromptContext({ prompt: 'Why does src/tracked.ts return 1?', cwd: repo, session_id: 's' });
    expect(r.decision).toBe('delivered');
    expect(r.output!.hookSpecificOutput.additionalContext).toContain('# STRATA CONTEXT');
    expect(r.targets).toEqual(['src/tracked.ts']);
    expect(pack).toHaveBeenCalled();
  });

  it('a prompt that mentions the tag later is not skipped', () => {
    const r = buildPromptContext({
      prompt: 'In src/tracked.ts, should we ignore prompts that start with <task-notification>?', cwd: repo,
    });
    expect(r.decision).toBe('delivered');
    expect(r.targets).toEqual(['src/tracked.ts']);
  });

  it('existing no-target handling is unchanged', () => {
    const r = buildPromptContext({ prompt: 'quantum flux capacitor zeppelin', cwd: repo });
    expect(r.decision).toBe('skipped-no-target');
    expect(r.output).toBeNull();
  });
});
