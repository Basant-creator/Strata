import { StrataRepository } from '../storage/repository.js';
import { StrataRecord, GitCommitRecord } from '../schema/types.js';

export interface FileHistoryTimelineItem {
  type: 'strata_record' | 'git_commit';
  id: string;
  timestamp: number;
  author: string;
  agent?: string;
  titleOrMessage: string;
  intent?: string;
  intentConfidence?: 'VERIFIED' | 'DECLARED' | 'INFERRED' | 'UNKNOWN';
  record?: StrataRecord;
  commit?: GitCommitRecord;
}

export interface FileHistoryResult {
  filePath: string;
  totalRecords: number;
  totalCommits: number;
  timeline: FileHistoryTimelineItem[];
}

export class HistoryRetriever {
  private repo: StrataRepository;

  constructor(repo: StrataRepository) {
    this.repo = repo;
  }

  /**
   * Retrieve structured history for a given file.
   */
  public getFileHistory(filePath: string): FileHistoryResult {
    const records = this.repo.getRecordsByFile(filePath);
    const commits = this.repo.getGitCommitsByFile(filePath);

    const timeline: FileHistoryTimelineItem[] = [];

    // Track commit hashes already associated as evidence in Strata records
    const linkedCommitHashes = new Set<string>();

    for (const r of records) {
      for (const ev of r.evidence) {
        if (ev.type === 'git_commit') {
          linkedCommitHashes.add(ev.reference);
        }
      }

      timeline.push({
        type: 'strata_record',
        id: r.id,
        timestamp: r.createdAt,
        author: r.author.name,
        agent: r.agent ? `${r.agent.name}${r.agent.model ? ` (${r.agent.model})` : ''}` : undefined,
        titleOrMessage: r.title,
        intent: r.intent,
        intentConfidence: r.intentConfidence,
        record: r,
      });
    }

    for (const c of commits) {
      // Include Git commit if not already represented in a Strata record or if it adds historical baseline
      timeline.push({
        type: 'git_commit',
        id: c.shortHash,
        timestamp: c.authoredAt,
        author: c.authorName,
        titleOrMessage: c.message.split('\n')[0] || '',
        commit: c,
      });
    }

    // Sort descending by timestamp
    timeline.sort((a, b) => b.timestamp - a.timestamp);

    return {
      filePath,
      totalRecords: records.length,
      totalCommits: commits.length,
      timeline,
    };
  }
}
