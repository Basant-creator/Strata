import { StrataRepository } from '../storage/repository.js';
import { StrataRecord, ConfidenceLevel } from '../schema/types.js';

export interface ExplanationSection {
  title: string;
  content: string;
  confidence: ConfidenceLevel;
}

export interface FileExplanation {
  filePath: string;
  overallConfidence: ConfidenceLevel;
  why: {
    intent: string;
    confidence: ConfidenceLevel;
  };
  who: {
    authors: string[];
    agents: string[];
    confidence: ConfidenceLevel;
  };
  how: {
    approaches: { approach: string; status: string; failureReason?: string; confidence: ConfidenceLevel }[];
  };
  result: {
    status: string;
    summary?: string;
    confidence: ConfidenceLevel;
  };
  consequences: string[];
  evidence: {
    type: string;
    reference: string;
    description?: string;
    confidence: ConfidenceLevel;
  }[];
  recordsCited: string[];
  rawText: string;
}

export class FileExplainer {
  private repo: StrataRepository;

  constructor(repo: StrataRepository) {
    this.repo = repo;
  }

  /**
   * Produce a concise, evidence-backed explanation for a given file.
   */
  public explainFile(filePath: string): FileExplanation {
    const strataRecords = this.repo.getRecordsByFile(filePath);
    const gitCommits = this.repo.getGitCommitsByFile(filePath);

    if (strataRecords.length === 0 && gitCommits.length === 0) {
      return this.generateUnknownExplanation(filePath);
    }

    if (strataRecords.length === 0 && gitCommits.length > 0) {
      return this.generateGitOnlyExplanation(filePath, gitCommits);
    }

    // Combine knowledge from Strata records
    return this.generateStrataExplanation(filePath, strataRecords, gitCommits);
  }

  private generateUnknownExplanation(filePath: string): FileExplanation {
    const rawText = [
      `# Strata Provenance Explanation: ${filePath}`,
      ``,
      `[CONFIDENCE: UNKNOWN]`,
      `UNKNOWN: No recorded evidence or Git history explains the existence or motivation of this file.`,
    ].join('\n');

    return {
      filePath,
      overallConfidence: 'UNKNOWN',
      why: {
        intent: 'UNKNOWN: No recorded evidence explains the original motivation.',
        confidence: 'UNKNOWN',
      },
      who: {
        authors: [],
        agents: [],
        confidence: 'UNKNOWN',
      },
      how: {
        approaches: [],
      },
      result: {
        status: 'unknown',
        confidence: 'UNKNOWN',
      },
      consequences: [],
      evidence: [],
      recordsCited: [],
      rawText,
    };
  }

  private generateGitOnlyExplanation(filePath: string, commits: import('../schema/types.js').GitCommitRecord[]): FileExplanation {
    const latest = commits[0]!;
    const authors = Array.from(new Set(commits.map((c) => c.authorName)));
    const commitHashes = commits.map((c) => c.shortHash);

    const rawText = [
      `# Strata Provenance Explanation: ${filePath}`,
      ``,
      `[CONFIDENCE: INFERRED (from Git history)]`,
      ``,
      `## WHO [VERIFIED]`,
      `- Authors: ${authors.join(', ')}`,
      `- Agents: None recorded (UNKNOWN)`,
      ``,
      `## WHAT & WHY [INFERRED from Commit Messages]`,
      `- Latest commit [${latest.shortHash}]: ${latest.message.split('\n')[0]}`,
      `- Total commits affecting this file: ${commits.length}`,
      `- Note: No rich Strata record was explicitly captured for this file. Rationale is inferred solely from Git commit logs.`,
      ``,
      `## EVIDENCE [VERIFIED]`,
      ...commitHashes.slice(0, 5).map((h) => `- Git commit: ${h}`),
    ].join('\n');

    return {
      filePath,
      overallConfidence: 'INFERRED',
      why: {
        intent: `Inferred from commit [${latest.shortHash}]: ${latest.message.split('\n')[0]}`,
        confidence: 'INFERRED',
      },
      who: {
        authors,
        agents: [],
        confidence: 'VERIFIED',
      },
      how: {
        approaches: [],
      },
      result: {
        status: 'unknown',
        summary: 'Git commits exist, but no explicit test/result record was captured.',
        confidence: 'UNKNOWN',
      },
      consequences: [],
      evidence: commits.slice(0, 5).map((c) => ({
        type: 'git_commit',
        reference: c.hash,
        description: c.message.split('\n')[0],
        confidence: 'VERIFIED' as const,
      })),
      recordsCited: [],
      rawText,
    };
  }

  private generateStrataExplanation(
    filePath: string,
    records: StrataRecord[],
    gitCommits: import('../schema/types.js').GitCommitRecord[]
  ): FileExplanation {
    // Primary record is the most recent one touching the file
    const primary = records[0]!;
    const allAuthors = Array.from(new Set(records.map((r) => r.author.name)));
    const allAgents: string[] = [];
    for (const r of records) {
      if (r.agent?.name) {
        allAgents.push(`${r.agent.name}${r.agent.model ? ` (${r.agent.model})` : ''}`);
      }
    }
    const uniqueAgents = Array.from(new Set(allAgents));

    // Aggregate attempts across records
    const allApproaches = records.flatMap((r) => r.attempts);

    // Aggregate evidence
    const allEvidence = records.flatMap((r) => r.evidence);

    // Aggregate consequences
    const allConsequences = records.flatMap((r) => r.consequences.map((c) => c.statement));

    // Determine overall confidence
    const overallConfidence: ConfidenceLevel = records.some((r) => r.intentConfidence === 'VERIFIED')
      ? 'VERIFIED'
      : primary.intentConfidence;

    const lines: string[] = [
      `# Strata Provenance Explanation: ${filePath}`,
      ``,
      `[OVERALL CONFIDENCE: ${overallConfidence}]`,
      ``,
      `## WHY (Intent) [${primary.intentConfidence}]`,
      `> ${primary.intent}`,
      ``,
      `## WHO [VERIFIED / DECLARED]`,
      `- Author(s): ${allAuthors.join(', ')}`,
      ...(uniqueAgents.length > 0 ? [`- Assisted by: ${uniqueAgents.join(', ')} [DECLARED]`] : []),
      ``,
    ];

    if (allApproaches.length > 0) {
      lines.push(`## HOW (Attempts & Decisions)`);
      for (const a of allApproaches) {
        const statusBadge = a.status.toUpperCase();
        const reason = a.failureReason ? ` -> ${a.failureReason}` : '';
        lines.push(`- [${statusBadge}] ${a.approach}${reason} [${a.confidence}]`);
      }
      lines.push(``);
    }

    lines.push(`## RESULT [${primary.result.status.toUpperCase()}]`);
    lines.push(`- Status: ${primary.result.status}`);
    if (primary.result.summary) {
      lines.push(`- Details: ${primary.result.summary}`);
    }
    lines.push(``);

    if (allConsequences.length > 0) {
      lines.push(`## CONSEQUENCES & CONSTRAINTS`);
      for (const c of allConsequences) {
        lines.push(`- ${c}`);
      }
      lines.push(``);
    }

    if (allEvidence.length > 0 || gitCommits.length > 0) {
      lines.push(`## EVIDENCE [VERIFIED]`);
      for (const ev of allEvidence) {
        lines.push(`- ${ev.type}: ${ev.reference}${ev.description ? ` (${ev.description})` : ''} [${ev.confidence}]`);
      }
      if (allEvidence.length === 0 && gitCommits.length > 0) {
        for (const c of gitCommits.slice(0, 3)) {
          lines.push(`- git_commit: ${c.shortHash} (${c.message.split('\n')[0]}) [VERIFIED]`);
        }
      }
      lines.push(``);
    }

    lines.push(`Records Cited: ${records.map((r) => r.id).join(', ')}`);

    return {
      filePath,
      overallConfidence,
      why: {
        intent: primary.intent,
        confidence: primary.intentConfidence,
      },
      who: {
        authors: allAuthors,
        agents: uniqueAgents,
        confidence: 'VERIFIED',
      },
      how: {
        approaches: allApproaches,
      },
      result: {
        status: primary.result.status,
        summary: primary.result.summary,
        confidence: 'VERIFIED',
      },
      consequences: allConsequences,
      evidence: allEvidence,
      recordsCited: records.map((r) => r.id),
      rawText: lines.join('\n'),
    };
  }
}
