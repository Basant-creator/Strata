import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { GitClient } from '../src/git/git.js';

/**
 * The origin of a file in a shallow clone.
 *
 * A shallow history starts at a commit that holds every file older than it, so the oldest
 * commit touching such a file is that first commit, which created none of them.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-shallow-'));
const full = path.join(base, 'full');
const repo = path.join(base, 'shallow');
const saved = { ...process.env };
let svc: StrataService;
const sha: Record<string, string> = {};

let clock = Date.parse('2026-01-01T00:00:00Z') / 1000;
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' });
const commit = (tag: string, message: string): void => {
  git(full, 'add', '-A');
  const at = `${clock += 3600} +0000`;
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: full, env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
  sha[tag] = git(full, 'rev-parse', 'HEAD').trim();
};
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(full, rel)), { recursive: true });
  fs.writeFileSync(path.join(full, rel), text, 'utf-8');
};

beforeAll(() => {
  const globalConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(globalConfig, '[protocol "file"]\n\tallow = always\n', 'utf-8');
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  fs.mkdirSync(full, { recursive: true });
  git(full, 'init', '-q');
  git(full, 'config', 'user.email', 'fixture@example.com');
  git(full, 'config', 'user.name', 'Fixture');
  git(full, 'config', 'core.autocrlf', 'false');

  write('src/old.ts', 'export function oldRule(): number {\n  return 1;\n}\n');
  commit('oldCreated', 'Add the old rule');
  write('src/other.ts', 'export const other = 1;\n');
  commit('before', 'Unrelated work before the cut');
  write('src/old.ts', 'export function oldRule(): number {\n  return 2;\n}\n');
  commit('root', 'Change the old rule');
  write('src/new.ts', 'export function newRule(): number {\n  return 3;\n}\n');
  commit('newCreated', 'Add the new rule');
  write('src/other.ts', 'export const other = 2;\n');
  commit('tip', 'Unrelated work after');

  // The last three commits: `root` is the first one the clone has.
  execFileSync('git', ['clone', '-q', '--depth', '3', `file://${full.replace(/\\/g, '/')}`, repo]);
  git(repo, 'config', 'user.email', 'fixture@example.com');
  git(repo, 'config', 'user.name', 'Fixture');
  svc = new StrataService(repo);
  svc.init();
  svc.indexCode();
}, 120_000);

afterAll(() => {
  svc?.close();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(base, { recursive: true, force: true });
});

const origin = (file: string): string[] =>
  svc.getContextPack(`How did ${file} come about?`).historicalContext
    .filter((h) => h.introducedAnchor).map((h) => h.shortHash);

describe('a shallow clone', () => {
  it('GitClient.shallowRoots names its first commit, and is empty for a full history', () => {
    expect([...new GitClient(repo).shallowRoots()]).toEqual([sha['root']]);
    expect(new GitClient(full).shallowRoots().size).toBe(0);
  });

  it('does not call its first commit the origin of a file older than the history', () => {
    expect(origin('src/old.ts')).toEqual([]);
  });

  it('still names the origin of a file created inside the history', () => {
    expect(origin('src/new.ts')).toEqual([sha['newCreated']!.slice(0, 7)]);
  });
});
