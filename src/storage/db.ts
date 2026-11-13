import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AttemptStatusSchema } from '../schema/types.js';

/** The attempt statuses the table accepts, from the schema, so the two cannot drift. */
const ATTEMPT_STATUSES = AttemptStatusSchema.options.map((s) => `'${s}'`).join(', ');

export const STRATA_DIR_NAME = '.strata';
export const STRATA_DB_NAME = 'strata.db';

export interface StrataDatabaseOptions {
  dbPath?: string;
  repoRoot?: string;
}

export class StrataDatabase {
  private db: DatabaseSync;
  private strataDir: string;
  private dbPath: string;

  constructor(options: StrataDatabaseOptions = {}) {
    if (options.dbPath) {
      this.dbPath = options.dbPath;
      this.strataDir = path.dirname(this.dbPath);
    } else {
      const repoRoot = options.repoRoot || process.cwd();
      this.strataDir = path.join(repoRoot, STRATA_DIR_NAME);
      this.dbPath = path.join(this.strataDir, STRATA_DB_NAME);
    }

    // Ensure directory exists if not in-memory
    if (this.dbPath !== ':memory:') {
      fs.mkdirSync(this.strataDir, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);
    this.initDatabase();
  }

  public getRawDb(): DatabaseSync {
    return this.db;
  }

  public getDbPath(): string {
    return this.dbPath;
  }

  public getStrataDir(): string {
    return this.strataDir;
  }

  public close(): void {
    this.db.close();
  }

  private initDatabase(): void {
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (this.dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      // The prompt hook writes (it refreshes the index) while `strata index`, the MCP
      // server or another session may be writing too. Wait out a short transaction
      // instead of failing at once with "database is locked".
      this.db.exec('PRAGMA busy_timeout = 2000;');
    }

    // Initialize core schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL DEFAULT '0.1.0',
        title TEXT NOT NULL,
        intent TEXT NOT NULL,
        intent_confidence TEXT NOT NULL CHECK(intent_confidence IN ('VERIFIED', 'DECLARED', 'INFERRED', 'UNKNOWN')),
        author_name TEXT NOT NULL,
        author_email TEXT,
        author_type TEXT NOT NULL CHECK(author_type IN ('human', 'agent', 'system')),
        agent_name TEXT,
        agent_model TEXT,
        agent_provider TEXT,
        agent_tool TEXT,
        result_status TEXT NOT NULL CHECK(result_status IN ('success', 'failure', 'partial', 'in_progress', 'unknown')),
        result_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS record_files (
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        change_type TEXT NOT NULL CHECK(change_type IN ('add', 'modify', 'delete', 'rename')),
        symbols_affected TEXT,
        PRIMARY KEY (record_id, file_path)
      );

      CREATE INDEX IF NOT EXISTS idx_record_files_path ON record_files(file_path);

      CREATE TABLE IF NOT EXISTS record_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        approach TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (${ATTEMPT_STATUSES})),
        failure_reason TEXT,
        confidence TEXT NOT NULL CHECK(confidence IN ('VERIFIED', 'DECLARED', 'INFERRED', 'UNKNOWN'))
      );

      CREATE TABLE IF NOT EXISTS record_reasons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        statement TEXT NOT NULL,
        confidence TEXT NOT NULL CHECK(confidence IN ('VERIFIED', 'DECLARED', 'INFERRED', 'UNKNOWN')),
        evidence TEXT,
        stated_by TEXT,
        precedes_attempt INTEGER
      );

      CREATE TABLE IF NOT EXISTS record_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        evidence_type TEXT NOT NULL CHECK(evidence_type IN ('git_commit', 'diff', 'test_run', 'issue', 'benchmark', 'log', 'other')),
        reference TEXT NOT NULL,
        description TEXT,
        confidence TEXT NOT NULL CHECK(confidence IN ('VERIFIED', 'DECLARED', 'INFERRED', 'UNKNOWN'))
      );

      CREATE TABLE IF NOT EXISTS record_consequences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        related_record_id TEXT REFERENCES records(id),
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS record_constraints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        statement TEXT NOT NULL,
        confidence TEXT NOT NULL CHECK(confidence IN ('VERIFIED', 'DECLARED', 'INFERRED', 'UNKNOWN')),
        evidence TEXT,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'SUPERSEDED', 'UNKNOWN'))
      );

      CREATE TABLE IF NOT EXISTS git_commits_cache (
        hash TEXT PRIMARY KEY,
        short_hash TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_email TEXT NOT NULL,
        authored_at INTEGER NOT NULL,
        committer_name TEXT NOT NULL,
        committer_email TEXT NOT NULL,
        committed_at INTEGER NOT NULL,
        message TEXT NOT NULL,
        changed_files TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
        record_id UNINDEXED,
        title,
        intent,
        attempts,
        files,
        result_summary
      );
    `);

    this.initCodeGraphSchema();
  }

  /**
   * Schema for the code graph the context engine expands over.
   *
   * Separate from the core schema because it is *derived*: everything here can be
   * rebuilt from the working tree and the commit cache by `strata index`, whereas
   * records are authored and cannot. Dropping these tables loses no information.
   *
   * Every statement is `IF NOT EXISTS`, so an existing store gains the tables on the
   * next open and keeps its records untouched.
   */
  private initCodeGraphSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_files (
        path TEXT PRIMARY KEY,
        language TEXT NOT NULL,
        -- Hash of file bytes. Incremental indexing reindexes a file only when this moves.
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        symbol_count INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS code_symbols (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL REFERENCES code_files(path) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0,
        -- Always VERIFIED: a declaration node in the AST, not a guess.
        confidence TEXT NOT NULL DEFAULT 'VERIFIED'
      );
      CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(name);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(file_path);

      CREATE TABLE IF NOT EXISTS code_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_file TEXT NOT NULL REFERENCES code_files(path) ON DELETE CASCADE,
        specifier TEXT NOT NULL,
        -- NULL when the specifier does not resolve to a file inside this repository
        -- (a package import, or a path that does not exist). Never guessed.
        to_file TEXT,
        resolution TEXT NOT NULL,
        line INTEGER NOT NULL,
        UNIQUE(from_file, specifier, line)
      );
      CREATE INDEX IF NOT EXISTS idx_code_imports_from ON code_imports(from_file);
      CREATE INDEX IF NOT EXISTS idx_code_imports_to ON code_imports(to_file);

      CREATE TABLE IF NOT EXISTS code_references (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_file TEXT NOT NULL REFERENCES code_files(path) ON DELETE CASCADE,
        symbol_name TEXT NOT NULL,
        -- Only ever set when the name is bound by an import in this file or declared
        -- in it. A bare name that matches a symbol elsewhere is NOT linked: that would
        -- be inferring a call graph from naming, which this schema refuses to store.
        to_file TEXT,
        to_symbol_id TEXT,
        line INTEGER NOT NULL,
        kind TEXT NOT NULL,
        confidence TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_code_refs_from ON code_references(from_file);
      CREATE INDEX IF NOT EXISTS idx_code_refs_to ON code_references(to_file);
      CREATE INDEX IF NOT EXISTS idx_code_refs_name ON code_references(symbol_name);

      -- Denormalised file -> commit edge, built from git_commits_cache at index time.
      -- The cache stores changed_files as a JSON blob, so answering "which commits
      -- touched this file" without this table means scanning and parsing every row.
      CREATE TABLE IF NOT EXISTS code_file_commits (
        file_path TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        authored_at INTEGER NOT NULL,
        PRIMARY KEY (file_path, commit_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_code_file_commits_path ON code_file_commits(file_path);

      CREATE TABLE IF NOT EXISTS code_index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.migrate();
  }

  /**
   * Bring an existing store up to the current column set.
   *
   * `CREATE TABLE IF NOT EXISTS` covers a fresh database and does nothing at all
   * for one that already exists, so a field added to an existing table would be
   * accepted by the schema, written by the service, and silently dropped on the
   * way to disk — memory that vanishes on restart, which is worse than memory
   * that was never offered.
   *
   * Each step is idempotent and checked against `PRAGMA table_info`, so running
   * it on an up-to-date store costs one query per table and changes nothing.
   */
  private migrate(): void {
    const columns = (table: string): Set<string> => {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      return new Set(rows.map((r) => r.name));
    };
    const add = (table: string, column: string, definition: string): void => {
      if (columns(table).has(column)) return;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };

    // Development memory, added in the memory phase. Defaults match the schema's
    // own defaults so a record written before these existed reads back unchanged
    // rather than acquiring a status nobody claimed.
    add('records', 'memory_status', `TEXT NOT NULL DEFAULT 'UNKNOWN'`);
    add('records', 'superseded_by', 'TEXT');
    add('records', 'symbols', 'TEXT');
    add('record_attempts', 'evidence', 'TEXT');
    add('record_attempts', 'replaced_by', 'TEXT');
    add('record_consequences', 'confidence', `TEXT NOT NULL DEFAULT 'DECLARED'`);
    add('record_consequences', 'evidence', 'TEXT');
    // Who stated a constraint or consequence, where the record knows (automatic memory).
    add('record_constraints', 'stated_by', 'TEXT');
    add('record_consequences', 'stated_by', 'TEXT');

    this.widenAttemptStatuses();
  }

  /**
   * Let an existing store hold the `partial` and `unknown` attempt statuses.
   *
   * SQLite cannot alter a CHECK constraint, so a store created before the statuses
   * existed would accept the record from the schema and then reject the row: the
   * attempt the transcript showed would fail to save. The table is rebuilt once, in a
   * transaction, keeping every row and id; a store that already allows the statuses
   * is detected from its own table definition and left alone.
   */
  private widenAttemptStatuses(): void {
    const row = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'record_attempts'`,
    ).get() as { sql: string } | undefined;
    if (!row || row.sql.includes(`'partial'`)) return;

    const columns = (this.db.prepare('PRAGMA table_info(record_attempts)').all() as { name: string }[])
      .map((c) => c.name);
    const list = columns.join(', ');
    this.db.exec('BEGIN');
    try {
      this.db.exec(`
        CREATE TABLE record_attempts_widened (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          approach TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (${ATTEMPT_STATUSES})),
          failure_reason TEXT,
          confidence TEXT NOT NULL CHECK(confidence IN ('VERIFIED', 'DECLARED', 'INFERRED', 'UNKNOWN')),
          evidence TEXT,
          replaced_by TEXT
        );
        INSERT INTO record_attempts_widened (${list}) SELECT ${list} FROM record_attempts;
        DROP TABLE record_attempts;
        ALTER TABLE record_attempts_widened RENAME TO record_attempts;
      `);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
