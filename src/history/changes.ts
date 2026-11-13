/**
 * Historical change extraction: what a commit did to the files you are looking at.
 *
 * Why this exists
 * ---------------
 * The context pack used to name the commits that touched a neighbourhood and stop there.
 * Measured on a history-dependent task, that turned out to be worth almost nothing: the
 * agent was handed `44ce16f — Fixing Major Issues and Benchmarks`, which is a pointer, not
 * a fact, and it still had to run `git show` to learn that the commit had flipped a
 * database primary key from `videoId` to `trackKey`.
 *
 * Four lines of diff would have carried the entire explanation. This module goes and gets
 * them.
 *
 * What it will not do
 * -------------------
 * It does not summarise, paraphrase, or explain. Everything it returns is exact git
 * content, so it can be labelled VERIFIED without qualification, and the reader can tell
 * the difference between what the repository records and what someone concluded from it.
 * Where a diff is too large to carry whole, hunks are dropped and the omission is stated —
 * never silently, and never replaced by a description of what was dropped.
 */

import { execFileSync } from 'node:child_process';

/** How a commit touched one file. */
export type ChangeStatus = 'add' | 'modify' | 'delete' | 'rename' | 'unknown';

export interface FileChangeDetail {
  path: string;
  /** Previous path, for renames only. */
  previousPath?: string;
  status: ChangeStatus;
  /** Exact diff hunks, trimmed to the budget. Empty when the diff carried none. */
  hunks: string[];
  /** Hunks dropped to fit. Stated rather than hidden. */
  hunksOmitted: number;
  linesOmitted: number;
}

export interface CommitChanges {
  sha: string;
  /** Files from the requested set that this commit actually touched. */
  files: FileChangeDetail[];
  /** Touched files outside the requested set, named but not diffed. */
  otherFiles: string[];
  otherFilesOmitted: number;
}

export interface HistoricalFileContent {
  path: string;
  status: 'deleted' | 'present';
  /** Commit the content was read from. */
  sourceCommit: string;
  lines: string[];
  linesOmitted: number;
}

export interface ChangeReaderOptions {
  /** Diff context lines. Small: the surrounding code is usually already in the pack. */
  contextLines?: number;
  maxHunksPerFile?: number;
  maxLinesPerHunk?: number;
  maxFilesPerCommit?: number;
  /** Extra non-target files from the same commit worth diffing. */
  maxRelatedFiles?: number;
  /** A related file is only diffed when its change is this small. */
  maxRelatedDiffLines?: number;
  /** Newest commits searched for deleted tests. See `deletedRelatedTests`. */
  deletedTestWindow?: number;
}

const DEFAULTS: Required<ChangeReaderOptions> = {
  contextLines: 2,
  maxHunksPerFile: 2,
  maxLinesPerHunk: 14,
  maxFilesPerCommit: 2,
  maxRelatedFiles: 2,
  maxRelatedDiffLines: 24,
  // The same as GIT_COMMIT_CACHE_SIZE in src/records/service.ts, which is where every
  // decision a pack can show comes from.
  deletedTestWindow: 200,
};

/** Paths that are never worth diffing into a context pack. */
const NOISE = /(^|\/)(node_modules|dist|build|\.next|coverage)\//;
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/;

/** Binaries and generated reports: a diff of these is noise or unreadable. */
const UNDIFFABLE = /\.(pdf|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|mp[34]|zip|exe|node|wasm)$/i;

/**
 * Files no code edge can reach.
 *
 * A schema, a migration, an environment file: nothing imports them, so the graph has no
 * path to them and a commit is the only thing that can carry them into a pack. That is
 * precisely why they are worth pulling in unasked — and it is a property of the file, not
 * a guess about the question.
 */
const EDGELESS = /\.(prisma|sql|ya?ml|toml|graphql|env|ini|conf|cfg)$/i;

/**
 * A commit touching more files than this is bulk work — an import, a shallow history's
 * root, a sweep — whose smallest diffs say nothing about the target. The same bound as
 * `MAX_COMPANION_SOURCE_FILES` in src/context/decisions.ts.
 */
const BULK_COMMIT_FILES = 200;

/** The name-status read every caller shares, so one answer serves them all. */
function nameStatusArgs(sha: string): string[] {
  return ['show', '--pretty=format:', '--name-status', '--find-renames', sha];
}

/** First path segment, used to ask whether a file lives alongside the target. */
function topLevel(p: string): string {
  const at = p.indexOf('/');
  return at === -1 ? '' : p.slice(0, at);
}

export class CommitChangeReader {
  private repoRoot: string;
  private opts: Required<ChangeReaderOptions>;
  /** Answers already obtained during the current request. Cleared by `beginRequest`. */
  private cache = new Map<string, string>();
  /** Commit hash -> current path -> the path it had in that commit, for this request. */
  private pathThen = new Map<string, Map<string, string>>();
  /** Current path -> every earlier path it had. */
  private formerNames = new Map<string, Set<string>>();

  constructor(repoRoot: string, options: ChangeReaderOptions = {}) {
    this.repoRoot = repoRoot;
    this.opts = { ...DEFAULTS, ...options };
  }

  /**
   * Clear the per-request cache.
   *
   * Called at the start of each pack build. The cache is correct only for the duration of
   * one request: `HEAD` and the working tree can move between them, and a stale answer to
   * "is this line still in the file?" would turn a SUPERSEDED decision into an ACTIVE one
   * — a confident wrong answer, which is the worst thing this module can produce.
   */
  public beginRequest(): void {
    this.cache.clear();
    this.pathThen.clear();
    this.formerNames.clear();
  }

  /**
   * Where the request's targets lived before they were renamed (`GitClient.getTargetHistory`).
   *
   * Every question here is asked by a file's current path, and a commit made before the file
   * was moved touched it under another one: its diff, read by the current path, was empty,
   * so the change that answered a question about a moved file produced no decision. Paths
   * are translated per commit for what a commit did, and every former name is searched for
   * what came after it.
   */
  public setFormerPaths(pathThen: Map<string, Map<string, string>>): void {
    for (const [sha, paths] of pathThen) {
      this.pathThen.set(sha, new Map(paths));
      for (const [now, then] of paths) {
        (this.formerNames.get(now) ?? this.formerNames.set(now, new Set()).get(now)!).add(then);
      }
    }
  }

  /** The path *path* had in commit *sha*. */
  private pathAt(sha: string, path: string): string {
    return this.pathThen.get(sha)?.get(path) ?? path;
  }

  /** The current path of what commit *sha* touched as *pathThen*, or *pathThen* itself. */
  public currentPath(sha: string, pathThen: string): string {
    for (const [now, then] of this.pathThen.get(sha) ?? []) if (then === pathThen) return now;
    return pathThen;
  }

  /** *path* and every name it had before. */
  private allNames(path: string): string[] {
    return [path, ...(this.formerNames.get(path) ?? [])];
  }

  /**
   * Run git, once per distinct question per request.
   *
   * Deciding whether a change still holds asks git the same few things repeatedly — the
   * file at HEAD, the lines a commit edited, what came after it — once per decision and
   * often for the same path. Without the cache one pack spawned dozens of processes, which
   * was both slow and, under parallel test load, flaky: a process that fails to spawn is
   * indistinguishable here from a commit with nothing to say.
   *
   * That ambiguity is the reason for the retry. A genuine git error — a missing object, a
   * path that never existed — reports a non-zero exit and legitimately means "no content".
   * A failure to spawn at all has no exit code, means nothing about the repository, and is
   * worth one more attempt before being treated as an answer.
   */
  private git(args: string[]): string {
    const key = args.join('\u0000');
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    let out = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        out = execFileSync('git', args, {
          cwd: this.repoRoot,
          encoding: 'utf-8',
          maxBuffer: 24 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        break;
      } catch (error) {
        const spawned = typeof (error as { status?: number }).status === 'number';
        // Git ran and said no. That is an answer, and it is cached like any other.
        if (spawned) break;
        // Git never ran. Not an answer; try once more before accepting the silence.
      }
    }
    this.cache.set(key, out);
    return out;
  }

  /**
   * Read the file lists of *shas* in one `git log`, ahead of the per-commit reads that
   * would otherwise ask for each in its own process: a pack asks for about ten, and a
   * process costs some 35 ms on Windows. Merge commits are left to `git show`, whose
   * output for them `git log` does not reproduce, and so is everything if the read fails.
   */
  public prefetchTouched(shas: string[]): void {
    const todo = [...new Set(shas.filter(Boolean))]
      .filter((sha) => !this.cache.has(nameStatusArgs(sha).join('\u0000')));
    if (todo.length < 2) return;
    const MARK = String.fromCharCode(1);
    const raw = this.git(['log', '--no-walk=unsorted', `--format=${MARK}%H %P`, '--name-status', '--find-renames', ...todo]);
    for (const block of raw.split(MARK).slice(1)) {
      const newline = block.indexOf('\n');
      const [hash = '', ...parents] = (newline === -1 ? block : block.slice(0, newline)).trim().split(' ');
      if (parents.length > 1) continue;
      const body = newline === -1 ? '' : block.slice(newline + 1);
      for (const sha of todo) {
        if (hash.startsWith(sha)) this.cache.set(nameStatusArgs(sha).join('\u0000'), body);
      }
    }
  }

  /**
   * What *sha* did to *paths*.
   *
   * The diff is scoped to the requested paths at the git level rather than filtered
   * afterwards, which is what keeps this affordable: the commit that untracked vendored
   * dependencies in the fixture repository touches 5,522 files, and asking git for the two
   * that matter costs the same as asking for one.
   */
  public changesFor(sha: string, paths: string[]): CommitChanges {
    const wanted = paths.map((p) => this.pathAt(sha, p)).filter((p) => !NOISE.test(p) && !LOCKFILE.test(p));
    const result: CommitChanges = { sha, files: [], otherFiles: [], otherFilesOmitted: 0 };
    if (!sha) return result;

    // Everything the commit touched, for the "also changed" line. Cheap: names only.
    const touched = parseNameStatus(this.git(nameStatusArgs(sha)));
    const wantedSet = new Set(wanted);
    const others = touched
      .filter((t) => !wantedSet.has(t.path) && !NOISE.test(t.path) && !LOCKFILE.test(t.path))
      .map((t) => t.path);
    result.otherFiles = others.slice(0, 6);
    result.otherFilesOmitted = Math.max(0, others.length - result.otherFiles.length);

    if (!wanted.length) return result;

    const diffed = new Set<string>();
    const addFile = (path: string): void => {
      if (diffed.has(path)) return;
      const entry = touched.find((t) => t.path === path);
      if (!entry) return; // this commit did not touch this file
      diffed.add(path);
      const raw = this.git([
        'show', `--unified=${this.opts.contextLines}`, '--pretty=format:', '--find-renames',
        sha, '--', path,
      ]);
      const { hunks, hunksOmitted, linesOmitted } = this.selectHunks(raw);
      result.files.push({
        path,
        ...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
        status: entry.status,
        hunks,
        hunksOmitted,
        linesOmitted,
      });
    };

    for (const path of wanted.slice(0, this.opts.maxFilesPerCommit)) addFile(path);

    /*
      Then a couple of the commit's *other* files, smallest diff first.

      The target file is not always where the answer is. In the case that motivated this
      module the query was about a cache service, and the fact that explained it was a
      four-line change to a Prisma schema in the same commit — a file nothing imports, so
      no code edge reaches it and it never enters the neighbourhood.

      Smallest-first is the selection rule because it is cheap, mechanical, and points the
      right way: a key flip, a threshold, a changed default. A large diff in the same
      commit is usually the bulk work, and the bulk work is rarely the surprise. Files
      outside this cut are still named under "also changed", so nothing is hidden — only
      undiffed.

      But "small" alone reaches too far. A commit can be broad, and the smallest change in
      a broad commit is as often a two-word copy edit in an unrelated corner of the tree as
      it is the fact that explains the target. Measured: a copy change swapping one product
      name in a marketing component was carried into a pack about a cache service, next to
      the schema change that actually explained it, and cost the same budget.

      So the reason the rule exists is applied directly. It exists because some files carry
      no code edges at all — a schema, a migration, a config — and therefore cannot arrive
      any other way. Those, and files that live alongside the target, are considered first;
      anything else is only reached when nothing closer qualifies.

      A bulk commit has no such companions, only volume: on a Next.js shallow root the
      size read alone took 0.66 s, to diff two example `.env` files into the pack.
    */
    if (touched.length > BULK_COMMIT_FILES) {
      result.otherFiles = result.otherFiles.filter((p) => !diffed.has(p));
      return result;
    }
    const sizes = parseNumstat(this.git(['show', '--pretty=format:', '--numstat', '--find-renames', sha]));
    const scopes = new Set(wanted.map(topLevel));
    const candidates = touched
      .map((t) => t.path)
      .filter((p) => !diffed.has(p) && !NOISE.test(p) && !LOCKFILE.test(p) && !UNDIFFABLE.test(p))
      .map((p) => ({ path: p, size: sizes.get(p) ?? Number.MAX_SAFE_INTEGER }))
      .filter((x) => x.size > 0 && x.size <= this.opts.maxRelatedDiffLines);

    const bySize = (a: { path: string; size: number }, b: { path: string; size: number }): number =>
      a.size - b.size || a.path.localeCompare(b.path);
    const near = candidates
      .filter((x) => EDGELESS.test(x.path) || scopes.has(topLevel(x.path)))
      .sort(bySize);
    const far = candidates.filter((x) => !near.includes(x)).sort(bySize);

    for (const r of [...near, ...far].slice(0, this.opts.maxRelatedFiles)) addFile(r.path);

    result.otherFiles = result.otherFiles.filter((p) => !diffed.has(p));
    return result;
  }

  /**
   * Read a file's content out of history.
   *
   * It is invisible to anything that reads the working tree, because at HEAD it does not
   * exist. Content is read from the git object store with `git show <rev>:<path>`, and
   * nothing is written to disk — restoring a deleted file into a worktree an agent is
   * about to edit would be a destructive side effect of a read.
   */
  public fileAtCommit(sha: string, path: string, maxLines = 40): HistoricalFileContent | null {
    // For a file deleted *by* this commit, its content lives in the parent.
    const deletedHere = parseNameStatus(
      this.git(['show', '--pretty=format:', '--name-status', sha]),
    ).some((t) => t.path === path && t.status === 'delete');

    const rev = deletedHere ? `${sha}^` : sha;
    const body = this.git(['show', `${rev}:${path}`]);
    if (!body.trim()) return null;

    const all = body.split('\n');
    const lines = all.slice(0, maxLines);
    return {
      path,
      status: deletedHere ? 'deleted' : 'present',
      sourceCommit: deletedHere ? `${sha}^` : sha,
      lines,
      linesOmitted: Math.max(0, all.length - lines.length),
    };
  }

  /** Does *path* exist at HEAD? Used to decide whether history is the only way to see it. */
  public existsAtHead(path: string): boolean {
    return this.git(['ls-tree', '--name-only', 'HEAD', '--', path]).trim().length > 0;
  }

  /**
   * Every path a commit touched, with how it touched it.
   *
   * Separate from `changesFor` on purpose. Asking "what did this commit decide?" should
   * not depend on whether the pack had budget to carry that commit's diff — those are a
   * cheap question and an expensive one, and tying them together starved the middle of
   * every chain: with the origin and the most recent change reserved, a three-commit
   * history gave its decisive middle commit no diff and therefore no decision.
   */
  public touchedPaths(sha: string): { path: string; status: ChangeStatus }[] {
    if (!sha) return [];
    return parseNameStatus(this.git(nameStatusArgs(sha)))
      .filter((t) => !NOISE.test(t.path) && !LOCKFILE.test(t.path) && !UNDIFFABLE.test(t.path))
      .map((t) => ({ path: t.path, status: t.status }));
  }

  /** The file as it stands at HEAD, or null when HEAD does not have it. */
  public contentAtHead(path: string): string | null {
    if (!this.existsAtHead(path)) return null;
    return this.git(['show', `HEAD:${path}`]);
  }

  /**
   * The exact lines a commit added to and removed from one file.
   *
   * Only `+` and `-` lines are taken: this is not for reading, it is for asking whether
   * the change is still in force. A context line is neither added nor removed, and
   * counting one as either would make every change look partially reverted. Context
   * changes how hunks are grouped, not which lines a diff adds or removes, so this reads
   * the same diff `changesFor` shows instead of asking git again with none.
   */
  public editedLines(sha: string, path: string): { added: string[]; removed: string[] } {
    const raw = this.git([
      'show', `--unified=${this.opts.contextLines}`, '--pretty=format:', '--find-renames', sha, '--',
      this.pathAt(sha, path),
    ]);
    const added: string[] = [];
    const removed: string[] = [];
    for (const line of raw.split('\n')) {
      if (/^\+\+\+/.test(line) || /^---/.test(line)) continue;
      if (/^\+/.test(line)) added.push(line.slice(1));
      else if (/^-/.test(line)) removed.push(line.slice(1));
    }
    return { added, removed };
  }

  /** Commits after *sha* that touched *path*, oldest first. */
  public laterCommitsTouching(sha: string, path: string, limit = 4):
      { shortHash: string; subject: string }[] {
    const raw = this.git([
      'log', '--reverse', '--format=%h%x09%s', `${sha}..HEAD`, '--', ...this.allNames(path),
    ]);
    const out: { shortHash: string; subject: string }[] = [];
    for (const line of raw.split('\n')) {
      const [shortHash, ...rest] = line.split('\t');
      if (!shortHash?.trim() || !rest.length) continue;
      out.push({ shortHash: shortHash.trim(), subject: rest.join('\t').trim() });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * The first commit after *sha* that removed *needle* from *path*.
   *
   * `git log -S` counts occurrences of the string on each side of a commit, so it names
   * the commit where a line stopped existing rather than every commit that touched the
   * file. That is the difference between "something changed here later" and "this is what
   * replaced it".
   */
  public commitRemoving(sha: string, path: string, needle: string):
      { shortHash: string; subject: string } | null {
    const term = needle.trim();
    if (term.length < 4) return null;
    const raw = this.git([
      'log', '--reverse', '--format=%h%x09%s', `-S${term}`, `${sha}..HEAD`, '--', ...this.allNames(path),
    ]);
    const line = raw.split('\n').find((l) => l.trim().length > 0);
    if (!line) return null;
    const [shortHash, ...rest] = line.split('\t');
    if (!shortHash?.trim() || !rest.length) return null;
    return { shortHash: shortHash.trim(), subject: rest.join('\t').trim() };
  }

  /**
   * Ancestry position of every commit touching *path*, oldest first.
   *
   * Used to order a change chain. See `commitOrderQuery` for why the authored
   * timestamp is not enough on its own.
   */
  public commitOrder(path: string, limit = 200): Map<string, number> {
    const raw = this.git([...commitOrderQuery(path), ...this.allNames(path).slice(1)]);
    const order = new Map<string, number>();
    let i = 0;
    for (const line of raw.split('\n')) {
      const h = line.trim();
      if (!h) continue;
      order.set(h, i++);
      if (i >= limit) break;
    }
    return order;
  }

  /**
   * Test-shaped files matching *path*'s stem that git once held and HEAD does not.
   *
   * The per-commit recovery only reaches a deleted file when the commit that
   * removed it also touched the target, which is the common case and not the only
   * one: a test deleted on its own, in its own commit, is exactly the evidence a
   * reader most needs and the one the commit-scoped search cannot see.
   *
   * The search covers the newest `deletedTestWindow` commits, not the whole
   * history. It used to be one `git log --diff-filter=D -- *<stem>*` over every
   * commit, per target, and a leading `*` lets git prune no directory, so the
   * pathspec saved nothing: on a VS Code clone (24,349 commits) each walk took
   * about 2 s with the pathspec or without it, a pack ran it for four targets,
   * and the hook built two packs, so 14.8 s of a 35 s hook went here. The window
   * reads 200 commits in about 0.1 s, once per pack, whatever the targets.
   *
   * The bound is safe because the window is the commit cache: every decision a
   * pack shows comes from those commits, and a test deleted because a decision
   * changed is deleted in that commit or after it, so inside the window. A
   * history shorter than the window is read whole, as before. Stem matching
   * moved from the pathspec to the path itself, which is the same test without
   * git reading `[`, `?` or `*` in a filename as a wildcard. With no pathspec,
   * git's history simplification no longer hides a deletion on a merged side
   * branch: checked over full history on 40 stems of a React clone, 39 matched
   * the old walk and the 40th was a deletion that walk had skipped.
   */
  public deletedRelatedTests(path: string, limit = 2):
      { path: string; deletedIn: string; subject: string }[] {
    const base = (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '')
      .replace(/(Service|Controller|Algorithm|Util|Utils)$/i, '');
    if (base.length < 4) return [];

    // %x01 marks each commit header so the paths under it stay attributable.
    // `--diff-filter=D` is not used: with it `--max-count` counts only commits that
    // delete something, and the window would reach back past the commit cache.
    // Without a pathspec, rename detection sees the whole commit, so a test moved
    // under another name is a rename here and not reported as deleted.
    const MARK = String.fromCharCode(1);
    const TAB = String.fromCharCode(9);
    const raw = this.git([
      'log', `--max-count=${this.opts.deletedTestWindow}`, '--name-status', '--format=%x01%h%x09%s',
    ]);
    const out: { path: string; deletedIn: string; subject: string }[] = [];
    let sha = '', subject = '';
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      if (line.startsWith(MARK)) {
        const [h, ...rest] = line.slice(1).split(TAB);
        sha = h?.trim() ?? ''; subject = rest.join(TAB).trim();
        continue;
      }
      const [status, ...names] = line.split(TAB);
      if (status !== 'D' || names.length !== 1) continue;
      const text = names[0]!.trim();
      if (!text.includes(base)) continue;
      const leaf = text.split('/').pop() ?? '';
      const isTestShaped = /(^|\/)(tests?|__tests__|spec)\//i.test(text)
        || /\.(test|spec)\./i.test(text)
        || /^test[A-Z0-9_]/.test(leaf);
      if (!isTestShaped || this.existsAtHead(text)) continue;
      if (out.some((o) => o.path === text)) continue;
      out.push({ path: text, deletedIn: sha, subject });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Files a commit added or deleted that look like tests or fixtures for *paths*.
   *
   * A test added alongside a change is the closest thing a repository has to a statement
   * of what the change was for, and it is the one kind of related file worth pulling in
   * unasked. Matching is on the filename stem so `testTrackCache.ts` is found for
   * `trackCacheService.ts`; nothing here guesses at meaning.
   */
  public relatedTestFiles(sha: string, paths: string[]): string[] {
    const stems = paths.map((p) => {
      const base = p.split('/').pop() ?? p;
      return base.replace(/\.[^.]+$/, '').replace(/(Service|Controller|Algorithm|Util|Utils)$/i, '')
        .toLowerCase();
    }).filter((s) => s.length >= 4);
    if (!stems.length) return [];

    const touched = parseNameStatus(this.git(nameStatusArgs(sha)));
    return touched
      .filter((t) => /(^|\/)(tests?|__tests__|spec|scripts)\//i.test(t.path) || /\.(test|spec)\./i.test(t.path)
        || /(^|\/)test[A-Z0-9_]/.test(t.path.split('/').pop() ?? ''))
      .filter((t) => !NOISE.test(t.path))
      .filter((t) => stems.some((s) => t.path.toLowerCase().includes(s)))
      .map((t) => t.path)
      .slice(0, 2);
  }

  /** Keep the first hunks, truncating long ones, and report what was dropped. */
  private selectHunks(raw: string): { hunks: string[]; hunksOmitted: number; linesOmitted: number } {
    if (!raw.trim()) return { hunks: [], hunksOmitted: 0, linesOmitted: 0 };

    const lines = raw.split('\n');
    const start = lines.findIndex((l) => l.startsWith('@@'));
    if (start === -1) return { hunks: [], hunksOmitted: 0, linesOmitted: 0 };

    const blocks: string[][] = [];
    let current: string[] | null = null;
    for (const line of lines.slice(start)) {
      if (line.startsWith('@@')) {
        current = [line];
        blocks.push(current);
      } else if (current) {
        if (line.startsWith('diff --git')) break;
        current.push(line);
      }
    }

    // A hunk that changes nothing is context noise; a diff can produce one after
    // rename detection.
    const meaningful = blocks.filter((b) => b.some((l) => /^[+-][^+-]/.test(l) || /^[+-]$/.test(l)));
    const kept = meaningful.slice(0, this.opts.maxHunksPerFile);
    let linesOmitted = 0;
    const hunks = kept.map((b) => {
      if (b.length <= this.opts.maxLinesPerHunk) return b.join('\n');
      linesOmitted += b.length - this.opts.maxLinesPerHunk;
      return [...b.slice(0, this.opts.maxLinesPerHunk), `… ${b.length - this.opts.maxLinesPerHunk} more line(s) in this hunk`].join('\n');
    });
    return { hunks, hunksOmitted: Math.max(0, meaningful.length - kept.length), linesOmitted };
  }
}

interface NameStatusEntry {
  path: string;
  previousPath?: string;
  status: ChangeStatus;
}

const STATUS_MAP: Record<string, ChangeStatus> = {
  A: 'add', M: 'modify', D: 'delete', R: 'rename', C: 'add', T: 'modify',
};

/** `--numstat` -> path -> added+deleted. Binary files report "-" and are skipped. */
export function parseNumstat(raw: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 3) continue;
    const added = Number.parseInt(parts[0]!, 10);
    const deleted = Number.parseInt(parts[1]!, 10);
    if (Number.isNaN(added) || Number.isNaN(deleted)) continue;
    out.set(parts[parts.length - 1]!.trim(), added + deleted);
  }
  return out;
}

export function parseNameStatus(raw: string): NameStatusEntry[] {
  const out: NameStatusEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 2) continue;
    const code = parts[0]!.charAt(0).toUpperCase();
    const status = STATUS_MAP[code] ?? 'unknown';
    if (status === 'rename' && parts.length >= 3) {
      out.push({ status, previousPath: parts[1]!.trim(), path: parts[2]!.trim() });
    } else {
      out.push({ status, path: parts[parts.length - 1]!.trim() });
    }
  }
  return out;
}

/**
 * Ancestry order of the commits touching one path, oldest first.
 *
 * `authoredAt` is second-resolution and is not a total order: scripted commits,
 * imports and rebases routinely land several in the same second, and sorting a
 * chain by it then yields an arbitrary sequence under a heading that claims the
 * ordering is VERIFIED. Git's own ancestry is the authority, so the chain asks
 * for it rather than inferring order from a timestamp that may tie.
 */
export function commitOrderQuery(path: string): string[] {
  return ['log', '--reverse', '--format=%h', '--', path];
}
