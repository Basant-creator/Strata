import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { isCodeShaped } from '../src/code/graph.js';
import { extractReferences } from '../src/code/references.js';

/**
 * Questions that name their subject by its form.
 *
 * The fixture reproduces each in miniature.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-form-'));
const repo = path.join(base, 'repo');
const saved = { ...process.env };
let svc: StrataService;

const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, 'utf-8');
};

beforeAll(() => {
  const globalConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(globalConfig, '', 'utf-8');
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'core.autocrlf', 'false']);

  write('src/client/forbidden.ts', 'export function forbidden(): never {\n  throw new Error("403");\n}\n');
  write('src/client/unauthorized.ts', 'export function unauthorized(): never {\n  throw new Error("401");\n}\n');
  // Plain words that are also exported names, in unrelated files.
  write('test/cache/state.ts', 'export const state = { hits: 0 };\n');
  write('test/fixtures/thenable.ts', 'export function then(resolve: (v: number) => void): void {\n  resolve(1);\n}\n');
  write('types/React.d.ts', 'export declare const version: string;\n');
  write('tools/snap/compiler.ts', 'export function runCompiler(): void {}\n');
  // The files a question names by path.
  write('compiler/src/codegen/CodegenFunction.ts', 'export function codegenFunction(): void {}\n');
  // A precompiled bundle full of the words a request's instructions use.
  write('src/compiled/react-dom/cjs/react-dom.production.js', [
    'function installDependencies() {}', 'function runBuild() {}', 'function runTestSuite() {}',
    'function editFiles() {}', 'function explainHistory() {}', 'function commitHash() {}',
    'module.exports = { installDependencies, runBuild, runTestSuite, editFiles, explainHistory, commitHash };', '',
  ].join('\n'));
  write('src/server/router.ts', 'export function routeRequest(path: string): string {\n  return path;\n}\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Fixture']);

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

const target = (query: string) => svc.getContextPack(query).target;

describe('a name written as a call', () => {
  it('is read as the name, with or without backticks', () => {
    expect(extractReferences('`forbidden()` and `unauthorized()` still need it').map((r) => r.text))
      .toEqual(expect.arrayContaining(['forbidden', 'unauthorized']));
    expect(extractReferences('why does notFound(x) throw').map((r) => r.text)).toContain('notFound');
  });

  it('is code-shaped, and a word merely followed by a bracketed aside is not', () => {
    expect(isCodeShaped('forbidden', '`forbidden()` still needs')).toBe(true);
    expect(isCodeShaped('forbidden', 'calls forbidden() first')).toBe(true);
    expect(isCodeShaped('forbidden', 'is forbidden (see below)')).toBe(false);
    expect(isCodeShaped('state', 'in this state')).toBe(false);
  });

  it('anchors its file, and a plain word beside it does not', () => {
    const t = target('`forbidden()` and `unauthorized()` still need the experimental flag. How did they come to be in this state?');
    expect(t.files).toEqual(expect.arrayContaining(['src/client/forbidden.ts', 'src/client/unauthorized.ts']));
    expect(t.files).not.toContain('test/cache/state.ts');
    expect(t.confidence.level).toBe('HIGH');
  });
});

describe('a path named in a sentence', () => {
  it('leads, and filenames spelled by the sentence around it do not anchor', () => {
    const t = target('In the React Compiler, `compiler/src/codegen/CodegenFunction.ts` gives nodes locations, and checks them. How did this come about?');
    expect(t.files[0]).toBe('compiler/src/codegen/CodegenFunction.ts');
    expect(t.files).not.toContain('types/React.d.ts');
  });
});

describe('a stopword', () => {
  it('never anchors as a symbol, however many files export it', () => {
    const t = target('how does the server route a request and then render it');
    expect(t.files).not.toContain('test/fixtures/thenable.ts');
  });
});

describe('vendored and generated code', () => {
  it('is never a word match', () => {
    const t = target('Do not edit any files, do not install dependencies, and do not run the build or the test suite. Explain the history and cite the commit hash for every claim.');
    expect(t.files).not.toContain('src/compiled/react-dom/cjs/react-dom.production.js');
  });

  it('still resolves when named by its path', () => {
    expect(target('what is in src/compiled/react-dom/cjs/react-dom.production.js').files)
      .toContain('src/compiled/react-dom/cjs/react-dom.production.js');
  });
});
