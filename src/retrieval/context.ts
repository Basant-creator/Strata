import { StrataRepository } from '../storage/repository.js';
import { StrataRecord } from '../schema/types.js';

export interface TaskContextDigest {
  task: string;
  relevantFiles: string[];
  relevantRecords: string[];
  intents: string[];
  failedAttempts: { approach: string; reason?: string }[];
  successfulApproaches: string[];
  consequencesAndConstraints: string[];
  evidenceReferences: string[];
  formattedContext: string;
}

/**
 * How many records a single digest may carry.
 *
 * The point of this tool is to end a search, not to widen one. Three records is enough to
 * cover a task that spans two areas and few enough that nothing irrelevant rides along.
 */
const MAX_RECORDS = 3;

/**
 * A record must score at least this fraction of the best match to be included.
 *
 * Absolute thresholds do not survive a change of corpus size; a relative floor asks the
 * only question that matters - "is this nearly as relevant as the best thing we found?"
 */
const RELEVANCE_FLOOR = 0.4;

/** Commit lines per record, so a heavily-evidenced record cannot dominate the digest. */
const MAX_COMMITS_PER_RECORD = 6;

/** Commit subjects are titles, not prose; anything longer is a paragraph in disguise. */
const MAX_SUBJECT_CHARS = 90;

interface ScoredRecord {
  record: StrataRecord;
  score: number;
}

export class ContextRetriever {
  private repo: StrataRepository;

  constructor(repo: StrataRepository) {
    this.repo = repo;
  }

  /**
   * Retrieve minimum sufficient development context for a given task description or file list.
   *
   * Two rules govern the output, both learned from measurement:
   *
   * 1. Never emit a reference the reader has to go and resolve. A bare commit hash reads
   *    as a task, and an agent will spend a tool call on it - fetching data this database
   *    already holds. Anything that cannot be resolved is dropped instead.
   * 2. Return nothing rather than something irrelevant. A tool that always answers trains
   *    its caller to always ask, and to always pay for the asking.
   */
  public getTaskContext(task: string, targetFiles: string[] = []): TaskContextDigest {
    const selected = this.selectRecords(task, targetFiles);

    if (selected.length === 0) {
      return this.emptyDigest(task, targetFiles);
    }

    const relevantFilesSet = new Set<string>(targetFiles);
    const relevantRecords: string[] = [];
    const intents: string[] = [];
    const failedAttempts: { approach: string; reason?: string }[] = [];
    const successfulApproaches: string[] = [];
    const consequencesAndConstraints: string[] = [];
    const evidenceReferences: string[] = [];

    for (const r of selected) {
      relevantRecords.push(r.id);
      intents.push(`[${r.id}] ${r.intent} (${r.intentConfidence})`);

      for (const f of r.files) relevantFilesSet.add(f.path);

      for (const a of r.attempts) {
        if (a.status === 'failed' || a.status === 'abandoned') {
          failedAttempts.push({ approach: a.approach, reason: a.failureReason });
        } else if (a.status === 'succeeded') {
          successfulApproaches.push(a.approach);
        }
      }

      for (const c of r.consequences) consequencesAndConstraints.push(c.statement);
      // Constraints are a separate kind of knowledge and are labelled as such.
      for (const c of r.constraints) consequencesAndConstraints.push(`CONSTRAINT: ${c.statement}`);
      for (const ev of r.evidence) evidenceReferences.push(`${ev.type}:${ev.reference}`);
    }

    return {
      task,
      relevantFiles: Array.from(relevantFilesSet),
      relevantRecords,
      intents,
      failedAttempts,
      successfulApproaches,
      consequencesAndConstraints,
      evidenceReferences,
      formattedContext: this.render(task, selected),
    };
  }

  /**
   * Rank candidate records and keep only those close to the best match.
   *
   * Text relevance is weighted above file overlap on purpose: a caller passing a list of
   * "relevant files" is guessing, and one wrong guess used to be enough to drag an
   * unrelated record - and all of its constraints - into the answer.
   */
  private selectRecords(task: string, targetFiles: string[]): StrataRecord[] {
    const scores = new Map<string, ScoredRecord>();

    const ftsHits = task.trim() ? this.repo.searchRecords(task, 10) : [];
    ftsHits.forEach((record, i) => {
      // Best hit scores 1.0, decaying with rank.
      const ftsScore = (ftsHits.length - i) / ftsHits.length;
      scores.set(record.id, { record, score: 2 * ftsScore });
    });

    for (const f of targetFiles) {
      for (const record of this.repo.getRecordsByFile(f)) {
        const existing = scores.get(record.id);
        const bump = 1 / Math.max(1, targetFiles.length);
        if (existing) {
          existing.score += bump;
        } else {
          scores.set(record.id, { record, score: bump });
        }
      }
    }

    const ranked = Array.from(scores.values()).sort((a, b) => b.score - a.score);
    if (ranked.length === 0) return [];

    const topScore = ranked[0]!.score;
    return ranked
      .filter((s) => s.score >= topScore * RELEVANCE_FLOOR)
      .slice(0, MAX_RECORDS)
      .map((s) => s.record);
  }

  private emptyDigest(task: string, targetFiles: string[]): TaskContextDigest {
    return {
      task,
      relevantFiles: [...targetFiles],
      relevantRecords: [],
      intents: [],
      failedAttempts: [],
      successfulApproaches: [],
      consequencesAndConstraints: [],
      evidenceReferences: [],
      formattedContext:
        'No recorded Strata context for this task. Nothing has been written about this ' +
        'area, so proceed from the code itself.',
    };
  }

  /**
   * Render one block per record.
   *
   * Flattening every record into shared lists used to lose which decision each constraint
   * belonged to, so a warning about one subsystem read as a warning about the one being
   * edited. Keeping records whole costs a few tokens and keeps every claim attributable.
   */
  private render(task: string, records: StrataRecord[]): string {
    const lines: string[] = [`### Strata context for: "${task}"`];

    for (const r of records) {
      lines.push('');
      lines.push(`**${r.id} - ${r.title}** (${r.intentConfidence})`);
      lines.push(r.intent);

      const failed = r.attempts.filter((a) => a.status === 'failed' || a.status === 'abandoned');
      for (const a of failed) {
        lines.push(
          `- Past Failed Attempts (DO NOT REPEAT): ${a.approach}` +
            (a.failureReason ? ` - ${a.failureReason}` : '')
        );
      }

      for (const a of r.attempts.filter((x) => x.status === 'succeeded')) {
        lines.push(`- Proven: ${a.approach}`);
      }

      // A consequence and a constraint are different claims: one is what a change
      // left behind, the other is what the next change still has to respect. The
      // digest used to print both under "Constraint", which made a recorded effect
      // read as a rule.
      for (const c of r.consequences) {
        lines.push(`- Consequence (${c.confidence}): ${c.statement}`);
      }
      for (const c of r.constraints) {
        const status = c.status === 'UNKNOWN' ? '' : ` [${c.status}]`;
        lines.push(`- Constraint${status} (${c.confidence}): ${c.statement}`);
      }

      // A record whose intent already narrates a commit does not need it listed again;
      // the reference is resolved either way, and repeating it is pure width.
      const commits = this.resolveCommits(r, lines.join('\n'));
      if (commits.length > 0) {
        lines.push(`- Commits: ${commits.join(' | ')}`);
      }

      const other = r.evidence
        .filter((e) => e.type !== 'git_commit')
        .map((e) => `${e.type} ${e.reference}${e.description ? ` (${e.description})` : ''}`);
      if (other.length > 0) {
        lines.push(`- Evidence: ${other.join(', ')}`);
      }

      const files = r.files.map((f) => f.path);
      if (files.length > 0) {
        lines.push(`- Files: ${files.join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Turn this record's commit evidence into readable lines, dropping what cannot be read.
   *
   * A hash the cache does not know is worse than no line at all: it names something the
   * reader can only obtain by leaving and running git. `alreadySaid` is the text rendered
   * for this record so far; a commit whose subject appears there is skipped.
   */
  private resolveCommits(record: StrataRecord, alreadySaid = ''): string[] {
    const out: string[] = [];
    const seen = new Set<string>();

    for (const ev of record.evidence) {
      if (ev.type !== 'git_commit') continue;
      if (out.length >= MAX_COMMITS_PER_RECORD) break;

      const commit = this.repo.getCommitByHash(ev.reference);
      if (!commit) continue;
      if (seen.has(commit.hash)) continue;
      seen.add(commit.hash);

      const subject = (commit.message.split('\n')[0] ?? '').trim();
      if (!subject) continue;
      if (alreadySaid.includes(subject)) continue;

      const trimmed =
        subject.length > MAX_SUBJECT_CHARS
          ? `${subject.slice(0, MAX_SUBJECT_CHARS - 1)}...`
          : subject;
      out.push(`${commit.shortHash} "${trimmed}"`);
    }

    return out;
  }
}
