import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitCommitRecord, AgentMetadata } from '../schema/types.js';

export interface GitAuthorInfo {
  name: string;
  email: string;
  agent?: AgentMetadata;
  agentConfidence: 'VERIFIED' | 'DECLARED' | 'INFERRED' | 'UNKNOWN';
}

export class GitClient {
  private repoRoot: string;

  constructor(repoRoot?: string) {
    this.repoRoot = repoRoot ? path.resolve(repoRoot) : this.findRepoRoot(process.cwd());
  }

  /**
   * Check if a given directory is inside a Git repository.
   */
  public static isGitRepo(dirPath: string = process.cwd()): boolean {
    try {
      execSync('git rev-parse --is-inside-work-tree', {
        cwd: dirPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find the root directory of the current Git repository.
   */
  public findRepoRoot(startDir: string = process.cwd()): string {
    try {
      const output = execSync('git rev-parse --show-toplevel', {
        cwd: startDir,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
      });
      return output.trim();
    } catch {
      throw new Error(`Directory '${startDir}' is not inside a Git repository.`);
    }
  }

  public getRoot(): string {
    return this.repoRoot;
  }

  /**
   * Get current Git branch or HEAD commit.
   */
  public getCurrentBranch(): string {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.repoRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
      }).trim();
      return branch === 'HEAD' ? this.getHeadHash().substring(0, 7) : branch;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Get the current HEAD commit hash.
   */
  public getHeadHash(): string {
    try {
      return execSync('git rev-parse HEAD', {
        cwd: this.repoRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
      }).trim();
    } catch {
      return '';
    }
  }

  /**
   * Get default Git author configuration.
   */
  public getDefaultAuthor(): { name: string; email: string } {
    try {
      const name = execSync('git config user.name', {
        cwd: this.repoRoot,
        encoding: 'utf-8',
      }).trim();
      const email = execSync('git config user.email', {
        cwd: this.repoRoot,
        encoding: 'utf-8',
      }).trim();
      return {
        name: name || 'Anonymous Developer',
        email: email || 'dev@local',
      };
    } catch {
      return {
        name: 'Anonymous Developer',
        email: 'dev@local',
      };
    }
  }

  /**
   * Files with changes not yet committed: staged, unstaged, and new files Git does not
   * ignore, as repository-relative paths. Deleted files are left out; there is nothing
   * of them to read.
   *
   * Read with `-z`, so a path is never quoted or split. The previous version trimmed each
   * line before cutting the two status letters, which took the first letter off every
   * path with an unstaged change (" M src/a.ts" became "rc/a.ts").
   */
  public getWorkingTreeChangedFiles(): string[] {
    try {
      const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
        cwd: this.repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      const entries = output.split('\0');
      const files: string[] = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        if (entry.length < 4) continue;
        const status = entry.slice(0, 2);
        // A rename or copy is followed by its original path, which is not a file now.
        if (/[RC]/.test(status)) i++;
        if (status.includes('D')) continue;
        files.push(entry.slice(3));
      }
      return files;
    } catch {
      return [];
    }
  }

  /**
   * The files each of the last *count* commits on HEAD changed, newest commit first,
   * leaving out files a commit deleted.
   */
  public getRecentCommitFiles(count: number): string[][] {
    try {
      const output = execFileSync('git', ['log', `-n${count}`, '--name-only', '--diff-filter=d', '--format=%x01', '-z'], {
        cwd: this.repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      return output.split('\x01').slice(1)
        .map((chunk) => chunk.split(/[\0\n]/).map((f) => f.trim()).filter(Boolean));
    } catch {
      return [];
    }
  }

  /**
   * Read Git commit history and extract structured commit records.
   */
  public getCommits(maxCount: number = 100): GitCommitRecord[] {
    return this.readLog(['-n', String(maxCount)]);
  }

  /**
   * The history of *paths* themselves, however far back it lies: the newest *maxCount*
   * commits that changed each of them, each with its full file list, and the commit that
   * created each path, so the start of its story is always there.
   *
   * The commit cache holds the newest 200 commits of the whole repository. On a busy one
   * that is days. A file's own history is a narrow read, so it is read for the files a
   * request is about, not for the repository. See `getTargetHistory` for how renames are
   * followed.
   */
  public getFileHistory(paths: string[], maxCount: number): GitCommitRecord[] {
    return this.getTargetHistory(paths, maxCount).commits;
  }

  /**
   * `getFileHistory`, through renames, with the path each path had in commits made before
   * it was moved: commit hash -> current path -> path then. Only commits where the two
   * differ are in the map.
   *
   * Read by the current path alone, a file's history stopped at the commit that moved it
   * there, and the oldest commit left, the move, was labelled as the one that introduced the
   * file: a false origin under a VERIFIED commit. `git log --follow` takes one path, so each
   * is read on its own; on React, Next.js and Prettier that is 0.25 to 0.45 s for their
   * busiest files, the whole lineage, of which the newest *maxCount* commits and the oldest
   * are kept, with any in *also*.
   */
  public getTargetHistory(paths: string[], maxCount: number, also: Set<string> = new Set()):
      { commits: GitCommitRecord[]; pathThen: Map<string, Map<string, string>> } {
    const pathThen = new Map<string, Map<string, string>>();
    const wanted = new Set<string>();
    for (const p of paths) {
      let out: string;
      try {
        out = execFileSync('git', ['log', '--follow', '--format=%x1e%H', '--name-status', '--', p], {
          cwd: this.repoRoot, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
        });
      } catch {
        continue; // Untracked paths have no history.
      }
      // Newest first. The path a commit wrote is the last field of its one status line:
      // `M <path>`, or `R087 <old> <new>` for the move itself.
      const lineage: { hash: string; then: string }[] = [];
      for (const record of out.split('\x1e')) {
        const [hash, status] = record.trim().split('\n').map((l) => l.trim()).filter(Boolean);
        if (hash) lineage.push({ hash, then: status?.split('\t').at(-1) ?? p });
      }
      // Past the newest *maxCount*: the oldest, and any commit the caller asked for by hash.
      const kept = lineage.filter((e, i) => i < maxCount || i === lineage.length - 1 || also.has(e.hash));
      for (const { hash, then } of kept) {
        wanted.add(hash);
        if (then !== p) (pathThen.get(hash) ?? pathThen.set(hash, new Map()).get(hash)!).set(p, then);
      }
    }
    // In slices, to keep the command line short; three busy paths are about 450 hashes.
    const hashes = [...wanted];
    const commits: GitCommitRecord[] = [];
    for (let i = 0; i < hashes.length; i += 200) commits.push(...this.readLog(['--no-walk', ...hashes.slice(i, i + 200)]));
    commits.sort((a, b) => b.committedAt - a.committedAt);
    return { commits, pathThen };
  }

  /**
   * For *lines* (1-based) of *filePath* at HEAD, the commit that wrote each, counted per
   * commit. Whitespace changes are ignored, and git follows the file through its renames. A
   * line older than a shallow history's first commit is not counted: blame names that
   * commit, which did not write it.
   */
  public blameLines(filePath: string, lines: number[]): Map<string, number> {
    const written = new Map<string, number>();
    if (!lines.length) return written;
    const ranges = lines.flatMap((n) => ['-L', `${n},${n}`]);
    let out: string;
    try {
      out = execFileSync('git', ['blame', '-w', '--porcelain', ...ranges, 'HEAD', '--', filePath], {
        cwd: this.repoRoot, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      return written;
    }
    const boundary = new Set<string>();
    let sha = '';
    for (const line of out.split('\n')) {
      const head = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
      if (head) sha = head[1]!;
      else if (line === 'boundary') boundary.add(sha);
      else if (line.startsWith('\t')) written.set(sha, (written.get(sha) ?? 0) + 1);
    }
    for (const sha of boundary) written.delete(sha);
    return written;
  }

  /**
   * The first commits of a shallow clone: git's `shallow` file. Empty for a full history.
   */
  public shallowRoots(): Set<string> {
    try {
      const file = execFileSync('git', ['rev-parse', '--git-path', 'shallow'], {
        cwd: this.repoRoot, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8',
      }).trim();
      const text = fs.readFileSync(path.resolve(this.repoRoot, file), 'utf-8');
      return new Set(text.split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/.test(l)));
    } catch {
      return new Set();
    }
  }

  private readLog(args: string[]): GitCommitRecord[] {
    try {
      // ASCII control characters: 0x1e opens a record, 0x1f separates fields, 0x1d closes
      // the commit body.
      //
      // The record separator has to come *first*. `--name-only` prints the file list
      // after the formatted line, so a trailing separator pushed every commit's files
      // into the following record, where the parser discarded them. The body terminator
      // removes the other half of the problem: without it the parser guessed where the
      // message ended and the file list began, and any message line containing a slash
      // or ending in something that looked like a file extension was stored as a path.
      const recordDelim = '%x1e';
      const unitDelim = '%x1f';
      const bodyEnd = '%x1d';
      const format = `${recordDelim}%H${unitDelim}%h${unitDelim}%an${unitDelim}%ae${unitDelim}%at${unitDelim}%cn${unitDelim}%ce${unitDelim}%ct${unitDelim}%B${bodyEnd}`;

      // *args* comes last: it may end in `-- <paths>`.
      const output = execFileSync('git', ['log', `--format=${format}`, '--name-only', ...args], {
        cwd: this.repoRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
      });

      const commits: GitCommitRecord[] = [];
      const rawRecords = output.split('\x1e');

      for (const raw of rawRecords) {
        const trimmed = raw.trim();
        if (!trimmed) continue;

        // With the record separator leading, fields start at index 0. The body
        // terminator tells us where the message stops and --name-only output begins,
        // so nothing has to be guessed from the shape of a line.
        const bodySplit = trimmed.indexOf('\x1d');
        const fieldsPart = bodySplit === -1 ? trimmed : trimmed.slice(0, bodySplit);
        const filesPart = bodySplit === -1 ? '' : trimmed.slice(bodySplit + 1);

        const parts = fieldsPart.split('\x1f');
        if (parts.length < 9) continue;

        const hash = parts[0]!.trim();
        const shortHash = parts[1]!.trim();
        const authorName = parts[2]!.trim();
        const authorEmail = parts[3]!.trim();
        const authoredAt = parseInt(parts[4]!.trim(), 10) * 1000;
        const committerName = parts[5]!.trim();
        const committerEmail = parts[6]!.trim();
        const committedAt = parseInt(parts[7]!.trim(), 10) * 1000;
        const message = parts.slice(8).join('\x1f').trim();

        const changedFiles = filesPart
          .split(String.fromCharCode(10))
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

        commits.push({
          hash,
          shortHash,
          authorName,
          authorEmail,
          authoredAt: isNaN(authoredAt) ? Date.now() : authoredAt,
          committerName,
          committerEmail,
          committedAt: isNaN(committedAt) ? Date.now() : committedAt,
          message,
          changedFiles,
        });
      }

      return commits;
    } catch {
      return [];
    }
  }

  /**
   * Parse agent attribution from commit message trailers and text.
   */
  public parseAgentAttribution(message: string): { agent?: AgentMetadata; confidence: 'VERIFIED' | 'DECLARED' | 'INFERRED' | 'UNKNOWN' } {
    // Check for explicit Co-authored-by or Assisted-by trailers
    const coAuthorMatch = message.match(/Co-authored-by:\s*(.+?)\s*<([^>]+)>/i);
    const assistedMatch = message.match(/Assisted-by:\s*([^\n\r]+)/i);
    const generatedMatch = message.match(/Generated-by:\s*([^\n\r]+)/i);
    const claudeMatch = message.match(/\b(Claude(?: Code)?|Cursor|Copilot|Antigravity|GPT-4[a-z0-9-]*|Gemini)\b/i);

    if (assistedMatch && assistedMatch[1]) {
      const raw = assistedMatch[1].trim();
      const modelMatch = raw.match(/(.+?)\s*\((.+?)\)/);
      if (modelMatch && modelMatch[1] && modelMatch[2]) {
        return {
          agent: { name: modelMatch[1].trim(), model: modelMatch[2].trim() },
          confidence: 'DECLARED',
        };
      }
      return {
        agent: { name: raw },
        confidence: 'DECLARED',
      };
    }

    if (coAuthorMatch && coAuthorMatch[1]) {
      const name = coAuthorMatch[1].trim();
      const email = coAuthorMatch[2]?.trim();
      if (/bot|ai|claude|copilot|cursor|assistant/i.test(name) || /bot|ai|anthropic|openai|github/i.test(email || '')) {
        return {
          agent: { name, provider: email },
          confidence: 'DECLARED',
        };
      }
    }

    if (generatedMatch && generatedMatch[1]) {
      return {
        agent: { name: generatedMatch[1].trim() },
        confidence: 'DECLARED',
      };
    }

    if (claudeMatch && claudeMatch[1]) {
      return {
        agent: { name: claudeMatch[1].trim() },
        confidence: 'INFERRED',
      };
    }

    return {
      confidence: 'UNKNOWN',
    };
  }

}
