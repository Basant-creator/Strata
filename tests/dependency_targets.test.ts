import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { dependencySymbols } from '../src/code/indexer.js';

/**
 * A request about a package resolves to the manifest that declares it.
 *
 * Found on a real project: "Upgrade phaser to the latest version" resolved, at LOW
 * confidence, to the four source files that import Phaser, and the record saying Phaser
 * must stay on 3.x, which is about `package.json`, never reached the pack. The manifest
 * was indexed by path only, so the word had nothing in it to match.
 *
 * Package names are often plain words ("react", "next", "express"), so the other half of
 * these tests is what must *not* happen: a request that uses the word as English, or is
 * about code, keeps resolving exactly as it did.
 */
describe('dependencySymbols', () => {
  const manifest = [
    '{',                                  // 1
    '  "name": "demo",',                  // 2
    '  "dependencies": {',                // 3
    '    "phaser": "^3.90.0",',           // 4
    '    "react": "^19.0.0"',             // 5
    '  },',                               // 6
    '  "devDependencies": {',             // 7
    '    "@types/node": "^22.0.0",',      // 8
    '    "react": "^19.0.0"',             // 9
    '  },',                               // 10
    '  "peerDependencies": { "vite": "^8.0.0" }', // 11
    '}',                                  // 12
  ].join('\n');

  it('declares one dependency symbol per package, on the line of its key', () => {
    const syms = dependencySymbols('package.json', manifest);
    expect(syms.map((s) => [s.name, s.startLine])).toEqual([
      ['phaser', 4], ['react', 5], ['@types/node', 8], ['react', 9], ['vite', 11],
    ]);
    expect(syms.every((s) => s.kind === 'dependency' && !s.exported && s.filePath === 'package.json')).toBe(true);
  });

  it('yields nothing for a manifest that does not parse, or is not an object', () => {
    expect(dependencySymbols('package.json', '{ "dependencies": { "phaser": ')).toEqual([]);
    expect(dependencySymbols('package.json', '["phaser"]')).toEqual([]);
  });
});

describe('a request about a package resolves to its manifest', () => {
  const repoDir = path.join(process.cwd(), '.test_repo_dependency_targets');
  let service: StrataService;

  const write = (rel: string, body: string): void => {
    const abs = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf-8');
  };
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' }).trim();
  const target = (query: string) => service.getContextPack(query).target;

  beforeAll(() => {
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(repoDir, { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'user.name', 'Fixture Author');

    write('package.json', JSON.stringify({
      name: 'demo',
      dependencies: { phaser: '^3.90.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
      devDependencies: { '@types/node': '^22.0.0' },
    }, null, 2) + '\n');
    write('src/main.ts', "import Phaser from 'phaser';\nexport const game = new Phaser.Game({});\n");
    write('src/scenes/arena.ts', "import Phaser from 'phaser';\nexport class Arena extends Phaser.Scene {}\n");
    write('src/ui/navbar.ts', 'export function onNavClick(): void {}\nexport const navbarState = { open: false };\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'Set up the project on Phaser 3');

    service = new StrataService(repoDir);
    service.init();
    service.indexCode();
    service.recordChange({
      title: 'Phaser pinned to 3.x',
      intent: 'Build on Phaser 3 as specified',
      files: [{ path: 'package.json', changeType: 'modify' }],
      constraints: [{ statement: 'Keep phaser on ^3.x; npm latest is Phaser 4', confidence: 'DECLARED', status: 'ACTIVE' }],
      result: { status: 'success' },
    });
  });

  afterAll(() => {
    service?.close();
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('1. "upgrade phaser" resolves to package.json, graded MEDIUM, and carries the record', () => {
    const pack = service.getContextPack('Upgrade phaser to the latest version');
    expect(pack.target.files[0]).toBe('package.json');
    expect(pack.target.confidence.level).toBe('MEDIUM');
    expect(pack.target.confidence.reason).toMatch(/a dependency this manifest declares/);
    expect(service.renderContextPack(pack)).toContain('Keep phaser on ^3.x');
  });

  it('2. the pack quotes the declared version from the working tree, as a dependency', () => {
    const pack = service.getContextPack('Upgrade phaser to the latest version');
    const manifest = pack.currentBehavior.find((b) => b.file === 'package.json')!;
    expect(manifest.signatures.map((s) => s.text.trim())).toContain('"phaser": "^3.90.0",');
    expect(manifest.provenance).toBe('VERIFIED');
    const text = service.renderContextPack(pack);
    expect(text).toContain('package.json — ');
    expect(text).toMatch(/declared dependencies:/);
    expect(service.humanView('Upgrade phaser to the latest version', 'explain').text)
      .toMatch(/declared dependencies:/);
  });

  it('3. the package is matched as written: capitalised, hyphenated, scoped', () => {
    expect(target('Bump Phaser to 4').files[0]).toBe('package.json');
    expect(target('which version of react-dom are we on?').files[0]).toBe('package.json');
    expect(target('install @types/node 24').files[0]).toBe('package.json');
  });

  it('4. a package name used as English does not reach the manifest', () => {
    expect(target("why doesn't the navbar react to clicks").files).not.toContain('package.json');
    // "update" is about code far more often than about a version.
    expect(target('update the react state in the navbar').files).not.toContain('package.json');
    expect(target('how does the phaser arena scene start').files).not.toContain('package.json');
  });

  it('5. a request that names a path keeps it as the primary target', () => {
    const t = target('upgrade phaser usage in src/main.ts');
    expect(t.files[0]).toBe('src/main.ts');
    expect(t.confidence.level).toBe('HIGH');
  });

  it('6. a backticked package name resolves without a package word, as any named symbol does', () => {
    expect(target('what does `phaser` give us').files[0]).toBe('package.json');
  });

  it('7. a package every manifest declares is vocabulary: no dependency anchor, only a graded guess', () => {
    for (const app of ['a', 'b', 'c', 'd', 'e']) {
      write(`apps/${app}/package.json`, JSON.stringify({ dependencies: { react: '^19.0.0' } }, null, 2));
    }
    service.indexCode();
    const t = target('upgrade react across the apps');
    // Six manifests declare it, past the fan-out ceiling, so the dependency step stays out.
    // The words still score those manifests lexically, and that guess is labelled LOW.
    expect(t.anchors.some((a) => a.dependency)).toBe(false);
    expect(t.confidence.level).toBe('LOW');
    expect(t.confidence.reason).not.toMatch(/dependency/);
  });
});
