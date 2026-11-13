import { StrataDatabase } from './db.js';
import {
  StrataRecord,
  StrataRecordSchema,
  GitCommitRecord,
  GitCommitRecordSchema,
  Attempt,
  Evidence,
  FileChange,
  Consequence,
  Constraint,
  StatedReason,
} from '../schema/types.js';

/**
 * Words that appear in almost every task description and therefore separate nothing.
 * Kept deliberately short: over-filtering loses real signal ("gate", "bounds"), and FTS5
 * ranking already discounts terms that are common across the indexed records.
 */
const QUERY_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for',
  'from', 'has', 'have', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my',
  'near', 'no', 'not', 'of', 'on', 'onto', 'or', 'our', 'out', 'so', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up', 'use', 'using',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'why', 'will', 'with', 'without',
  'you', 'your',
]);

/** Upper bound on terms sent to FTS5, so a long task description cannot build a huge query. */
const MAX_QUERY_TERMS = 24;

/**
 * Distinct query terms a record must match to be considered a hit.
 *
 * OR-ing the terms is what makes retrieval work at all, but it is permissive: one shared
 * word - often an incidental fragment of a file path - is enough for FTS5 to return a
 * record about something else entirely. Requiring two independent hits is the cheapest
 * rule that separates "about this" from "mentions a word from this".
 */
const MIN_TERM_MATCHES = 2;

/** `code_index_meta` key: the HEAD the commit cache was last read from. */
const COMMIT_CACHE_HEAD = 'commit_cache_head';

/** `code_index_meta` key: '1' when the cache holds every commit reachable from its HEAD. */
const COMMIT_CACHE_COMPLETE = 'commit_cache_complete';

/** `code_index_meta` key: the cache HEAD the file -> commit edges were last built from. */
const COMMIT_EDGES_HEAD = 'commit_edges_head';

/**
 * Split a free-text task description into FTS5-safe search terms.
 *
 * Splitting on non-word characters rather than stripping them matters: "104/136" has to
 * become two searchable numbers, not the meaningless token "104136".
 */
export function tokenizeQuery(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.split(/[^A-Za-z0-9_]+/)) {
    const t = raw.trim().toLowerCase();
    if (t.length < 2) continue;
    if (QUERY_STOPWORDS.has(t)) continue;
    seen.add(t);
    if (seen.size >= MAX_QUERY_TERMS) break;
  }
  return Array.from(seen);
}

/**
 * How many of `terms` this record matches, using the same prefix rule as the FTS query.
 *
 * Mirrors the columns fed into records_fts, so a record is judged on the text it was
 * actually indexed by rather than on its whole serialised form.
 */
export function countMatchingTerms(record: StrataRecord, terms: string[]): number {
  const haystack = [
    record.title,
    record.intent,
    record.result.summary ?? '',
    ...record.attempts.map((a) => `${a.approach} ${a.failureReason ?? ''}`),
    ...record.files.map((f) => f.path),
  ]
    .join(' ')
    .toLowerCase();

  const words = haystack.split(/[^a-z0-9_]+/).filter(Boolean);
  return terms.filter((t) => words.some((w) => w.startsWith(t))).length;
}

/**
 * Read a JSON list column that may be absent.
 *
 * Records written before these columns existed have NULL there, and a store
 * upgraded by the migration has NULL for every existing row. An empty list is
 * the honest reading: nothing was recorded, as against something recorded and
 * lost.
 */
function parseJsonList(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export class StrataRepository {
  private db: StrataDatabase;

  constructor(db: StrataDatabase) {
    this.db = db;
  }

  /**
   * Save or update a Strata Record and update its relational entries & FTS5 index.
   */
  public saveRecord(recordInput: StrataRecord): StrataRecord {
    const record = StrataRecordSchema.parse(recordInput);
    const rawDb = this.db.getRawDb();

    // 1. Insert/Replace main record
    const insertRecord = rawDb.prepare(`
      INSERT INTO records (
        id, schema_version, title, intent, intent_confidence,
        author_name, author_email, author_type,
        agent_name, agent_model, agent_provider, agent_tool,
        result_status, result_summary,
        memory_status, superseded_by, symbols,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        schema_version = excluded.schema_version,
        title = excluded.title,
        intent = excluded.intent,
        intent_confidence = excluded.intent_confidence,
        author_name = excluded.author_name,
        author_email = excluded.author_email,
        author_type = excluded.author_type,
        agent_name = excluded.agent_name,
        agent_model = excluded.agent_model,
        agent_provider = excluded.agent_provider,
        agent_tool = excluded.agent_tool,
        result_status = excluded.result_status,
        memory_status = excluded.memory_status,
        superseded_by = excluded.superseded_by,
        symbols = excluded.symbols,
        result_summary = excluded.result_summary,
        updated_at = excluded.updated_at
    `);

    insertRecord.run(
      record.id,
      record.schemaVersion,
      record.title,
      record.intent,
      record.intentConfidence,
      record.author.name,
      record.author.email ?? null,
      record.author.type,
      record.agent?.name ?? null,
      record.agent?.model ?? null,
      record.agent?.provider ?? null,
      record.agent?.tool ?? null,
      record.result.status,
      record.result.summary ?? null,
      record.status,
      record.supersededBy ?? null,
      JSON.stringify(record.symbols),
      record.createdAt,
      record.updatedAt
    );

    // 2. Refresh file changes
    rawDb.prepare(`DELETE FROM record_files WHERE record_id = ?`).run(record.id);
    const insertFile = rawDb.prepare(`
      INSERT INTO record_files (record_id, file_path, change_type, symbols_affected)
      VALUES (?, ?, ?, ?)
    `);
    for (const f of record.files) {
      insertFile.run(
        record.id,
        this.normalizePath(f.path),
        f.changeType,
        f.symbols ? JSON.stringify(f.symbols) : null
      );
    }

    // 3. Refresh attempts
    rawDb.prepare(`DELETE FROM record_attempts WHERE record_id = ?`).run(record.id);
    const insertAttempt = rawDb.prepare(`
      INSERT INTO record_attempts
        (record_id, sequence, approach, status, failure_reason, confidence, evidence, replaced_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    record.attempts.forEach((a, idx) => {
      insertAttempt.run(
        record.id,
        a.sequence ?? idx + 1,
        a.approach,
        a.status,
        a.failureReason ?? null,
        a.confidence,
        JSON.stringify(a.evidence),
        a.replacedBy ?? null
      );
    });

    // 4. Refresh evidence
    rawDb.prepare(`DELETE FROM record_evidence WHERE record_id = ?`).run(record.id);
    const insertEvidence = rawDb.prepare(`
      INSERT INTO record_evidence (record_id, evidence_type, reference, description, confidence)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const ev of record.evidence) {
      insertEvidence.run(
        record.id,
        ev.type,
        ev.reference,
        ev.description ?? null,
        ev.confidence
      );
    }

    // 5. Refresh consequences
    rawDb.prepare(`DELETE FROM record_consequences WHERE record_id = ?`).run(record.id);
    const insertConsequence = rawDb.prepare(`
      INSERT INTO record_consequences (record_id, description, confidence, evidence, created_at, stated_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const c of record.consequences) {
      insertConsequence.run(record.id, c.statement, c.confidence,
                            JSON.stringify(c.evidence), Date.now(), c.statedBy ?? null);
    }

    // 5b. Refresh constraints
    rawDb.prepare(`DELETE FROM record_constraints WHERE record_id = ?`).run(record.id);
    const insertConstraint = rawDb.prepare(`
      INSERT INTO record_constraints (record_id, statement, confidence, evidence, status, stated_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const c of record.constraints) {
      insertConstraint.run(record.id, c.statement, c.confidence,
                           JSON.stringify(c.evidence), c.status, c.statedBy ?? null);
    }

    // 5c. Refresh stated reasons
    rawDb.prepare(`DELETE FROM record_reasons WHERE record_id = ?`).run(record.id);
    const insertReason = rawDb.prepare(`
      INSERT INTO record_reasons (record_id, sequence, statement, confidence, evidence, stated_by, precedes_attempt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    record.reasons.forEach((r, idx) => {
      insertReason.run(record.id, idx + 1, r.statement, r.confidence, JSON.stringify(r.evidence),
                       r.statedBy ?? null, r.precedesAttempt ?? null);
    });

    // 6. Refresh FTS5 index
    rawDb.prepare(`DELETE FROM records_fts WHERE record_id = ?`).run(record.id);
    const insertFts = rawDb.prepare(`
      INSERT INTO records_fts (record_id, title, intent, attempts, files, result_summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const attemptsText = record.attempts.map((a) => `${a.approach} (${a.status})`).join(' ');
    const filesText = record.files.map((f) => f.path).join(' ');
    // Stated reasons are searched with the intent: both are the record's account of why.
    const whyText = [record.intent, ...record.reasons.map((r) => r.statement)].join(' ');
    insertFts.run(
      record.id,
      record.title,
      whyText,
      attemptsText,
      filesText,
      record.result.summary ?? ''
    );

    return record;
  }

  /**
   * Get a single record by its ID.
   */
  public getRecordById(id: string): StrataRecord | null {
    const rawDb = this.db.getRawDb();
    const row = rawDb.prepare(`SELECT * FROM records WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    return this.hydrateRecord(row);
  }

  /**
   * Get all Strata records ordered by newest first.
   */
  public getAllRecords(limit: number = 100, offset: number = 0): StrataRecord[] {
    const rawDb = this.db.getRawDb();
    const rows = rawDb.prepare(`
      SELECT * FROM records ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset) as Record<string, unknown>[];

    return rows.map((r) => this.hydrateRecord(r));
  }

  /**
   * Get all records that affected a specific file path.
   */
  public getRecordsByFile(filePath: string): StrataRecord[] {
    const rawDb = this.db.getRawDb();
    const normalized = this.normalizePath(filePath);

    const rows = rawDb.prepare(`
      SELECT r.* FROM records r
      JOIN record_files rf ON r.id = rf.record_id
      WHERE rf.file_path = ? OR rf.file_path LIKE ?
      ORDER BY r.created_at DESC
    `).all(normalized, `%/${normalized}`) as Record<string, unknown>[];

    return rows.map((r) => this.hydrateRecord(r));
  }

  /**
   * Get total number of records.
   */
  public getRecordCount(): number {
    const rawDb = this.db.getRawDb();
    const res = rawDb.prepare(`SELECT COUNT(*) as count FROM records`).get() as { count: number };
    return res.count;
  }

  /**
   * Search records with SQLite FTS5, best match first.
   *
   * FTS5 ANDs bare terms, so passing a whole task sentence as one MATCH matched nothing
   * once the sentence grew past a few words - a real task description scored zero hits
   * against a store that plainly contained the answer. Terms are OR-ed so a partial hit
   * still counts, and bm25 puts the record that matched most of them first. Each term is
   * quoted before the prefix operator so an FTS5 keyword appearing in the task text
   * ("near", "not") cannot be parsed as syntax.
   */
  public searchRecords(query: string, limit: number = 20): StrataRecord[] {
    if (!query.trim()) return [];
    const rawDb = this.db.getRawDb();

    const terms = tokenizeQuery(query);
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"*`).join(' OR ');

    const ranked = `
      SELECT record_id FROM records_fts
      WHERE records_fts MATCH ?
      ORDER BY bm25(records_fts)
      LIMIT ?
    `;
    const unranked = `
      SELECT record_id FROM records_fts WHERE records_fts MATCH ? LIMIT ?
    `;

    let rows: { record_id: string }[];
    try {
      rows = rawDb.prepare(ranked).all(match, limit) as { record_id: string }[];
    } catch {
      // bm25() needs a reasonably modern SQLite; fall back to unranked rather than
      // silently returning nothing, which is how this method used to fail.
      try {
        rows = rawDb.prepare(unranked).all(match, limit) as { record_id: string }[];
      } catch {
        return [];
      }
    }

    const required = Math.min(MIN_TERM_MATCHES, terms.length);
    const records: StrataRecord[] = [];
    for (const m of rows) {
      const rec = this.getRecordById(m.record_id);
      if (!rec) continue;
      if (countMatchingTerms(rec, terms) < required) continue;
      records.push(rec);
    }
    return records;
  }

  /**
   * Cache Git commits into the local database cache.
   */
  public saveGitCommits(commits: GitCommitRecord[]): void {
    const rawDb = this.db.getRawDb();
    const stmt = rawDb.prepare(`
      INSERT OR REPLACE INTO git_commits_cache (
        hash, short_hash, author_name, author_email, authored_at,
        committer_name, committer_email, committed_at, message, changed_files
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const c of commits) {
      stmt.run(
        c.hash,
        c.shortHash,
        c.authorName,
        c.authorEmail,
        c.authoredAt,
        c.committerName,
        c.committerEmail,
        c.committedAt,
        c.message,
        JSON.stringify(c.changedFiles)
      );
    }
    // The file -> commit edges are a projection of this table: any write leaves them stale.
    rawDb.prepare('DELETE FROM code_index_meta WHERE key = ?').run(COMMIT_EDGES_HEAD);
  }

  /**
   * Make the cache hold exactly *commits*, as one transaction.
   *
   * `saveGitCommits` only ever adds, which is right for seeding but wrong for a refresh:
   * a commit that left history (amended, rebased away, on a branch no longer checked
   * out) would stay cached, and every pack built from the cache would keep reporting it
   * as VERIFIED history. A refresh therefore replaces the table. Readers never see it
   * half-written: either the old cache or the new one.
   *
   * *head* is the commit the history was read from. It is stored with the cache, in the
   * same transaction, so a later refresh can tell from HEAD alone that nothing changed.
   * *complete* says the read reached the first commit: the cache is the whole history.
   */
  public replaceGitCommits(commits: GitCommitRecord[], head?: string, complete = false): void {
    const rawDb = this.db.getRawDb();
    rawDb.exec('BEGIN');
    try {
      rawDb.exec('DELETE FROM git_commits_cache');
      this.saveGitCommits(commits);
      if (head) this.setIndexMeta(COMMIT_CACHE_HEAD, head);
      this.setIndexMeta(COMMIT_CACHE_COMPLETE, complete ? '1' : '0');
      rawDb.exec('COMMIT');
    } catch (err) {
      rawDb.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Add commits read for *paths* (`GitClient.getFileHistory`) to the cache, with the
   * file -> commit edges for those paths, in one transaction.
   *
   * Unlike `saveGitCommits` this leaves the edges current: both halves are written here.
   * A commit already cached is left as it is. The next refresh replaces the cache with the
   * newest commits again and drops these; the next pack about the same files reads them back.
   *
   * A commit made before a path was renamed touched it under its old name; *pathThen*
   * (`GitClient.getTargetHistory`) gives that name, and the edge is written to the path as it
   * is now, which is what a request asks about.
   */
  public addFileHistory(commits: GitCommitRecord[], paths: string[],
                        pathThen: Map<string, Map<string, string>> = new Map()): number {
    if (!commits.length) return 0;
    // Edges only for the files the history was read for: a sync commit in Next.js touches
    // thousands of files, and every edge it brought was a row written on every prompt.
    const wanted = new Set(paths.map((p) => p.replace(/\\/g, '/')));
    const rawDb = this.db.getRawDb();
    const commit = rawDb.prepare(`
      INSERT OR IGNORE INTO git_commits_cache (
        hash, short_hash, author_name, author_email, authored_at,
        committer_name, committer_email, committed_at, message, changed_files
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const edge = rawDb.prepare(`INSERT OR IGNORE INTO code_file_commits
      (file_path, commit_hash, authored_at) VALUES (?, ?, ?)`);
    let added = 0;
    rawDb.exec('BEGIN');
    try {
      for (const c of commits) {
        added += Number(commit.run(c.hash, c.shortHash, c.authorName, c.authorEmail, c.authoredAt,
          c.committerName, c.committerEmail, c.committedAt, c.message, JSON.stringify(c.changedFiles)).changes);
        for (const f of c.changedFiles) {
          const file = f.replace(/\\/g, '/');
          if (wanted.has(file)) edge.run(file, c.hash, c.authoredAt);
        }
        for (const now of pathThen.get(c.hash)?.keys() ?? []) edge.run(now.replace(/\\/g, '/'), c.hash, c.authoredAt);
      }
      rawDb.exec('COMMIT');
    } catch (err) {
      rawDb.exec('ROLLBACK');
      throw err;
    }
    return added;
  }

  /**
   * Whether the cache holds the repository's whole history, so no file has a commit it
   * lacks. A store that never recorded it is taken as incomplete.
   */
  public commitCacheIsComplete(): boolean {
    return this.getIndexMeta(COMMIT_CACHE_COMPLETE) === '1';
  }

  /** The HEAD the commit cache was last read from, or null if it was never recorded. */
  public getCommitCacheHead(): string | null {
    return this.getIndexMeta(COMMIT_CACHE_HEAD);
  }

  /**
   * Whether the file -> commit edges were built from the cache as it stands.
   *
   * The edges are rebuilt by indexing, but the cache is also refreshed by `init`, which
   * builds no edges; comparing the two recorded HEADs catches that, where "the cache did
   * not change on this run" would not. A store that never recorded either is not current.
   */
  public commitEdgesAreCurrent(): boolean {
    const cache = this.getIndexMeta(COMMIT_CACHE_HEAD);
    return cache !== null && cache === this.getIndexMeta(COMMIT_EDGES_HEAD);
  }

  /** Record that the edges were just built from the cache as it stands. */
  public markCommitEdgesCurrent(): void {
    const cache = this.getIndexMeta(COMMIT_CACHE_HEAD);
    if (cache !== null) this.setIndexMeta(COMMIT_EDGES_HEAD, cache);
  }

  private getIndexMeta(key: string): string | null {
    const row = this.db.getRawDb().prepare('SELECT value FROM code_index_meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setIndexMeta(key: string, value: string): void {
    this.db.getRawDb().prepare(`INSERT INTO code_index_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  /**
   * Get cached Git commits for a specific file path.
   */
  public getGitCommitsByFile(filePath: string, limit: number = 50): GitCommitRecord[] {
    const rawDb = this.db.getRawDb();
    const normalized = this.normalizePath(filePath);

    const rows = rawDb.prepare(`
      SELECT * FROM git_commits_cache
      ORDER BY authored_at DESC
    `).all() as Record<string, unknown>[];

    const results: GitCommitRecord[] = [];
    for (const row of rows) {
      const changedFiles: string[] = JSON.parse(row['changed_files'] as string);
      const matches = changedFiles.some(
        (f) => this.normalizePath(f) === normalized || f.endsWith(`/${normalized}`) || f.endsWith(`\\${normalized}`)
      );
      if (matches) {
        results.push(this.hydrateCommit(row, changedFiles));
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  /**
   * Look up one cached commit by full or abbreviated hash.
   *
   * Records cite commits at whatever length their author wrote them. Without this, a
   * consumer holding an evidence reference has no way to turn it into anything readable
   * and has to shell out to `git show` - which is exactly the round trip the cache exists
   * to avoid. A miss returns null so the caller can drop the reference rather than emit a
   * bare hash.
   */
  public getCommitByHash(hash: string): GitCommitRecord | null {
    const h = hash.trim().toLowerCase();
    if (!/^[0-9a-f]{4,40}$/.test(h)) return null;

    const rawDb = this.db.getRawDb();
    const row = rawDb.prepare(`
      SELECT * FROM git_commits_cache
      WHERE hash = ? OR short_hash = ? OR hash LIKE ?
      LIMIT 1
    `).get(h, h, `${h}%`) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.hydrateCommit(row, JSON.parse(row['changed_files'] as string));
  }

  /**
   * Get total number of cached Git commits.
   */
  public getGitCommitCount(): number {
    const rawDb = this.db.getRawDb();
    const res = rawDb.prepare(`SELECT COUNT(*) as count FROM git_commits_cache`).get() as { count: number };
    return res.count;
  }

  private hydrateCommit(row: Record<string, unknown>, changedFiles: string[]): GitCommitRecord {
    return GitCommitRecordSchema.parse({
      hash: row['hash'],
      shortHash: row['short_hash'],
      authorName: row['author_name'],
      authorEmail: row['author_email'],
      authoredAt: row['authored_at'],
      committerName: row['committer_name'],
      committerEmail: row['committer_email'],
      committedAt: row['committed_at'],
      message: row['message'],
      changedFiles,
    });
  }

  private hydrateRecord(row: Record<string, unknown>): StrataRecord {
    const rawDb = this.db.getRawDb();
    const id = row['id'] as string;

    // Fetch files
    const fileRows = rawDb.prepare(`
      SELECT file_path, change_type, symbols_affected FROM record_files WHERE record_id = ?
    `).all(id) as Record<string, unknown>[];

    const files: FileChange[] = fileRows.map((f) => ({
      path: f['file_path'] as string,
      changeType: f['change_type'] as FileChange['changeType'],
      symbols: f['symbols_affected'] ? JSON.parse(f['symbols_affected'] as string) : undefined,
    }));

    // Fetch attempts
    const attemptRows = rawDb.prepare(`
      SELECT sequence, approach, status, failure_reason, confidence, evidence, replaced_by
      FROM record_attempts WHERE record_id = ? ORDER BY sequence ASC
    `).all(id) as Record<string, unknown>[];

    const attempts: Attempt[] = attemptRows.map((a) => ({
      sequence: a['sequence'] as number,
      approach: a['approach'] as string,
      status: a['status'] as Attempt['status'],
      failureReason: (a['failure_reason'] as string) || undefined,
      confidence: a['confidence'] as Attempt['confidence'],
      evidence: parseJsonList(a['evidence']),
      replacedBy: (a['replaced_by'] as string) || undefined,
    }));

    // Fetch evidence
    const evidenceRows = rawDb.prepare(`
      SELECT evidence_type, reference, description, confidence FROM record_evidence WHERE record_id = ?
    `).all(id) as Record<string, unknown>[];

    const evidence: Evidence[] = evidenceRows.map((e) => ({
      type: e['evidence_type'] as Evidence['type'],
      reference: e['reference'] as string,
      description: (e['description'] as string) || undefined,
      confidence: e['confidence'] as Evidence['confidence'],
    }));

    // Fetch consequences
    const consequenceRows = rawDb.prepare(`
      SELECT description, confidence, evidence, stated_by FROM record_consequences
      WHERE record_id = ? ORDER BY created_at ASC, id ASC
    `).all(id) as Record<string, unknown>[];

    const consequences: Consequence[] = consequenceRows.map((c) => ({
      statement: c['description'] as string,
      confidence: (c['confidence'] as Consequence['confidence']) ?? 'DECLARED',
      evidence: parseJsonList(c['evidence']),
      ...(c['stated_by'] ? { statedBy: c['stated_by'] as string } : {}),
    }));

    // Fetch constraints
    const constraintRows = rawDb.prepare(`
      SELECT statement, confidence, evidence, status, stated_by FROM record_constraints
      WHERE record_id = ? ORDER BY id ASC
    `).all(id) as Record<string, unknown>[];

    const constraints: Constraint[] = constraintRows.map((c) => ({
      statement: c['statement'] as string,
      confidence: (c['confidence'] as Constraint['confidence']) ?? 'DECLARED',
      evidence: parseJsonList(c['evidence']),
      status: (c['status'] as Constraint['status']) ?? 'UNKNOWN',
      ...(c['stated_by'] ? { statedBy: c['stated_by'] as string } : {}),
    }));

    // Fetch stated reasons
    const reasonRows = rawDb.prepare(`
      SELECT statement, confidence, evidence, stated_by, precedes_attempt FROM record_reasons
      WHERE record_id = ? ORDER BY sequence ASC
    `).all(id) as Record<string, unknown>[];

    const reasons: StatedReason[] = reasonRows.map((r) => ({
      statement: r['statement'] as string,
      confidence: (r['confidence'] as StatedReason['confidence']) ?? 'DECLARED',
      evidence: parseJsonList(r['evidence']),
      ...(r['stated_by'] ? { statedBy: r['stated_by'] as string } : {}),
      ...(r['precedes_attempt'] ? { precedesAttempt: Number(r['precedes_attempt']) } : {}),
    }));

    return StrataRecordSchema.parse({
      id,
      schemaVersion: row['schema_version'],
      title: row['title'],
      intent: row['intent'],
      intentConfidence: row['intent_confidence'],
      author: {
        name: row['author_name'],
        email: (row['author_email'] as string) || undefined,
        type: row['author_type'],
      },
      agent: row['agent_name']
        ? {
            name: row['agent_name'] as string,
            model: (row['agent_model'] as string) || undefined,
            provider: (row['agent_provider'] as string) || undefined,
            tool: (row['agent_tool'] as string) || undefined,
          }
        : undefined,
      files,
      attempts,
      evidence,
      consequences,
      constraints,
      reasons,
      symbols: parseJsonList(row['symbols']),
      status: (row['memory_status'] as StrataRecord['status']) ?? 'UNKNOWN',
      supersededBy: (row['superseded_by'] as string) || undefined,
      result: {
        status: row['result_status'],
        summary: (row['result_summary'] as string) || undefined,
      },
      createdAt: row['created_at'],
      updatedAt: row['updated_at'],
    });
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '');
  }
}
