import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitClient } from '../git/git.js';
import { DocsResult, DOCS_FORMAT, HEAD_AT_RECORD, docsPresent, writeProjectDocs } from '../docs/project-docs.js';
import { StrataDatabase, STRATA_DIR_NAME } from '../storage/db.js';
import { StrataRepository } from '../storage/repository.js';
import { HistoryRetriever, FileHistoryResult } from '../retrieval/history.js';
import { FileExplainer, FileExplanation } from '../retrieval/explainer.js';
import { ContextRetriever, TaskContextDigest } from '../retrieval/context.js';
import { ContextEngine, ContextOptions } from '../context/engine.js';
import { ContextPack, renderPack } from '../context/pack.js';
import { APPLICABILITY_BLOCK_CHARS } from '../context/applicability.js';
import { renderHuman, HumanView } from '../context/human.js';
import { CodeIndexer, IndexStats } from '../code/indexer.js';
import { RecordFormatError, parseRecordMarkdown, renderRecordMarkdown } from './markdown.js';
import {
  StrataRecord,
  CreateRecordInput,
  CreateRecordInputSchema,
  StrataRecordSchema,
} from '../schema/types.js';

export interface StrataStatus {
  initialized: boolean;
  repoRoot: string;
  strataDir: string;
  currentBranch: string;
  headCommit: string;
  totalRecords: number;
  totalCachedCommits: number;
  dbPath: string;
}

/** What `indexCode` reports: the graph's statistics, plus the commit cache it joins against. */
export interface CodeIndexStats extends IndexStats {
  commitsCached: number;
  /** Whether the commit cache was re-read from git on this run (HEAD had moved). */
  commitsRefreshed: boolean;
  /** Records whose file differed from the store and were read into it on this run. */
  recordsUpdated: number;
  /** Record files that could not be read, or were read with a correction. */
  recordProblems: RecordFileProblem[];
}

/** A record file Strata could not read as written, and what it did instead. */
export interface RecordFileProblem {
  /** The file, relative to the repository root. */
  file: string;
  message: string;
}

/** What reading `.strata/records/` into the store did. */
export interface RecordSyncResult {
  /** Record files read without a problem that stops them loading. */
  read: number;
  /** Ids whose file differed from the store and were saved to it. */
  updated: string[];
  problems: RecordFileProblem[];
}

/** Budget for the human views: out of reach, so the trimmer never runs on them. */
const HUMAN_VIEW_BUDGET = 1_000_000;

/** Commits whose files count as current work, besides what is not yet committed. */
const ACTIVE_COMMITS = 5;

/** Commits kept in the cache: the newest this many reachable from HEAD. */
const GIT_COMMIT_CACHE_SIZE = 200;

/**
 * Whether two records hold the same memory, ignoring when they were written.
 *
 * Compared on a canonical form — keys sorted, undefined dropped — so a record read
 * back from SQLite and the same record freshly derived compare equal.
 */
function sameContent(a: StrataRecord, b: StrataRecord): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([k, v]) => v !== undefined && k !== 'createdAt' && k !== 'updatedAt')
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, v]) => [k, canonical(v)]));
    }
    return value;
  };
  // The store returns a record's files in its own index order; the set is what matters.
  const byPath = (r: StrataRecord): StrataRecord =>
    ({ ...r, files: [...r.files].sort((x, y) => x.path.localeCompare(y.path)) });
  return JSON.stringify(canonical(byPath(a))) === JSON.stringify(canonical(byPath(b)));
}

/**
 * *record* as the store gives it back: files in path order (the store keeps no order for
 * them) and attempts numbered from 1 where they had no number (the store numbers them).
 */
function asStored(record: StrataRecord): StrataRecord {
  return {
    ...record,
    files: [...record.files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)),
    attempts: record.attempts.map((a, i) => ({ ...a, sequence: a.sequence ?? i + 1 })),
  };
}

export class StrataService {
  private repoRoot: string;
  private gitClient: GitClient;
  private db?: StrataDatabase;
  private repository?: StrataRepository;
  private explainer?: FileExplainer;
  private historyRetriever?: HistoryRetriever;
  private contextRetriever?: ContextRetriever;
  private contextEngine?: ContextEngine;

  constructor(repoRoot?: string) {
    if (repoRoot) {
      this.repoRoot = path.resolve(repoRoot);
      this.gitClient = new GitClient(this.repoRoot);
    } else {
      if (GitClient.isGitRepo()) {
        this.gitClient = new GitClient();
        this.repoRoot = this.gitClient.getRoot();
      } else {
        this.repoRoot = process.cwd();
        this.gitClient = new GitClient(this.repoRoot);
      }
    }

    if (this.isInitialized()) {
      this.loadStorage();
    }
  }

  public isInitialized(): boolean {
    const strataDir = path.join(this.repoRoot, STRATA_DIR_NAME);
    const dbPath = path.join(strataDir, 'strata.db');
    return fs.existsSync(strataDir) && fs.existsSync(dbPath);
  }

  private loadStorage(): void {
    if (!this.db) {
      this.db = new StrataDatabase({ repoRoot: this.repoRoot });
      this.repository = new StrataRepository(this.db);
      this.explainer = new FileExplainer(this.repository);
      this.historyRetriever = new HistoryRetriever(this.repository);
      this.contextRetriever = new ContextRetriever(this.repository);
      this.contextEngine = new ContextEngine(this.db, this.repository, this.repoRoot);
    }
  }

  private ensureStorage(): { repo: StrataRepository; db: StrataDatabase } {
    if (!this.repository || !this.db) {
      this.loadStorage();
    }
    if (!this.repository || !this.db) {
      throw new Error('Strata is not initialized. Run "strata init" first.');
    }
    return { repo: this.repository, db: this.db };
  }

  /**
   * Initialize Strata in the current Git repository.
   */
  public init(): { strataDir: string; commitsIndexed: number } {
    const strataDir = path.join(this.repoRoot, STRATA_DIR_NAME);
    const recordsDir = path.join(strataDir, 'records');

    fs.mkdirSync(strataDir, { recursive: true });
    fs.mkdirSync(recordsDir, { recursive: true });

    // Initialize database
    this.loadStorage();
    const { repo } = this.ensureStorage();

    const commitsIndexed = this.refreshGitCommits(repo, true).read;

    // Read the record files already in .strata/records/ (a clone, or a pull) into the store.
    this.syncRecordFiles();

    return {
      strataDir,
      commitsIndexed,
    };
  }

  /**
   * Get current status of Strata.
   */
  public getStatus(): StrataStatus {
    const initialized = this.isInitialized();
    const strataDir = path.join(this.repoRoot, STRATA_DIR_NAME);
    const dbPath = path.join(strataDir, 'strata.db');

    let totalRecords = 0;
    let totalCachedCommits = 0;

    if (initialized) {
      const { repo } = this.ensureStorage();
      totalRecords = repo.getRecordCount();
      totalCachedCommits = repo.getGitCommitCount();
    }

    let currentBranch = 'unknown';
    let headCommit = '';

    try {
      currentBranch = this.gitClient.getCurrentBranch();
      headCommit = this.gitClient.getHeadHash();
    } catch {
      // Non-git or empty repo
    }

    return {
      initialized,
      repoRoot: this.repoRoot,
      strataDir,
      currentBranch,
      headCommit,
      totalRecords,
      totalCachedCommits,
      dbPath,
    };
  }

  /**
   * Record a new development context entry.
   */
  public recordChange(input: CreateRecordInput): StrataRecord {
    const { repo } = this.ensureStorage();
    const validatedInput = CreateRecordInputSchema.parse(input);

    // Auto-generate record ID if omitted
    const nextId = validatedInput.id || `REC-${repo.getRecordCount() + 1}`;

    // Fill author if name is empty
    let author = validatedInput.author;
    if (!author || !author.name) {
      const defaultAuthor = this.gitClient.getDefaultAuthor();
      author = {
        name: defaultAuthor.name,
        email: defaultAuthor.email,
        type: 'human',
      };
    }

    // Evidence handed in by a caller (the CLI, an agent over MCP) is what they say they
    // have, and Strata has checked none of it, so it is at most DECLARED. VERIFIED is
    // reserved for what Strata read itself, such as the HEAD commit attached below. A
    // lower label the caller chose (INFERRED, UNKNOWN) is kept.
    const evidence = validatedInput.evidence.map((e) =>
      e.confidence === 'VERIFIED' ? { ...e, confidence: 'DECLARED' as const } : e);

    // Auto-attach current Git commit evidence if evidence list does not include a commit
    const hasGitEvidence = evidence.some((e) => e.type === 'git_commit');
    const headHash = this.gitClient.getHeadHash();
    if (!hasGitEvidence && headHash) {
      evidence.push({
        type: 'git_commit',
        reference: headHash,
        description: HEAD_AT_RECORD,
        confidence: 'VERIFIED',
      });
    }

    const now = Date.now();
    const fullRecord: StrataRecord = StrataRecordSchema.parse({
      ...validatedInput,
      id: nextId,
      author,
      evidence,
      createdAt: now,
      updatedAt: now,
    });

    return this.persist(fullRecord);
  }

  /**
   * Store a record derived from a transcript, idempotently.
   *
   * The same transcript always derives the same id, so storing it again updates that
   * record instead of adding another — and when nothing about the derivation changed,
   * nothing is written at all, so processing a transcript twice leaves the store
   * exactly as processing it once did. A longer capture of the same session (a resumed
   * run) replaces the shorter one's content under the same id.
   *
   * Two things differ from `recordChange` on purpose. The store's current HEAD is not
   * attached as evidence: the session may have run against any commit, and linking the
   * record to today's HEAD would be a code link nothing in the transcript supports. And
   * the record is dated when the session happened, where the transcript says, because
   * that is when the knowledge it holds was true.
   */
  public saveDerivedRecord(
    input: CreateRecordInput, options: { observedAt?: number } = {},
  ): { record: StrataRecord; outcome: 'created' | 'updated' | 'unchanged' } {
    const { repo } = this.ensureStorage();
    const validated = CreateRecordInputSchema.parse(input);
    if (!validated.id) throw new Error('A derived record needs a stable id; derive it with deriveRecord().');

    const existing = repo.getRecordById(validated.id);
    const now = Date.now();
    const candidate: StrataRecord = StrataRecordSchema.parse({
      ...validated,
      id: validated.id,
      author: validated.author ?? { name: 'Strata transcript deriver', type: 'system' },
      createdAt: existing?.createdAt ?? options.observedAt ?? now,
      updatedAt: existing?.updatedAt ?? now,
    });
    if (existing && sameContent(existing, candidate)) return { record: existing, outcome: 'unchanged' };

    const saved = this.persist({ ...candidate, updatedAt: now });
    return { record: saved, outcome: existing ? 'updated' : 'created' };
  }

  /** Write a record to SQLite and to its canonical JSON file. */
  private persist(record: StrataRecord): StrataRecord {
    const { repo } = this.ensureStorage();
    // 1. Save to SQLite database
    const saved = repo.saveRecord(record);

    // 2. Save the canonical record file, .strata/records/<id>.md, for Git tracking. A JSON
    //    copy from before records were Markdown is retired: the Markdown file now holds it.
    try {
      this.writeRecordFile(saved);
    } catch {
      // Non-critical file write error
    }

    // 3. Keep docs/strata/ current, in a repository that has it.
    this.afterRecordWrite();
    return saved;
  }

  /**
   * Write `docs/strata/DECISIONS.md` and `docs/strata/FLOW.md` (see `src/docs/project-docs.ts`).
   * A file is rewritten only when its content changed.
   */
  public writeDocs(): DocsResult {
    const { repo, db } = this.ensureStorage();
    const result = writeProjectDocs(this.repoRoot, db, repo);
    this.saveDocsFingerprint(this.docsFingerprint());
    return result;
  }

  /**
   * Keep the project docs current, cheaply enough to run on every prompt and record save.
   *
   * Only for a repository that has them already: generating them is opt-in (`strata docs`
   * or `strata setup`), so a repository that never asked for files in its tree never gets
   * any. And only when something they are built from has moved — HEAD, the records, or the
   * set of indexed files and import edges — which a few counts and one hash establish
   * without reading git history. Returns null when nothing was done.
   */
  public refreshDocsIfPresent(): DocsResult | null {
    if (!this.isInitialized() || !docsPresent(this.repoRoot)) return null;
    const fingerprint = this.docsFingerprint();
    if (fingerprint === this.readDocsFingerprint()) return null;
    const { repo, db } = this.ensureStorage();
    const result = writeProjectDocs(this.repoRoot, db, repo);
    this.saveDocsFingerprint(fingerprint);
    return result;
  }

  private docsFingerprint(): string {
    const { db } = this.ensureStorage();
    const raw = db.getRawDb();
    let head = '';
    try { head = this.gitClient.getHeadHash(); } catch { head = ''; }
    const records = raw.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM records').get() as { n: number; t: number | null };
    const files = (raw.prepare('SELECT path FROM code_files ORDER BY path').all() as { path: string }[]).map((r) => r.path);
    const edges = raw.prepare('SELECT COUNT(*) AS n FROM code_imports WHERE to_file IS NOT NULL').get() as { n: number };
    const exported = raw.prepare('SELECT COUNT(*) AS n FROM code_symbols WHERE exported = 1').get() as { n: number };
    return crypto.createHash('sha1')
      .update(JSON.stringify([DOCS_FORMAT, head, records.n, records.t, edges.n, exported.n, files]))
      .digest('hex');
  }

  private docsStatePath(): string {
    return path.join(this.repoRoot, STRATA_DIR_NAME, 'docs-state.json');
  }

  private readDocsFingerprint(): string | null {
    try {
      return (JSON.parse(fs.readFileSync(this.docsStatePath(), 'utf-8')) as { fingerprint?: string }).fingerprint ?? null;
    } catch {
      return null;
    }
  }

  private saveDocsFingerprint(fingerprint: string): void {
    try {
      fs.writeFileSync(this.docsStatePath(), JSON.stringify({ fingerprint }), 'utf-8');
    } catch {
      // The next refresh regenerates; nothing is lost.
    }
  }

  /** Bring the project docs up to date after a write, and never fail the write over them. */
  private afterRecordWrite(): void {
    try {
      this.refreshDocsIfPresent();
    } catch {
      // The record is saved; the docs catch up on the next refresh.
    }
  }

  /** The repository this service stores records for. */
  public getRepoRoot(): string {
    return this.repoRoot;
  }

  /**
   * Make the commit cache match the newest commits git holds now.
   *
   * A HEAD equal to the one the cache was read from means history has not changed (a
   * commit hash covers its ancestry), so the read is skipped unless *force* is set.
   * HEAD is read before the log: if a commit lands in between, the older HEAD is
   * recorded and the next refresh reads again, never the other way round.
   *
   * Returns how many commits were read, and whether the cache changed. git output that
   * yields no commits leaves the cache untouched: `getCommits` answers a failed read and
   * an empty repository the same way, and treating a failed read as "no history" would
   * wipe history the store already holds.
   */
  private refreshGitCommits(repo: StrataRepository, force = false): { read: number; changed: boolean } {
    const head = this.gitClient.getHeadHash();
    if (!force && head && head === repo.getCommitCacheHead()) return { read: 0, changed: false };
    let commits: ReturnType<GitClient['getCommits']> = [];
    try {
      commits = this.gitClient.getCommits(GIT_COMMIT_CACHE_SIZE);
    } catch {
      // Not a repository, or one with no commits yet.
    }
    if (commits.length === 0) return { read: 0, changed: false };
    // Fewer than asked for means the read reached the first commit.
    repo.replaceGitCommits(commits, head || undefined, commits.length < GIT_COMMIT_CACHE_SIZE);
    return { read: commits.length, changed: true };
  }

  /**
   * Build or refresh the code graph, and the commit cache it joins against.
   *
   * Incremental by default: unchanged files are skipped on their content hash, and the
   * commit cache is re-read only when HEAD has moved. The cache is refreshed before the
   * graph because the graph's file -> commit edges are built from it, and those edges
   * are rebuilt only when it changed. Cheap enough to run before every prompt, which is
   * what the Claude Code hook does.
   */
  public indexCode(options: { force?: boolean; trustFileTimes?: boolean } = {}): CodeIndexStats {
    const { repo } = this.ensureStorage();
    // Record files first: an edit by hand or a teammate's pull reaches the next pack.
    const records = this.syncRecordFiles();
    const commits = this.refreshGitCommits(repo, !!options.force);
    const rebuildCommitEdges = commits.changed || !repo.commitEdgesAreCurrent();
    const indexer = new CodeIndexer(this.db!, this.repoRoot);
    const stats = indexer.index({ force: options.force, rebuildCommitEdges, trustFileTimes: options.trustFileTimes });
    if (rebuildCommitEdges || options.force) repo.markCommitEdgesCurrent();
    return {
      ...stats,
      commitsCached: repo.getGitCommitCount(),
      commitsRefreshed: commits.changed,
      recordsUpdated: records.updated.length,
      recordProblems: records.problems,
    };
  }

  /**
   * The files the developer is working on now: changed and not yet committed, or changed
   * by the last few commits that touched more than Strata's own generated files.
   *
   * The resolver uses them to break a tie between files a request matches only by its
   * words (see `resolveTarget`). Strata's own output — `docs/strata/` and `.strata/` — is
   * left out, and so are commits that changed nothing else: a docs refresh after every
   * commit would otherwise fill the window with no work in it.
   */
  public activeFiles(recentCommits = ACTIVE_COMMITS): string[] {
    const generated = (f: string): boolean => f.startsWith('docs/strata/') || f.startsWith(`${STRATA_DIR_NAME}/`);
    const out = new Set(this.gitClient.getWorkingTreeChangedFiles().filter((f) => !generated(f)));
    let counted = 0;
    for (const files of this.gitClient.getRecentCommitFiles(recentCommits * 4)) {
      const work = files.filter((f) => !generated(f));
      if (!work.length) continue;
      for (const f of work) out.add(f);
      if (++counted >= recentCommits) break;
    }
    return [...out];
  }

  /**
   * Assemble a context pack for a task, file or symbol.
   *
   * This is the engine described in `src/context/engine.ts`; `getContext` below remains
   * the older record-only digest, kept because existing callers and the MCP
   * `strata_get_context` tool depend on its shape.
   */
  public getContextPack(query: string, options: ContextOptions = {}): ContextPack {
    this.ensureStorage();
    return this.contextEngine!.build(query, options);
  }

  /**
   * Render a context pack as the budget produced it: the text `estimatedTokens` measures.
   * What an agent is handed is `renderAgentContext`, which adds the applicability block.
   */
  public renderContextPack(pack: ContextPack): string {
    return renderPack(pack);
  }

  /**
   * The text an agent receives: the pack, with its applicability block under the target
   * lines. The block is outside the token budget and at most *maxApplicabilityChars*
   * characters, so it takes nothing from the evidence; see `applicability.ts`.
   */
  public renderAgentContext(pack: ContextPack, options: { maxApplicabilityChars?: number } = {}): string {
    return renderPack(pack, { applicability: { maxChars: options.maxApplicabilityChars ?? APPLICABILITY_BLOCK_CHARS } });
  }

  /**
   * "Why is this code like this?" for a developer: `strata explain` and `strata history`.
   *
   * The same engine and the same pack an agent receives, built with nothing capped, then
   * rendered for a person. The budget is set out of reach on purpose: a screen is not a
   * context window, and a history that stops at eight commits answers less than git.
   */
  public humanView(
    query: string, view: HumanView,
    options: Pick<ContextOptions, 'targetType' | 'depth'> = {},
  ): { pack: ContextPack; text: string } {
    const pack = this.getContextPack(query, { ...options, detail: 'human', maxTokens: HUMAN_VIEW_BUDGET });
    return { pack, text: renderHuman(pack, view) };
  }

  /**
   * Retrieve file development history timeline.
   */
  /**
   * One record by id.
   *
   * The write path could store development memory and nothing could read a single
   * piece of it back: everything went through search or through a context pack, so
   * "did this actually persist?" was only answerable by building a pack and reading
   * the prose. A memory system that cannot be queried directly cannot be trusted.
   */
  public getRecord(id: string): StrataRecord | null {
    const { repo } = this.ensureStorage();
    return repo.getRecordById(id) ?? null;
  }

  public getHistory(filePath: string): FileHistoryResult {
    this.ensureStorage();
    return this.historyRetriever!.getFileHistory(filePath);
  }

  /**
   * Produce a concise, evidence-backed explanation for a file.
   */
  public explainFile(filePath: string): FileExplanation {
    this.ensureStorage();
    return this.explainer!.explainFile(filePath);
  }

  /**
   * Retrieve minimum sufficient context for a task.
   */
  public getContext(task: string, files: string[] = []): TaskContextDigest {
    this.ensureStorage();
    return this.contextRetriever!.getTaskContext(task, files);
  }

  private recordsDir(): string {
    return path.join(this.repoRoot, STRATA_DIR_NAME, 'records');
  }

  /** Write *record* as `.strata/records/<id>.md`, retiring a JSON copy of the same id. */
  private writeRecordFile(record: StrataRecord): void {
    const dir = this.recordsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${record.id}.md`), renderRecordMarkdown(record), 'utf-8');
    const legacy = path.join(dir, `${record.id}.json`);
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  }

  /**
   * Read the record files in `.strata/records/` into the store.
   *
   * The files are the canonical copy: what is committed, reviewed and edited by hand, and
   * what a teammate's pull brings in. So they are read on every refresh — the prompt
   * hook's and `strata index`'s — not only at `strata init`, and a record whose file
   * differs from the store is saved from the file. Markdown files are read; a JSON file
   * from before records were Markdown is still read, unless a Markdown file of the same
   * id exists.
   *
   * Nothing is skipped silently, as it used to be. A file that does not parse is reported
   * with its line and left out, and so is a file whose id is not its name; the store
   * keeps what it had for that record. A VERIFIED label Strata did not write is read as
   * DECLARED and reported (see `markdown.ts`).
   */
  public syncRecordFiles(): RecordSyncResult {
    const result: RecordSyncResult = { read: 0, updated: [], problems: [] };
    const dir = this.recordsDir();
    if (!fs.existsSync(dir)) return result;
    const { repo } = this.ensureStorage();
    const rel = (name: string): string => path.relative(this.repoRoot, path.join(dir, name)).split(path.sep).join('/');

    const names = fs.readdirSync(dir).sort();
    const markdown = new Set(names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)));
    for (const name of names) {
      const isMd = name.endsWith('.md');
      if (!isMd && !name.endsWith('.json')) continue;
      const id = name.slice(0, isMd ? -3 : -5);
      if (!isMd && markdown.has(id)) {
        result.problems.push({ file: rel(name), message: `${id}.md holds this record; the JSON copy is ignored` });
        continue;
      }
      let record: StrataRecord;
      try {
        const text = fs.readFileSync(path.join(dir, name), 'utf-8');
        if (isMd) {
          const parsed = parseRecordMarkdown(text, rel(name));
          record = parsed.record;
          for (const d of parsed.downgraded) {
            result.problems.push({ file: rel(name), message: `${d} is marked VERIFIED, which Strata did not write; read as DECLARED` });
          }
        } else {
          record = StrataRecordSchema.parse(JSON.parse(text));
        }
      } catch (err: unknown) {
        const message = err instanceof RecordFormatError
          ? `line ${err.line}: ${err.message.slice(`${err.file}:${err.line}: `.length)}`
          : err instanceof Error ? err.message : String(err);
        result.problems.push({ file: rel(name), message: `not read: ${message}` });
        continue;
      }
      if (record.id !== id) {
        result.problems.push({ file: rel(name), message: `not read: the file holds ${record.id}, not ${id}` });
        continue;
      }
      result.read++;
      // Compared in the file's own form, so a difference the format cannot express (an
      // empty list against an absent one) is not a change; and as the store hands records
      // back, so its own conventions are not either. Measured on Strata's own records: 7 of
      // 14 were re-saved on every refresh, over file order and attempt numbers alone.
      const stored = repo.getRecordById(id);
      if (stored && renderRecordMarkdown(asStored(stored)) === renderRecordMarkdown(asStored(record))) continue;
      repo.saveRecord(record);
      result.updated.push(id);
    }
    // An edit by hand need not move `updated`, which the docs fingerprint watches.
    if (result.updated.length && docsPresent(this.repoRoot)) {
      try { this.writeDocs(); } catch { /* the next refresh tries again */ }
    }
    return result;
  }

  /**
   * Rewrite every JSON record file as Markdown: `strata migrate-records`.
   *
   * Each JSON file is read as it stands, written as `<id>.md` and then removed. Its labels
   * are kept as they were, VERIFIED included: the JSON was the canonical copy until now,
   * and the conversion changes its form, not what it says. The Markdown must read back as
   * the same record before the JSON is removed.
   */
  public migrateRecordFiles(): { migrated: string[]; problems: RecordFileProblem[] } {
    const out = { migrated: [] as string[], problems: [] as RecordFileProblem[] };
    const dir = this.recordsDir();
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const id = name.slice(0, -5);
      const file = path.relative(this.repoRoot, path.join(dir, name)).split(path.sep).join('/');
      try {
        const record = StrataRecordSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')));
        if (record.id !== id) throw new Error(`the file holds ${record.id}, not ${id}`);
        if (fs.existsSync(path.join(dir, `${id}.md`))) throw new Error(`${id}.md already exists; keep one of the two`);
        const md = renderRecordMarkdown(record);
        const back = parseRecordMarkdown(md, file);
        if (back.downgraded.length || renderRecordMarkdown(back.record) !== md) {
          throw new Error('the Markdown form did not read back as the same record');
        }
        this.writeRecordFile(record);
        out.migrated.push(id);
      } catch (err: unknown) {
        out.problems.push({ file, message: `not migrated: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return out;
  }

  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = undefined;
      this.repository = undefined;
      this.explainer = undefined;
      this.historyRetriever = undefined;
      this.contextRetriever = undefined;
    }
  }
}
