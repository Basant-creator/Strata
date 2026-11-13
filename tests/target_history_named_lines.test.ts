import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { GitClient } from '../src/git/git.js';
import { codeTerms } from '../src/context/engine.js';

/**
 * The commit that wrote the code a question names, under many later commits to the file.
 *
 * Its subject used none of the question's words, and neither end of the file's history was
 * it, so nothing ranked it into the pack. The question names the code, though, and
 * `git blame` on those lines names the commit.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-named-'));
const repo = path.join(base, 'repo');
const saved = { ...process.env };
const sha: Record<string, string> = {};
let svc: StrataService;

let clock = Date.parse('2026-01-01T00:00:00Z') / 1000;
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
const dated = (...args: string[]): string => {
  const at = `${clock += 3600} +0000`;
  return execFileSync('git', args, {
    cwd: repo, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
};
const commit = (tag: string, message: string): void => {
  git('add', '-A');
  dated('commit', '-q', '-m', message);
  sha[tag] = git('rev-parse', 'HEAD').trim();
};
const short = (tag: string): string => sha[tag]!.slice(0, 7);

const FILE = 'src/parse/options.ts';
const parts: string[] = ['export const baseOptions = { plugins: [] as string[] };', ''];
const save = (): void => {
  fs.mkdirSync(path.dirname(path.join(repo, FILE)), { recursive: true });
  fs.writeFileSync(path.join(repo, FILE), parts.join('\n') + '\n', 'utf-8');
};

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

  save();
  commit('created', 'Add parser options');
  parts.push(
    'export const appendPlugins = (plugins: string[], options = baseOptions) => ({',
    '  ...options,',
    '  plugins: [...options.plugins, ...plugins],',
    '});',
    '',
  );
  save();
  commit('change', 'Stop mutating shared options\n\nTwo parses in a row shared one plugin array and the second saw the first one\'s plugins.');
  for (let i = 1; i <= 12; i++) {
    parts.push(`export const flag${i} = ${i};`);
    save();
    commit(`later${i}`, `Tune flag ${i}`);
  }

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

describe('codeTerms', () => {
  it('takes names that can only be code, and leaves paths out', () => {
    expect(codeTerms('In `src/parse/options.ts`, why is `appendPlugins` used with __NEXT_FLAG_NAME?'))
      .toEqual(['appendPlugins', '__NEXT_FLAG_NAME']);
    expect(codeTerms('Why does the parser copy its options?')).toEqual([]);
  });
});

describe('GitClient', () => {
  it('blameLines names the commit that wrote each line', () => {
    const lines = fs.readFileSync(path.join(repo, FILE), 'utf-8').split('\n');
    const at = lines.findIndex((l) => l.includes('appendPlugins')) + 1;
    expect([...new GitClient(repo).blameLines(FILE, [at, at + 2])]).toEqual([[sha['change'], 2]]);
  });

  it('getTargetHistory reads a commit asked for by hash, past the limit', () => {
    const { commits } = new GitClient(repo).getTargetHistory([FILE], 2, new Set([sha['change']!]));
    expect(commits.map((c) => c.hash)).toEqual([sha['later12'], sha['later11'], sha['change'], sha['created']]);
  });
});

describe('a pack about code the question names', () => {
  it('ranks the commit that wrote it among the first, and leads with its decision', () => {
    const pack = svc.getContextPack(`In ${FILE}, extra plugins are added through \`appendPlugins\`. How did this come about?`);
    const marked = pack.historicalContext.filter((h) => h.matchesRequest).map((h) => h.shortHash);
    expect(marked).toContain(short('change'));
    expect(pack.historicalDecisions[0]?.commit).toBe(short('change'));
  });

  it('without a name, the buried commit is just one of many', () => {
    const pack = svc.getContextPack(`In ${FILE}, how did the options come about?`);
    expect(pack.historicalContext.filter((h) => h.matchesRequest)).toEqual([]);
  });
});
