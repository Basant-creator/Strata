/**
 * Code indexing: build the relationship graph the context engine expands over.
 *
 * Scope, deliberately narrow
 * --------------------------
 * TypeScript and JavaScript only, parsed with the TypeScript compiler's own scanner via
 * `ts.createSourceFile`. No type checker, no `tsconfig` resolution, no program graph: a
 * checker would need a resolved compilation for every repository we point at, and would
 * turn indexing from milliseconds into seconds for a gain this engine does not need.
 * Everything below is recoverable from a single file's syntax tree plus the existence of
 * files on disk.
 *
 * The rule that governs what gets stored
 * --------------------------------------
 * A relationship is recorded only when the syntax establishes it. Concretely:
 *
 * * An import edge exists because there is an `ImportDeclaration`. Its *target* is set
 *   only if the specifier resolves to a file that actually exists; otherwise `to_file` is
 *   NULL and the resolution is UNKNOWN. A package import is not a repository edge.
 * * A reference is linked to a defining file only when the name is bound in this file —
 *   by an import, or by a local declaration. A bare identifier that happens to share a
 *   name with a symbol somewhere else is recorded with no target and UNKNOWN confidence.
 *
 * That last rule is the whole difference between a code graph and a plausible-looking
 * one. Two files can both call `normalize` and mean different functions; linking them
 * because the strings match would put a false edge into the context pack, and a false
 * edge is worse than a missing one — it sends the agent to the wrong file with
 * confidence.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import { StrataDatabase } from '../storage/db.js';

/** Directories never indexed, even when Git tracks them: third-party code and tool internals. */
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', '.strata']);

/**
 * Directory names that usually hold generated output. A file under one is skipped unless
 * Git tracks it: a tracked file is code the project committed, and the name alone says
 * nothing — Next.js's build implementation is `packages/next/src/build/`, and skipping it
 * by name left a file a question named outright "not in the index". Untracked files there
 * are still skipped, so build output an incomplete `.gitignore` misses stays out.
 */
const OUTPUT_DIRS = new Set(['dist', 'build', 'out', 'coverage', '.next', '.turbo', '.cache', '__pycache__']);

/**
 * Data and configuration files, registered by path only.
 *
 * Not a step toward a multi-language parser: nothing here is parsed, no symbols are
 * extracted, and no edges are drawn. These files exist in the index so that a query can
 * *name* them. Asked to "understand the dataset transition and which dataset schema the
 * code currently expects", the resolver matched nothing at all for "dataset" or "schema",
 * because the only files carrying those words are `mtg_jamendo_dataset.json` and
 * `schema.prisma` — and a file the index cannot see is a file no query can reach,
 * however well the ranking works.
 *
 * Lockfiles are excluded: they are enormous, machine-authored, and name every package in
 * the tree, so they match almost any term and would be pure noise.
 */
const DATA_EXTENSIONS = new Set([
  '.json', '.prisma', '.sql', '.yaml', '.yml', '.toml', '.csv', '.graphql',
]);

const EXCLUDED_BASENAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'composer.lock',
]);

const EXT_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
};

/** Extension order tried when resolving an extensionless import specifier. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/**
 * How long before a file's content was last confirmed its modification time must be for
 * `trustFileTimes` to skip it. A write landing while the file was being read and stamped
 * leaves the two close together; anything inside this window is hashed instead. Wide
 * enough for coarse filesystem timestamps (FAT keeps two seconds).
 */
const RACY_WINDOW_MS = 2000;

export type SymbolKind =
  | 'function' | 'class' | 'interface' | 'type' | 'enum'
  | 'const' | 'variable' | 'method'
  /** A package a `package.json` declares. Never exported: it is not this code's surface. */
  | 'dependency';

/** The `package.json` sections whose keys are packages this project depends on. */
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * One symbol per package a `package.json` declares, on the line of its key.
 *
 * Without these a request that names a package ("upgrade phaser") had nothing to resolve
 * to: the manifest was indexed by path only, so the request scored the source files that
 * import the package and never reached the file, or the records, about its version. A
 * manifest that does not parse yields nothing and stays a path, as before.
 */
export function dependencySymbols(relPath: string, text: string): IndexedSymbol[] {
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    manifest = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  /** 1-based line of the first `"key":` at or after 1-based line *from*. Not anchored to
   *  the line start: `"peerDependencies": { "vite": "^8" }` is valid on one line. */
  const lineOfKey = (key: string, from: number): number => {
    const pattern = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"\\s*:`);
    for (let i = from - 1; i < lines.length; i++) if (pattern.test(lines[i]!)) return i + 1;
    return from;
  };

  const symbols: IndexedSymbol[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = manifest[section];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    const sectionLine = lineOfKey(section, 1);
    for (const name of Object.keys(entries)) {
      const line = lineOfKey(name, sectionLine);
      symbols.push({ id: symbolId(relPath, name, line), filePath: relPath, name,
                     kind: 'dependency', startLine: line, endLine: line, exported: false });
    }
  }
  return symbols;
}

export interface IndexedSymbol {
  id: string;
  filePath: string;
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface IndexedImport {
  fromFile: string;
  specifier: string;
  toFile: string | null;
  resolution: 'VERIFIED' | 'UNKNOWN';
  line: number;
  /** Local names this import binds, used to resolve references in the same file. */
  bindings: string[];
}

export interface IndexedReference {
  fromFile: string;
  symbolName: string;
  toFile: string | null;
  toSymbolId: string | null;
  line: number;
  kind: 'call' | 'identifier';
  confidence: 'VERIFIED' | 'UNKNOWN';
}

export interface FileAnalysis {
  path: string;
  language: string;
  contentHash: string;
  sizeBytes: number;
  symbols: IndexedSymbol[];
  imports: IndexedImport[];
  references: IndexedReference[];
}

export interface IndexStats {
  filesScanned: number;
  filesIndexed: number;
  filesUnchanged: number;
  filesRemoved: number;
  symbols: number;
  imports: number;
  importsResolved: number;
  references: number;
  referencesResolved: number;
  fileCommitEdges: number;
  durationMs: number;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Whether the indexer would register a file at *relPath*, by the same rules as
 * `discoverSourceFiles`; *tracked* says whether Git tracks it (see `OUTPUT_DIRS`).
 * Read-only: it lets a caller say why a named path is not in the index — a file type the
 * index does not cover, as against a file it has not seen yet.
 */
export function isIndexablePath(relPath: string, tracked = false): boolean {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  const dirs = parts.slice(0, -1);
  if (dirs.some((p) => SKIP_DIRS.has(p))) return false;
  if (!tracked && dirs.some((p) => OUTPUT_DIRS.has(p))) return false;
  const name = parts[parts.length - 1] ?? '';
  if (EXCLUDED_BASENAMES.has(name.toLowerCase())) return false;
  const ext = path.extname(name).toLowerCase();
  return Boolean(EXT_LANGUAGE[ext]) || DATA_EXTENSIONS.has(ext);
}

/**
 * Every indexable source file under *root*, as root-relative POSIX paths, sorted.
 *
 * Inside a Git work tree the list comes from Git, so the repository's own ignore rules
 * decide what is project code: `.gitignore` at every level, `.git/info/exclude`, the
 * configured global excludes file, and negations. Walking the directory with a fixed list
 * of skipped names indexed whatever those rules hide — local settings, ignored generated
 * code, scratch files, and whole copies of the repository under an agent's worktree
 * directory. Re-implementing Git's ignore semantics here would be a second, subtly
 * different answer to a question Git already answers.
 *
 * Outside a Git work tree (or without Git installed) the directory walk is used, as before.
 * Inside one, a listing that fails is an error: falling back to the walk would index
 * exactly the ignored content this exists to keep out, and nobody would be told.
 */
export function discoverSourceFiles(root: string): string[] {
  return discoverWith(root, gitWorkTree(root));
}

function discoverWith(root: string, git: { toplevel: string; prefix: string } | null): string[] {
  return git ? gitListedSourceFiles(root, git) : walkSourceFiles(root);
}

/**
 * HEAD, and every path Git reports as possibly differing from it in the work tree at the
 * top level *root*: tracked files changed (staged or not), deleted, renamed (both paths)
 * or unmerged, and untracked files no ignore rule covers. One `git status`, which answers
 * from its own stat cache. Null when Git cannot answer or HEAD has no commit yet.
 */
function workTreeState(root: string): { head: string; changed: string[]; untracked: Set<string> } | null {
  let out: string;
  try {
    out = execFileSync('git', ['status', '--porcelain=v2', '-z', '--branch', '--no-ahead-behind', '--untracked-files=all'], {
      cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  // Fields before the path, per entry type: ordinary, renamed or copied, unmerged, untracked.
  const FIELDS: Record<string, number> = { '1': 8, '2': 9, u: 10, '?': 1 };
  let head = '';
  const changed: string[] = [];
  const untracked = new Set<string>();
  const entries = out.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.startsWith('# branch.oid ')) head = entry.slice('# branch.oid '.length);
    const fields = FIELDS[entry[0] ?? ''];
    if (fields === undefined || entry[1] !== ' ') continue;
    let at = 0;
    for (let f = 0; f < fields && at !== -1; f++) at = entry.indexOf(' ', at + 1);
    if (at === -1) continue;
    changed.push(entry.slice(at + 1));
    if (entry[0] === '?') untracked.add(entry.slice(at + 1));
    if (entry[0] === '2') changed.push(entries[++i] ?? ''); // the path it was renamed from
  }
  return /^[0-9a-f]{40,64}$/.test(head) ? { head, changed: changed.filter(Boolean), untracked } : null;
}

/**
 * What decides which files a scan registers. A trusting run may reuse the last scan's
 * list only when these are unchanged; a Strata upgrade that indexes more file types must
 * look at every file again.
 */
const SCAN_RULES = crypto.createHash('sha256').update(JSON.stringify([
  [...SKIP_DIRS], [...OUTPUT_DIRS], [...EXCLUDED_BASENAMES], Object.keys(EXT_LANGUAGE), [...DATA_EXTENSIONS],
])).digest('hex').slice(0, 16);

/** `code_index_meta` key: HEAD and scan rules of the last complete scan, `<rules>:<head>`. */
const SCAN_HEAD = 'scan_head';
/** `code_index_meta` key: the paths Git reported as changed at that scan, as JSON. */
const SCAN_CHANGED = 'scan_changed';

/** Git's view of *root*: the work tree's top level and *root*'s prefix inside it, or null. */
function gitWorkTree(root: string): { toplevel: string; prefix: string } | null {
  let out: string;
  try {
    out = execFileSync('git', ['rev-parse', '--show-toplevel', '--show-prefix'], {
      cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // not a work tree, or no Git: the directory walk decides
  }
  const [toplevel, prefix = ''] = out.split(/\r?\n/);
  if (!toplevel) return null;
  return { toplevel, prefix: prefix.trim() };
}

/**
 * The files Git lists for the work tree — tracked, plus untracked files no ignore rule
 * covers — restricted to *root* and to what the indexer registers.
 *
 * Run from the top level with `--full-name`, so every path is relative to it whatever
 * directory *root* is, and NUL-separated, so no path is quoted or split on a newline. A
 * path is kept only if it is a regular file in the working tree now: a tracked file that
 * was deleted, a submodule, and a symlink (which Git lists as a path and the walk never
 * followed) are all left out. Tracked and untracked files are listed apart, since
 * `OUTPUT_DIRS` applies only to the second.
 */
function gitListedSourceFiles(root: string, git: { toplevel: string; prefix: string }): string[] {
  const list = (which: string[]): Buffer => execFileSync('git', ['ls-files', '--full-name', ...which, '-z'], {
    cwd: git.toplevel, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  });
  let tracked: Buffer;
  let untracked: Buffer;
  try {
    tracked = list(['--cached']);
    untracked = list(['--others', '--exclude-standard']);
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const detail = (stderr ? String(stderr) : err instanceof Error ? err.message : String(err)).trim();
    throw new Error(`Indexing stopped: \`git ls-files\` failed in ${git.toplevel}` +
      `${detail ? `: ${detail}` : ''}. Strata does not fall back to walking the directory inside a Git ` +
      'repository, because that would index files the repository ignores.');
  }

  const prefix = git.prefix.replace(/\\/g, '/');
  const found = new Set<string>();
  for (const [listing, isTracked] of [[tracked, true], [untracked, false]] as const) {
    for (const full of listing.toString('utf-8').split('\0')) {
      if (!full || !full.startsWith(prefix)) continue;
      const rel = full.slice(prefix.length);
      if (!rel || !isIndexablePath(rel, isTracked)) continue;
      try {
        if (!fs.lstatSync(path.join(root, rel)).isFile()) continue;
      } catch {
        continue; // tracked but not in the working tree
      }
      found.add(rel);
    }
  }
  return [...found].sort();
}

/** A regular file now: not a directory, a submodule, a symlink, or gone. */
function isRegularFile(full: string): boolean {
  try {
    return fs.lstatSync(full).isFile();
  } catch {
    return false;
  }
}

/**
 * The directory walk: every indexable file under *root*, skipping the fixed directory lists.
 * Without Git nothing is tracked, so output directories are skipped too.
 */
function walkSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip rather than fail the whole index
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') {
        if (SKIP_DIRS.has(entry.name) || OUTPUT_DIRS.has(entry.name)) continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || OUTPUT_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (EXCLUDED_BASENAMES.has(entry.name.toLowerCase())) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (EXT_LANGUAGE[ext] || DATA_EXTENSIONS.has(ext)) {
          found.push(toPosix(path.relative(root, full)));
        }
      }
    }
  };
  walk(root);
  return found.sort();
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tsx' || ext === '.jsx') return ts.ScriptKind.TSX;
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Resolve a relative import specifier to a repository-relative file path.
 *
 * Returns null for package imports and for relative paths with no file behind them.
 * `./foo.js` is also tried as `./foo.ts`, because that is what TypeScript's ESM output
 * convention produces and this repository uses it throughout.
 */
export function resolveImport(root: string, fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // package import: not a repository edge

  const fromDir = path.dirname(path.join(root, fromFile));
  const base = path.resolve(fromDir, specifier);

  const candidates: string[] = [base];
  // `./x.js` in TS ESM source usually means `./x.ts` on disk.
  const ext = path.extname(base);
  if (ext) {
    const stem = base.slice(0, -ext.length);
    candidates.push(...RESOLVE_EXTENSIONS.map((e) => stem + e));
  }
  candidates.push(...RESOLVE_EXTENSIONS.map((e) => base + e));
  candidates.push(...RESOLVE_EXTENSIONS.map((e) => path.join(base, 'index' + e)));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        const rel = toPosix(path.relative(root, candidate));
        if (rel.startsWith('..')) return null; // outside the repository
        return rel;
      }
    } catch {
      // not a file; try the next candidate
    }
  }
  return null;
}

function symbolId(filePath: string, name: string, line: number): string {
  return `${filePath}#${name}@${line}`;
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = (node as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** The hash `analyzeFile` stores for a file's bytes. */
function hashBytes(bytes: Buffer): string {
  return crypto.createHash('sha1').update(bytes).digest('hex');
}

/** Hash one file without parsing it, or null if it cannot be read. */
export function fileContentHash(root: string, relPath: string): string | null {
  try {
    return hashBytes(fs.readFileSync(path.join(root, relPath)));
  } catch {
    return null;
  }
}

/** Parse one source file into symbols, imports and bound references. */
export function analyzeFile(root: string, relPath: string): FileAnalysis | null {
  const abs = path.join(root, relPath);
  let text: string;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(abs);
    text = bytes.toString('utf-8');
  } catch {
    return null;
  }

  const ext = path.extname(relPath).toLowerCase();
  const language = EXT_LANGUAGE[ext] || (DATA_EXTENSIONS.has(ext) ? 'data' : 'unknown');
  const contentHash = hashBytes(bytes);

  // Data files are registered so a query can name them. Handing JSON to the TypeScript
  // parser would produce either an error or a tree of meaningless nodes, and either way
  // no relationship worth recording. The one exception is a package manifest's
  // dependency list, which is what "upgrade phaser" is about.
  if (language === 'data') {
    const symbols = path.basename(relPath) === 'package.json' ? dependencySymbols(relPath, text) : [];
    return { path: relPath, language, contentHash, sizeBytes: bytes.length,
             symbols, imports: [], references: [] };
  }
  const source = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKindFor(relPath));

  const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;

  const symbols: IndexedSymbol[] = [];
  const imports: IndexedImport[] = [];
  const references: IndexedReference[] = [];

  /** local name -> file it was imported from (only for resolved, in-repo imports) */
  const bindingToFile = new Map<string, string>();
  /** local name -> symbol declared in this file */
  const localSymbols = new Map<string, IndexedSymbol>();

  const addSymbol = (name: string, kind: SymbolKind, node: ts.Node, exported: boolean): void => {
    const startLine = lineOf(node.getStart(source));
    const sym: IndexedSymbol = {
      id: symbolId(relPath, name, startLine),
      filePath: relPath,
      name,
      kind,
      startLine,
      endLine: lineOf(node.getEnd()),
      exported,
    };
    symbols.push(sym);
    if (!localSymbols.has(name)) localSymbols.set(name, sym);
  };

  // --- pass 1: declarations and imports -------------------------------------------
  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const specifier = stmt.moduleSpecifier.text;
      const toFile = resolveImport(root, relPath, specifier);
      const bindings: string[] = [];
      const clause = stmt.importClause;
      if (clause) {
        if (clause.name) bindings.push(clause.name.text);
        if (clause.namedBindings) {
          if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) bindings.push(el.name.text);
          } else if (ts.isNamespaceImport(clause.namedBindings)) {
            bindings.push(clause.namedBindings.name.text);
          }
        }
      }
      imports.push({
        fromFile: relPath,
        specifier,
        toFile,
        resolution: toFile ? 'VERIFIED' : 'UNKNOWN',
        line: lineOf(stmt.getStart(source)),
        bindings,
      });
      if (toFile) for (const b of bindings) bindingToFile.set(b, toFile);
      continue;
    }

    const exported = hasExportModifier(stmt);

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      addSymbol(stmt.name.text, 'function', stmt, exported);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      addSymbol(stmt.name.text, 'class', stmt, exported);
      for (const member of stmt.members) {
        if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) &&
            member.name && ts.isIdentifier(member.name)) {
          addSymbol(`${stmt.name.text}.${member.name.text}`, 'method', member, exported);
        }
      }
    } else if (ts.isInterfaceDeclaration(stmt)) {
      addSymbol(stmt.name.text, 'interface', stmt, exported);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      addSymbol(stmt.name.text, 'type', stmt, exported);
    } else if (ts.isEnumDeclaration(stmt)) {
      addSymbol(stmt.name.text, 'enum', stmt, exported);
    } else if (ts.isVariableStatement(stmt)) {
      const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          addSymbol(decl.name.text, isConst ? 'const' : 'variable', decl, exported);
        }
      }
    }
  }

  // --- pass 2: references, but only where the name is actually bound ----------------
  const seenRef = new Set<string>();
  const recordRef = (name: string, node: ts.Node, kind: 'call' | 'identifier'): void => {
    const importedFrom = bindingToFile.get(name);
    const local = localSymbols.get(name);
    // Unbound name: store it with no target rather than guessing a definition.
    const toFile = importedFrom ?? (local ? relPath : null);
    const toSymbolId = !importedFrom && local ? local.id : null;
    const line = lineOf(node.getStart(source));
    const dedupeKey = `${name}|${line}|${kind}`;
    if (seenRef.has(dedupeKey)) return;
    seenRef.add(dedupeKey);
    references.push({
      fromFile: relPath,
      symbolName: name,
      toFile,
      toSymbolId,
      line,
      kind,
      confidence: toFile ? 'VERIFIED' : 'UNKNOWN',
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        recordRef(callee.text, callee, 'call');
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        // `googleConfig.frontendUrl` / `service.run()` — the *object* is the bound name.
        recordRef(callee.expression.text, callee.expression, 'call');
      }
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      recordRef(node.expression.text, node.expression, 'identifier');
    } else if (ts.isIdentifier(node) && bindingToFile.has(node.text)) {
      // A bare use of an imported binding (a type position, a value passed along).
      recordRef(node.text, node, 'identifier');
    }
    ts.forEachChild(node, visit);
  };
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt)) visit(stmt);
  }

  return {
    path: relPath,
    language,
    contentHash,
    sizeBytes: bytes.length,
    symbols,
    imports,
    references,
  };
}

export class CodeIndexer {
  private db: StrataDatabase;
  private root: string;

  constructor(db: StrataDatabase, repoRoot: string) {
    this.db = db;
    this.root = repoRoot;
  }

  /**
   * Index the repository.
   *
   * Incremental by default: a file whose bytes hash to the value already stored is
   * skipped, and files that have disappeared are deleted along with their edges. Pass
   * `force` to reindex everything, which is what a changed parser or schema requires.
   *
   * The file -> commit edges are a projection of the commit cache alone. A caller that
   * knows the cache did not change can pass `rebuildCommitEdges: false` to keep them.
   *
   * `trustFileTimes` lets a file skip even the hash when its size is unchanged and it was
   * last modified well before its content was last confirmed: the check git itself makes
   * before hashing. It costs a stat instead of a read and a hash, about a sixteenth, and
   * is meant for a caller that runs constantly (the prompt hook). It can miss an edit
   * that keeps the size and moves the modification time back; `strata index` does not
   * take the shortcut, so running it settles any doubt.
   *
   * A trusting run also skips the listing when it can. At the top of a Git work tree,
   * each scan records HEAD and the paths `git status` called changed. If HEAD is the same
   * at the next trusting run, every file Git does not call changed now or did not then
   * still holds HEAD's content, which is what was stored for it, so only those paths are
   * looked at: one `git status` in place of a listing and a stat per file, 2.6 s of a
   * Next.js prompt. A changed `.gitignore`, other scan rules or a moved HEAD scan in full.
   */
  public index(
    options: { force?: boolean; rebuildCommitEdges?: boolean; trustFileTimes?: boolean } = {},
  ): IndexStats {
    const started = Date.now();
    const raw = this.db.getRawDb();
    const git = gitWorkTree(this.root);
    const state = git && !git.prefix ? workTreeState(this.root) : null;
    const delta = options.trustFileTimes && !options.force && state ? this.changedSinceScan(state) : null;
    const discovered = delta
      ? delta.filter((rel) => isIndexablePath(rel, !state!.untracked.has(rel)) && isRegularFile(path.join(this.root, rel)))
      : discoverWith(this.root, git);
    const discoveredSet = new Set(discovered);

    /** What is stored per file; `confirmedAt` is when its content last matched its hash. */
    const existing = new Map<string, { hash: string; size: number; confirmedAt: number }>();
    for (const row of raw.prepare('SELECT path, content_hash, size_bytes, indexed_at FROM code_files').all() as
         { path: string; content_hash: string; size_bytes: number; indexed_at: number }[]) {
      existing.set(row.path, { hash: row.content_hash, size: row.size_bytes, confirmedAt: row.indexed_at });
    }
    const confirm = raw.prepare('UPDATE code_files SET indexed_at = ? WHERE path = ?');
    const countSymbols = raw.prepare('SELECT COUNT(*) c FROM code_symbols WHERE file_path = ?');

    const stats: IndexStats = {
      filesScanned: discovered.length,
      filesIndexed: 0, filesUnchanged: 0, filesRemoved: 0,
      symbols: 0, imports: 0, importsResolved: 0,
      references: 0, referencesResolved: 0, fileCommitEdges: 0,
      durationMs: 0,
    };

    // Files that vanished from the working tree take their edges with them. With a delta,
    // only its paths can have vanished.
    for (const knownPath of delta ?? [...existing.keys()]) {
      if (existing.has(knownPath) && !discoveredSet.has(knownPath)) {
        this.deleteFile(knownPath);
        stats.filesRemoved++;
      }
    }

    const insertFile = raw.prepare(`
      INSERT INTO code_files (path, language, content_hash, size_bytes, symbol_count, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        language = excluded.language, content_hash = excluded.content_hash,
        size_bytes = excluded.size_bytes, symbol_count = excluded.symbol_count,
        indexed_at = excluded.indexed_at
    `);
    const insertSymbol = raw.prepare(`
      INSERT INTO code_symbols (id, file_path, name, kind, start_line, end_line, exported, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'VERIFIED')
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind, end_line = excluded.end_line, exported = excluded.exported
    `);
    const insertImport = raw.prepare(`
      INSERT INTO code_imports (from_file, specifier, to_file, resolution, line)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(from_file, specifier, line) DO UPDATE SET
        to_file = excluded.to_file, resolution = excluded.resolution
    `);
    const insertRef = raw.prepare(`
      INSERT INTO code_references (from_file, symbol_name, to_file, to_symbol_id, line, kind, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const rel of discovered) {
      // Decide "unchanged" before parsing: the parse is nearly all of the cost, and on a
      // run where nothing moved it was being done for every file and thrown away.
      const known = options.force ? undefined : existing.get(rel);
      if (known) {
        let stat: fs.Stats | undefined;
        try {
          stat = fs.statSync(path.join(this.root, rel));
        } catch {
          // Unreadable now; the hash below decides, and analyzeFile skips it.
        }
        // Settled: same size, and modified well before the content was last confirmed.
        // The window covers an edit landing while the file was being read and stamped.
        const settled = stat !== undefined && stat.size === known.size
          && stat.mtimeMs < known.confirmedAt - RACY_WINDOW_MS;
        if ((options.trustFileTimes && settled) || known.hash === fileContentHash(this.root, rel)) {
          // Touched but identical: confirm it now, so the next trusting run can skip it
          // instead of hashing it again on every prompt.
          if (!settled && stat) confirm.run(Date.now(), rel);
          stats.filesUnchanged++;
          // Still count what is already stored so the summary reflects the whole graph.
          stats.symbols += (countSymbols.get(rel) as { c: number }).c;
          continue;
        }
      }

      const analysis = analyzeFile(this.root, rel);
      if (!analysis) continue;

      // Replace this file's edges wholesale: a re-parse is authoritative for it.
      this.clearFileEdges(rel);

      insertFile.run(rel, analysis.language, analysis.contentHash, analysis.sizeBytes,
                     analysis.symbols.length, Date.now());
      for (const s of analysis.symbols) {
        insertSymbol.run(s.id, s.filePath, s.name, s.kind, s.startLine, s.endLine, s.exported ? 1 : 0);
      }
      for (const imp of analysis.imports) {
        insertImport.run(imp.fromFile, imp.specifier, imp.toFile, imp.resolution, imp.line);
        if (imp.toFile) stats.importsResolved++;
      }
      for (const r of analysis.references) {
        insertRef.run(r.fromFile, r.symbolName, r.toFile, r.toSymbolId, r.line, r.kind, r.confidence);
        if (r.toFile) stats.referencesResolved++;
      }

      stats.filesIndexed++;
      stats.symbols += analysis.symbols.length;
      stats.imports += analysis.imports.length;
      stats.references += analysis.references.length;
    }

    stats.fileCommitEdges = options.force || options.rebuildCommitEdges !== false
      ? this.rebuildFileCommitEdges()
      : (raw.prepare('SELECT COUNT(*) c FROM code_file_commits').get() as { c: number }).c;

    if (delta) {
      // The files the delta left out are unchanged; count them as a full scan would.
      const total = raw.prepare('SELECT COUNT(*) files, (SELECT COUNT(*) FROM code_symbols) symbols FROM code_files')
        .get() as { files: number; symbols: number };
      stats.filesScanned = total.files;
      stats.filesUnchanged = total.files - stats.filesIndexed;
      stats.symbols = total.symbols;
    }

    const setMeta = raw.prepare(`INSERT INTO code_index_meta (key, value) VALUES (?, ?)
                                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    setMeta.run('last_indexed_at', String(Date.now()));
    // Read before any file was looked at, so an edit landing during the run is reported
    // as changed by the next `git status`, not missed. Without it no later run may skip.
    if (state) {
      setMeta.run(SCAN_HEAD, `${SCAN_RULES}:${state.head}`);
      setMeta.run(SCAN_CHANGED, JSON.stringify(state.changed));
    } else {
      raw.prepare('DELETE FROM code_index_meta WHERE key IN (?, ?)').run(SCAN_HEAD, SCAN_CHANGED);
    }

    stats.durationMs = Date.now() - started;
    return stats;
  }

  /**
   * The paths to look at when the last scan's HEAD and rules still hold: those Git calls
   * changed now, and those it called changed then (one may since have gone back to HEAD's
   * content, which the store does not yet hold). Null when a full scan is needed.
   */
  private changedSinceScan(state: { head: string; changed: string[] }): string[] | null {
    const raw = this.db.getRawDb();
    const meta = (key: string): string | undefined =>
      (raw.prepare('SELECT value FROM code_index_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    if (meta(SCAN_HEAD) !== `${SCAN_RULES}:${state.head}`) return null;
    let before: unknown;
    try {
      before = JSON.parse(meta(SCAN_CHANGED) ?? '');
    } catch {
      return null;
    }
    if (!Array.isArray(before) || !before.every((p) => typeof p === 'string')) return null;
    const paths = [...new Set([...(before as string[]), ...state.changed])];
    // An ignore rule that changed can add or hide files Git reports nothing about.
    if (paths.some((p) => path.posix.basename(p) === '.gitignore')) return null;
    return paths.sort();
  }

  private clearFileEdges(rel: string): void {
    const raw = this.db.getRawDb();
    raw.prepare('DELETE FROM code_symbols WHERE file_path = ?').run(rel);
    raw.prepare('DELETE FROM code_imports WHERE from_file = ?').run(rel);
    raw.prepare('DELETE FROM code_references WHERE from_file = ?').run(rel);
  }

  private deleteFile(rel: string): void {
    this.clearFileEdges(rel);
    this.db.getRawDb().prepare('DELETE FROM code_files WHERE path = ?').run(rel);
  }

  /**
   * Flatten `git_commits_cache.changed_files` into a queryable file -> commit table.
   *
   * Rebuilt outright rather than merged: the cache is itself rebuilt on every index run,
   * and the table is a pure projection of it, so a full rewrite of a few thousand rows is
   * both cheaper and safer than reconciling.
   *
   * One transaction, for two reasons. Without it every insert committed on its own, and
   * a few thousand synced commits took seconds: 5.9 s of a 6.2 s run on Strata's own
   * store, with nothing changed. And a reader (the prompt hook, the MCP server) must
   * never see the table emptied halfway through.
   */
  private rebuildFileCommitEdges(): number {
    const raw = this.db.getRawDb();
    raw.exec('BEGIN');
    try {
      raw.prepare('DELETE FROM code_file_commits').run();
      const insert = raw.prepare(`INSERT OR IGNORE INTO code_file_commits
        (file_path, commit_hash, authored_at) VALUES (?, ?, ?)`);
      const rows = raw.prepare('SELECT hash, authored_at, changed_files FROM git_commits_cache')
        .all() as { hash: string; authored_at: number; changed_files: string }[];
      let count = 0;
      for (const row of rows) {
        let files: string[];
        try {
          files = JSON.parse(row.changed_files);
        } catch {
          continue;
        }
        for (const f of files) {
          insert.run(toPosix(f), row.hash, row.authored_at);
          count++;
        }
      }
      raw.exec('COMMIT');
      return count;
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  }
}
