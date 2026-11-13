import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';

/**
 * A request that names behaviour and no file.
 *
 * Each anchored on a product word that spells a file or a symbol: `DevTools.js` on
 * "DevTools", `bin/prettier.js` on "Prettier", `request/cookies.ts` on "cookies". The
 * fixture has a panel component named for the product, and the file the description is
 * about, which shares none of its words with a filename.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-describe-'));
const repo = path.join(base, 'repo');
const saved = { ...process.env };
let svc: StrataService;

const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, 'utf-8');
};

const PANEL = 'src/views/DevTools.ts';
const BACKEND = 'src/backend/measure.ts';
const DESCRIPTION = 'When the DevTools panel shows a boundary that is suspended on its fallback, the boundary keeps '
  + 'the rectangle of its hidden content instead of disappearing from the timeline. How did this come about?';

beforeAll(() => {
  const globalConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(globalConfig, '', 'utf-8');
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  fs.mkdirSync(repo, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');

  write(PANEL, [
    'export function DevTools(props: { tabs: string[] }): string {',
    '  return props.tabs.join(" | ");',
    '}',
    '',
  ].join('\n'));
  write(BACKEND, [
    'export interface BoundaryRectangle { x: number; y: number; width: number; height: number }',
    '',
    '// A suspended boundary shows its fallback; keep the rectangle of the hidden content.',
    'export function measureBoundary(suspended: boolean, fallbackRect: BoundaryRectangle | null,',
    '                                previousRect: BoundaryRectangle | null): BoundaryRectangle | null {',
    '  if (suspended) return previousRect;',
    '  return fallbackRect;',
    '}',
    '',
    'export function timelineEntry(rect: BoundaryRectangle | null): string {',
    '  return rect ? `${rect.width}x${rect.height}` : "disappearing";',
    '}',
    '',
  ].join('\n'));
  write('src/util/strings.ts', 'export function joinWords(words: string[]): string {\n  return words.join(" ");\n}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Add the panel and boundary measurement');

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

const files = (q: string): string[] => svc.getContextPack(q).target.files;

describe('a request that describes behaviour', () => {
  it('resolves to the file its words describe, not one a product name spells', () => {
    expect(files(DESCRIPTION)[0]).toBe(BACKEND);
    expect(files(DESCRIPTION)).not.toContain(PANEL);
  });

  it('a short request naming the product still anchors the file it spells', () => {
    expect(files('Where is DevTools defined?')[0]).toBe(PANEL);
  });

  it('a description that writes the name as code still anchors it', () => {
    const asCode = DESCRIPTION.replace('the DevTools panel', 'the `DevTools` panel');
    expect(files(asCode)[0]).toBe(PANEL);
  });
});
