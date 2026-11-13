/**
 * The context engine: assemble a compact, evidence-backed pack for a task, file or symbol.
 *
 * The pipeline is deterministic end to end — resolve, expand, attach history, attach
 * records, rank, deduplicate, budget. No embeddings, no model calls, no randomness, so the
 * same store and the same query always produce the same pack, which is what makes the
 * output reviewable and the tests meaningful.
 *
 * What the engine will not do
 * ---------------------------
 * It does not upgrade provenance. A commit message stays DECLARED however well it seems to
 * explain the code, because the author's claim about intent is not evidence that the claim
 * is true. The engine's own reading of a sequence — "this change came after that one" — is
 * INFERRED even when the ordering is VERIFIED, because ordering is not causation. And a
 * section with no support renders UNKNOWN rather than vanishing.
 *
 * That discipline is the reason the pack is worth reading. An agent that cannot tell which
 * lines are load-bearing has to re-verify all of them, which is the exploration this engine
 * exists to remove.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { StrataDatabase } from '../storage/db.js';
import { StrataRepository } from '../storage/repository.js';
import { CodeGraph, TargetType, TargetAnchor, tokenize, matchesWord, recordFilePath, describeMissing } from '../code/graph.js';
import { isIndexablePath } from '../code/indexer.js';
import { extractReferences } from '../code/references.js';
import { CommitChangeReader } from '../history/changes.js';
import { GitClient } from '../git/git.js';
import { HistoryAnchoring, CORE_RELATIONS } from './history.js';
import { DecisionAnalyzer, subjectTerms } from './decisions.js';
import { BehaviorReader, BehaviorLimits, AGENT as AGENT_BEHAVIOR } from './behavior.js';
import { ApplicabilityFacts, assessApplicability } from './applicability.js';
import { RecordContradiction, findContradictions, describeContradiction } from './contradictions.js';
import {
  ContextPack, Statement, Provenance, HistoricalEvent, HistoricalDecision, RelationshipEdge,
  CodeNeighbor, CodeRelevance, capStatement, estimateTokens, renderPack, hasDeclaredRecordClaims,
  unsettledDecision, MemoryRecord,
} from './pack.js';

export interface ContextOptions {
  depth?: number;
  maxTokens?: number;
  targetType?: TargetType;
  /** Cap on neighbourhood size before ranking trims it further. */
  maxNodes?: number;
  /**
   * Who the pack is for. `agent` (the default) is the compact pack delivered inline.
   * `human` carries every commit, decision and recorded statement about the target,
   * uncut, for a developer reading `strata history` / `strata explain`.
   */
  detail?: 'agent' | 'human';
  /**
   * Files the developer is working on now (`StrataService.activeFiles`). Given, they break a
   * tie between files the request matches only by its words; see `resolveTarget`.
   */
  activeFiles?: string[];
}

/**
 * How much history a pack gathers before any budget applies.
 *
 * The agent limits are the ones the delivered pack was measured with; they do not move.
 * A developer reading one file's history has the opposite constraint — a screen, not a
 * context window — and a history that silently stops at eight commits, or a record cut
 * at 400 characters, answers less than `git log` would. So the human view lifts the
 * counts rather than growing a second history system beside this one.
 */
interface PackLimits {
  commits: number;
  diffedCommits: number;
  decisions: number;
  quotedLines: number;
  intentChars: number;
  constraintChars: number;
  consequenceChars: number;
  intents: number;
  constraints: number;
  attempts: number;
  consequences: number;
  uncertainty: number;
  records: number;
  symbols: number;
  /** Stated reasons shown after the intents, and the length an attempt statement may run to. */
  reasons: number;
  attemptChars: number;
}

const AGENT_LIMITS: PackLimits = {
  commits: 8, diffedCommits: 2, decisions: 4, quotedLines: 4,
  intentChars: 400, constraintChars: 300, consequenceChars: 300,
  intents: 5, constraints: 5, attempts: 6, consequences: 6, uncertainty: 6, records: 5, symbols: 8,
  reasons: 3, attemptChars: 600,
};

const HUMAN_BEHAVIOR: BehaviorLimits = { files: 20, signatures: 40, callSites: 60, callSiteAnchors: 20, declarations: true };

const HUMAN_LIMITS: PackLimits = {
  commits: 40, diffedCommits: 40, decisions: 16, quotedLines: 12,
  intentChars: Infinity, constraintChars: Infinity, consequenceChars: Infinity,
  intents: Infinity, constraints: Infinity, attempts: Infinity, consequences: Infinity,
  uncertainty: Infinity, records: 20, symbols: 60,
  reasons: Infinity, attemptChars: Infinity,
};

const DEFAULT_DEPTH = 1;
/*
  Raised from 1800 when the pack began carrying historical diffs.

  1800 was set when history was a list of commit subjects, and it is not enough to hold
  the evidence that replaces them: measured on the real case, the pack needed ~3,000
  tokens and the trimmer dropped exactly the commit that mattered — the four-line schema
  flip — while keeping a grab-bag commit's larger, less informative diff. An agent then
  reproduced the regression the diff would have warned it about.

  A budget too small to carry the evidence is worse than no evidence, because the pack
  still looks complete.
*/
const DEFAULT_MAX_TOKENS = 3200;
const DEFAULT_MAX_NODES = 40;
/** Commits read from git for the target's own files, besides the commit that created each. */
const TARGET_HISTORY_COMMITS = 150;
/** A name on more lines of a file than this describes the file, not a change to it. */
const MAX_NAMED_LINES = 8;
/** The best-ranked commits the budget sheds last among commits without a diff. */
const RANKED_HISTORY_KEPT = 3;

/** Neighbourhood entries kept after ranking. Small on purpose: this is the whole point. */
const KEEP_NEIGHBORS = 12;
const KEEP_RELATIONSHIPS = 14;

/** Exported names the "Target defines" statement lists. A longer surface is counted, not cut silently. */
const MAX_DEFINES_LISTED = 6;

/**
 * Citations of the nearest record the budget will not reclaim.
 *
 * Bounded so a record with a long evidence list cannot hold the section open at the
 * expense of the history and memory below it; six covers the commits and files a record
 * normally points at.
 */
const MAX_PROTECTED_EVIDENCE = 6;

/**
 * Statements per section the record about the primary target keeps for itself.
 *
 * Every memory section already has a floor of one, so that emptying it cannot turn into
 * the false claim that nothing was recorded. One is the right floor for a record about a
 * neighbouring file. It is the wrong floor for the record about the file the request
 * named, because a record lists its attempts in the order they happened and the decisive
 * one is rarely the first: measured on a real record, the surviving attempt named the
 * commit that *added* a mechanism and the trimmed one named the commit that replaced it,
 * along with the constant the question was about.
 *
 * Two is the smallest floor that can show a progression rather than a starting point. It
 * is a floor, not an allocation — a record with one attempt keeps one — and it applies
 * only to the nearest record, so this never widens the pack for peripheral memory.
 */
const ANCHORED_MEMORY_FLOOR = 2;

/** The trimming step that removes the provenance notices, leaving the per-line boundaries. */
export const FRAMING_STEP = 'provenance-notices';

export class ContextEngine {
  private graph: CodeGraph;
  private repo: StrataRepository;
  private anchoring: HistoryAnchoring;
  private behavior: BehaviorReader;
  private changes?: CommitChangeReader;
  private decisions?: DecisionAnalyzer;
  /** The limits of the build in progress; see `PackLimits`. */
  private limits: PackLimits = AGENT_LIMITS;
  private repoRoot?: string;
  /** Contradictions per record id, for the build in progress. */
  private contradictionCache = new Map<string, RecordContradiction[]>();

  constructor(db: StrataDatabase, repo: StrataRepository, repoRoot?: string) {
    this.repo = repo;
    this.repoRoot = repoRoot;
    this.graph = new CodeGraph(db);
    this.anchoring = new HistoryAnchoring(this.graph, repo);
    this.behavior = new BehaviorReader(this.graph, repoRoot);
    // Without a repository root there is no history to read; the pack degrades to
    // commit subjects rather than failing.
    if (repoRoot) {
      this.changes = new CommitChangeReader(repoRoot);
      this.decisions = new DecisionAnalyzer(this.changes);
    }
  }

  public build(query: string, options: ContextOptions = {}): ContextPack {
    const depth = Math.max(0, Math.min(3, options.depth ?? DEFAULT_DEPTH));
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const notes: string[] = [];
    this.limits = options.detail === 'human' ? HUMAN_LIMITS : AGENT_LIMITS;

    // Git answers are cached for the duration of one build and no longer: the tree can
    // move between requests, and a stale "is this still in the file?" is a wrong answer
    // delivered confidently.
    this.changes?.beginRequest();
    this.contradictionCache.clear();

    const indexed = this.graph.isIndexed();
    if (!indexed) {
      notes.push('Code graph is empty — run `strata index`. Falling back to record and commit search only.');
    }

    // 1-2. Resolve the target. An explicitly named file that does not exist stops here.
    const target = this.graph.resolveTarget(query, options.targetType,
      options.activeFiles ? { activeFiles: options.activeFiles } : {});
    if (target.resolution === 'target_not_found') {
      const empty = notFoundPack(query, target.unresolved, indexed, this.graph.fileCount(),
                                 depth, maxTokens, notes);
      empty.applicability = assessApplicability(empty, this.applicabilityFacts(
        empty, [], [], new Set(), { directCommits: [], targetDecisions: [], codeFiles: [] }, options.detail === 'human'));
      return empty;
    }

    /*
      3. Expand the neighbourhood over established edges.

      Seeds are the *anchors* — what the query named — not simply the first three files
      that scored. With a lexical resolution the two are the same thing; with an explicit
      one they are not, and the difference is what stops four incidental word matches
      from each dragging their own subsystem into the pack.
    */
    const anchors = target.anchors.length
      ? target.anchors
      : target.files.map((f) => ({ file: f, kind: 'lexical' as const, matched: query, symbols: [] }));
    const anchorFiles = [...new Set(anchors.map((a) => a.file))];
    const seeds = anchorFiles.slice(0, 3);
    const lineAuthors = this.namedLineAuthors(seeds, query);
    this.readTargetHistory(seeds, new Set(lineAuthors.keys()));
    const hood = seeds.length
      ? this.graph.expand(seeds, depth, options.maxNodes ?? DEFAULT_MAX_NODES)
      : { nodes: [], imports: [], references: [] };

    const queryTerms = tokenize(query);
    const neighbors = this.rankNeighbors(hood.nodes, queryTerms, seeds, anchors);
    const neighborPaths = neighbors.map((n) => n.path);

    /*
      4. History anchored to the target, then ranked inside what is already relevant.

      The candidate pool is built per relationship class — target, one edge out, the rest
      of the neighbourhood, message-only — and the classes are compared before anything
      else. Previously one score covered the whole neighbourhood and the commit that
      created the target could rank below a recent commit that had brushed four of its
      neighbours; see the header of `src/context/history.ts`.
    */
    const history = this.anchoring.gather({
      anchors: anchors.slice(0, 5),
      related: hood.nodes.filter((n) => n.distance === 1).map((n) => n.path),
      indirect: hood.nodes.filter((n) => n.distance >= 2).map((n) => n.path),
      queryTerms,
      lineAuthors,
      shallowRoots: this.repoRoot ? new GitClient(this.repoRoot).shallowRoots() : new Set(),
      limit: this.limits.commits,
    });

    /*
      5. What the code does now, and who calls it.

      Measured rather than assumed: handed a pack rich in history, the last agent spent
      its next five tool calls reading the target, reading the schema, and grepping for
      call sites the index had already stored line numbers for. Naming a file is a search
      instruction; quoting its exported surface and pointing at `file:line` is an answer.
    */
    const namedSymbols = anchors.filter((a) => a.kind === 'explicit_symbol').flatMap((a) => a.symbols.map((s) => s.name));
    const behaviorLimits = options.detail === 'human' ? HUMAN_BEHAVIOR : undefined;
    const currentBehavior = this.behavior.describe(anchorFiles, { named: namedSymbols, limits: behaviorLimits });
    // Uses of a symbol the request named come first, then each named file's callers in
    // turn — ranked by the neighbourhood the pack already built.
    const calls = this.behavior.callSites(anchorFiles, {
      named: namedSymbols,
      callerOrder: neighborPaths,
      protect: anchors.filter((a) => a.kind !== 'lexical').map((a) => a.file),
      limits: behaviorLimits,
    });
    const callSites = calls.sites;

    /*
      6. Decisions, and whether they still hold.

      The remaining failure was never retrieval. An agent read the decisive diff and
      reversed it anyway, because a diff states what one commit did and says nothing about
      whether it is still in force. That question is answerable from git, so it is answered
      here instead of being left to the reader.
    */
    const decisions = this.decisions
      ? this.decisions.analyze(history, anchorFiles, queryTerms,
          { decisions: this.limits.decisions, quotedLines: this.limits.quotedLines }, query)
      : [];

    /*
      Diffs come last, and follow the decisions.

      A commit that turned out to hold a decision is the commit whose hunks are worth
      carrying, so it claims a slot ahead of the ordering's own preferences. Deriving the
      decisions first is what makes that possible.
    */
    this.attachChanges(history, anchorFiles.length ? anchorFiles : neighborPaths,
                       decisions.map((d) => d.commit));
    this.attachSupport(decisions, history);

    // 7. Records, and the attempts/constraints/consequences they carry. Nearest the
    //    resolved target first, because that order decides what survives the budget.
    const records = this.recordsFor(query, anchorFiles, neighborPaths);
    const scope = new Set([...anchorFiles, ...neighborPaths].map(normalizePath));

    const evidence = this.collectEvidence(history, records, anchorFiles);
    const relationships = this.rankRelationships(hood, seeds);
    const explained = new Set(history.filter((h) => h.changes?.length || h.historicalFiles?.length)
      .map((h) => h.hash));
    const chains = this.buildChains(history, anchorFiles, explained);

    const pack: ContextPack = {
      target: {
        query,
        type: target.type,
        resolution: target.resolution,
        files: target.files,
        symbols: target.symbols.slice(0, this.limits.symbols).map((s) => ({
          name: s.name, kind: s.kind, file: s.file_path, line: s.start_line,
        })),
        anchors: anchors.slice(0, 5).map((a) => ({
          file: a.file, kind: a.kind, matched: a.matched, ...('plainWord' in a && a.plainWord ? { plainWord: true } : {}),
          ...('active' in a && a.active ? { active: true } : {}),
        })),
        confidence: target.confidence,
        ...(target.unresolved.length ? { unresolved: target.unresolved } : {}),
        ...(options.detail === 'human' ? this.directoryScope(anchors, target.files) : {}),
      },
      whyThisAreaMatters: this.whyStatements(target, neighbors, history, records),
      codeNeighborhood: neighbors,
      currentBehavior,
      callSites,
      relationships,
      historicalDecisions: decisions,
      historicalContext: history,
      changeChains: chains,
      decisionsAndConstraints: this.constraintStatements(records, scope),
      constraints: this.explicitConstraints(records, scope),
      previousAttempts: this.attemptStatements(records, scope),
      consequences: this.consequenceStatements(records, scope),
      ...(options.detail === 'human' ? { memory: this.memoryFor(records, anchorFiles, scope) } : {}),
      evidence: evidence.items,
      uncertainty: [],
      provenanceSummary: { VERIFIED: 0, DECLARED: 0, INFERRED: 0, UNKNOWN: 0 },
      diagnostics: {
        indexed,
        filesInIndex: this.graph.fileCount(),
        scope: { targets: 0, neighborhoodFiles: 0, symbols: 0, relationships: 0 },
        depth,
        maxTokens,
        estimatedTokens: 0,
        truncated: false,
        budgetExceeded: false,
        sectionsTruncated: [],
        recordsOmitted: [],
        notes,
      },
    };

    pack.uncertainty = this.uncertaintyFor(pack, indexed);
    this.countProvenance(pack);
    // What the target had before the budget, so that what the budget took is visible.
    const found: ApplicabilityFacts['found'] = {
      directCommits: history.filter((h) => h.relation === 'DIRECT_TARGET').map((h) => h.shortHash),
      targetDecisions: decisions.filter((d) => d.inTarget).map((d) => `${d.commit} ${d.path}`),
      codeFiles: currentBehavior.map((b) => b.file),
    };
    this.applyBudget(pack, maxTokens, {
      evidenceFloor: evidence.protectedCount,
      selectedRecords: records.map((r) => r.id),
      callSiteFloor: calls.protectedCount,
    });
    // Last, and outside the budget: it describes the pack the budget left.
    pack.applicability = assessApplicability(pack, this.applicabilityFacts(
      pack, records, anchors, scope, found, options.detail === 'human'));
    return pack;
  }

  /**
   * What the applicability assessment needs that the pack does not carry.
   *
   * Counts and flags from the store and the index, never from rendered text: whether the
   * repository has any history at all, whether the store holds any record, how each
   * target file is indexed, which named paths exist on disk, and which of the target's
   * records its files have changed since. Read-only; the pack is not touched.
   */
  private applicabilityFacts(
    pack: ContextPack, records: ReturnType<ContextEngine['recordsFor']>, anchors: TargetAnchor[],
    scope: Set<string>, found: ApplicabilityFacts['found'], human: boolean,
  ): ApplicabilityFacts {
    const anchorFiles = [...new Set(anchors.map((a) => a.file))];
    const targets = new Set(anchorFiles.map(normalizePath));
    const onDisk = (p: string): boolean => !!this.repoRoot && fs.existsSync(path.join(this.repoRoot, p));
    const isFile = (p: string): boolean => {
      try { return !!this.repoRoot && fs.statSync(path.join(this.repoRoot, p)).isFile(); } catch { return false; }
    };
    return {
      indexed: pack.diagnostics.indexed,
      repositoryCommits: this.repo.getGitCommitCount(),
      storeRecords: this.repo.getRecordCount(),
      files: pack.target.files.map((p) => ({
        path: p, ...(this.graph.fileInfo(p) ?? { language: null, declarations: 0, exported: 0 }),
      })),
      unresolved: (pack.target.unresolved ?? []).map((p) => ({ path: p, onDisk: onDisk(p), indexable: isIndexablePath(p) })),
      // Read with the resolver's own syntax: a path it offered but did not assert, because
      // its extension is not one the index knows, that is nonetheless a file on disk.
      unindexedPaths: pack.targetNotFound ? [] : extractReferences(pack.target.query)
        .filter((r) => r.kind === 'path' && !r.assertsFile && !isIndexablePath(r.text)
          && !this.graph.fileInfo(r.text) && isFile(r.text))
        .map((r) => r.text),
      directories: this.directoryScope(anchors, pack.target.files).directories ?? [],
      found,
      directCommitsInIndex: this.graph.commitsForFiles(anchorFiles.slice(0, 5), Number.MAX_SAFE_INTEGER).length,
      codeFileLimit: human ? HUMAN_BEHAVIOR.files : AGENT_BEHAVIOR.files,
      records: records.map((rec) => {
        const files = rec.files.map((f) => normalizePath(f.path));
        const about = recordPaths(rec).some((f) => targets.has(f)) ? 'target' as const
          : files.some((f) => scope.has(f)) ? 'connected' as const : 'wording' as const;
        // Commits to the record's own target files authored after it was written, the
        // same comparison the human view shows under the record.
        const changedSince = about === 'target'
          ? this.graph.commitsForFiles(files.filter((f) => targets.has(f)), Number.MAX_SAFE_INTEGER)
              .filter((c) => c.authored_at > rec.createdAt)
              .sort((a, b) => a.authored_at - b.authored_at || a.hash.localeCompare(b.hash))
              .map((c) => this.repo.getCommitByHash(c.hash)?.shortHash ?? c.hash.slice(0, 7))
          : [];
        const derived = rec.author.type === 'system';
        return {
          id: rec.id, about, derived,
          committed: !derived || rec.evidence.some((e) => e.type === 'git_commit'),
          changedSince,
          contradicted: this.contradictionsOf(rec).map((c) => ({ commit: c.commit, files: c.files })),
        };
      }),
    };
  }

  /**
   * Hang a commit's recovered evidence off the decision it supports.
   *
   * The deleted test was already in the pack, forty lines down under the commit that
   * added it. A decision that quotes the one assertion line stating the intent is usable;
   * a script the reader has to scan for the point is a second search.
   */
  private attachSupport(decisions: HistoricalDecision[], history: HistoricalEvent[]): void {
    const byHash = new Map(history.map((h) => [h.shortHash, h]));
    for (const decision of decisions) {
      const event = byHash.get(decision.commit);
      // Which line of the recovered file to quote is decided by the decision itself: the
      // line that names what the decision changed. Choosing by the decision's own
      // vocabulary keeps the selection evidence-driven instead of a guess about which
      // sentence reads best.
      const subject = subjectTerms([...decision.historicalState, ...decision.currentState]);
      for (const file of event?.historicalFiles ?? []) {
        const quote = evidenceLine(file.lines, subject);
        decision.support.push({
          kind: file.status === 'deleted' ? 'deleted file' : 'file added in the same commit',
          reference: `${file.path} (read from ${file.sourceCommit.slice(0, 7)})`,
          ...(quote ? { quote } : {}),
          provenance: 'VERIFIED',
        });
      }

      /*
        A test deleted in its own commit.

        The per-commit recovery above only reaches evidence that travelled with a
        ranked commit, which misses the case where a test was removed on its own —
        and a test deleted *because* a decision changed is exactly the evidence a
        reader needs to understand the decision. Searched per target file, bounded
        by a pathspec on the file's own stem, and read out of the commit before the
        deletion so the content is the last state it actually had.
      */
      if (!decision.inTarget || !this.changes) continue;
      const known = new Set(decision.support.map((s) => s.reference.split(' ')[0]));
      for (const gone of this.changes.deletedRelatedTests(decision.path)) {
        if (known.has(gone.path)) continue;
        const content = this.changes.fileAtCommit(`${gone.deletedIn}~1`, gone.path);
        if (!content) continue;
        /*
          Attach only on a real overlap.

          Sharing a filename stem with the target makes a deleted test a candidate;
          it does not make it evidence *for this decision*. Hung off every decision
          on the file, the identity test appeared under a later change about scan
          timestamps, which it says nothing about — a link the repository does not
          support. So the deleted file has to name something this decision actually
          changed, and where it names nothing the association is dropped rather
          than asserted.
        */
        const quote = content.lines.find(
          (l) => l.trim().length > 12
            && subject.some((w) => matchesWord(l, w.toLowerCase())),
        )?.trim();
        if (!quote) continue;
        decision.support.push({
          kind: 'deleted test',
          reference: `${gone.path} (deleted in ${gone.deletedIn}: ${gone.subject})`,
          quote,
          provenance: 'VERIFIED',
        });
      }
    }
  }

  public render(pack: ContextPack): string {
    return renderPack(pack);
  }

  /**
   * Bring the target's own history into the cache before history is anchored.
   *
   * The cache holds the newest commits of the whole repository, so on a busy one the history
   * of any file older than a few days was simply absent. The target's files are read from
   * git directly instead (see `GitClient.getTargetHistory`). A failed read leaves the pack
   * as it would have been.
   *
   * It is read even when the cache holds the whole history. The cache has every commit
   * then, but its edges name each file as the commit wrote it, so a file's commits from
   * before it was renamed are not linked to it; only the rename-following read links them.
   */
  private readTargetHistory(files: string[], also: Set<string>): void {
    if (!this.repoRoot || !files.length) return;
    try {
      const { commits, pathThen } = new GitClient(this.repoRoot).getTargetHistory(files, TARGET_HISTORY_COMMITS, also);
      this.repo.addFileHistory(commits, files, pathThen);
      this.changes?.setFormerPaths(pathThen);
    } catch {
      // The cache alone, as before.
    }
  }

  /**
   * The commits that wrote the lines of the target the request names, by how many each wrote.
   *
   * A question that names code (`appendPlugins`, `__NEXT_EXPERIMENTAL_APP_NEW_SCROLL_HANDLER`)
   * is about the commit that wrote it, and on a busy file that commit is buried. `git blame`
   * on just those lines does, in one read, and the target-history read then fetches it however
   * far back it is.
   *
   * A name on more than `MAX_NAMED_LINES` lines of the file describes the file rather than
   * one change in it, so only the line that declares it is blamed: Prettier's `appendPlugins`
   * is used on nine lines and declared, by the change that introduced it, on one.
   *
   * Only the primary target is read, and only a commit that wrote at least a third of the
   * named lines counts.
   */
  private namedLineAuthors(files: string[], query: string): Map<string, number> {
    const authors = new Map<string, number>();
    const terms = codeTerms(query);
    if (!this.repoRoot || !this.changes || !terms.length) return authors;
    const git = new GitClient(this.repoRoot);
    for (const file of files.slice(0, 1)) {
      const text = this.changes.contentAtHead(file);
      if (text === null) continue;
      const lines = text.split('\n');
      const named = new Set<number>();
      for (const term of terms) {
        const at = lines.flatMap((l, i) => (l.includes(term) ? [i + 1] : []));
        // A name used everywhere is still defined once, by the change that introduced it.
        const defines = new RegExp(`\\b(?:const|let|var|function|class|interface|type|enum)\\s+${term.replace(/\$/g, '\\$')}\\b`);
        for (const n of at.length <= MAX_NAMED_LINES ? at : at.filter((n) => defines.test(lines[n - 1]!))) named.add(n);
      }
      for (const [sha, n] of git.blameLines(file, [...named].sort((a, b) => a - b))) authors.set(sha, n);
    }
    const total = [...authors.values()].reduce((a, b) => a + b, 0);
    for (const [sha, n] of authors) if (n * 3 < total) authors.delete(sha);
    return authors;
  }

  // ---------------------------------------------------------------- ranking

  /**
   * Order the neighbourhood.
   *
   * Distance dominates: a file wired directly to the target is more useful than one two
   * hops away regardless of how its name reads. Lexical agreement with the query only
   * breaks ties, because matching a word is the weakest evidence available here and was
   * the failure mode of the retrieval this engine replaces.
   */
  private rankNeighbors(
    nodes: { path: string; distance: number; reasons: string[] }[],
    terms: string[], seeds: string[], anchors: TargetAnchor[] = [],
  ): CodeNeighbor[] {
    // Class first. A file the query named outright and a file that happened to
    // score well are both at distance 0, and only the anchor that put them there
    // tells them apart.
    const anchorKind = new Map(anchors.map((a) => [a.file, a.kind]));
    const classify = (n: { path: string; distance: number }): CodeRelevance => {
      if (n.distance >= 2) return 'INDIRECTLY_RELATED';
      if (n.distance === 1) return 'DIRECTLY_RELATED';
      return anchorKind.get(n.path) === 'lexical' ? 'LEXICAL_ONLY' : 'DIRECT_TARGET';
    };
    const CLASS_RANK: Record<CodeRelevance, number> = {
      DIRECT_TARGET: 0, DIRECTLY_RELATED: 1, INDIRECTLY_RELATED: 2, LEXICAL_ONLY: 3,
    };

    const scored = nodes.map((n) => {
      let score = 100 - n.distance * 40;
      if (seeds.includes(n.path)) score += 50;
      const lower = n.path.toLowerCase();
      for (const t of terms) if (lower.includes(t)) score += 6;
      // A file pulled in by several distinct relationships is more central.
      score += Math.min(n.reasons.length, 4) * 3;
      // Very large generated-looking files are rarely what the agent needs.
      if (/\.(min|bundle)\./.test(lower)) score -= 40;
      return { node: n, score, relevance: classify(n) };
    });
    /*
      Distance first, then class, then score.

      Ordering by class alone was wrong in the case that matters most: when a query
      resolves only lexically, its seed *is* the target, and ranking LEXICAL_ONLY
      below DIRECTLY_RELATED pushed the file the question was about underneath its
      own imports. Distance restores that — a seed always leads — while class still
      decides between two files at the same distance, which is where the rule the
      brief cares about lives: an explicitly named target outranks a lexical one.
    */
    scored.sort((a, b) =>
      a.node.distance - b.node.distance ||
      CLASS_RANK[a.relevance] - CLASS_RANK[b.relevance] ||
      b.score - a.score || a.node.path.localeCompare(b.node.path));

    return scored.slice(0, KEEP_NEIGHBORS).map(({ node, relevance }) => {
      const syms = this.graph.symbolsIn(node.path)
        .filter((s) => s.exported)
        .slice(0, 6)
        .map((s) => s.name);
      return {
        path: node.path,
        distance: node.distance,
        relevance,
        reasons: node.reasons,
        ...(syms.length ? { symbols: syms } : {}),
      };
    });
  }

  private rankRelationships(
    hood: { imports: { from_file: string; specifier: string; to_file: string | null; resolution: string }[];
            references: { from_file: string; symbol_name: string; to_file: string | null; confidence: string }[] },
    seeds: string[],
  ): RelationshipEdge[] {
    const edges: RelationshipEdge[] = [];
    const seen = new Set<string>();
    const push = (e: RelationshipEdge): void => {
      const key = `${e.from}|${e.kind}|${e.to}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push(e);
    };

    for (const imp of hood.imports) {
      if (imp.to_file) {
        push({ from: imp.from_file, kind: 'imports', to: imp.to_file,
               detail: imp.specifier, provenance: 'VERIFIED' });
      } else {
        // Recorded, but honestly: we know the import statement exists and nothing more.
        push({ from: imp.from_file, kind: 'imports', to: imp.specifier,
               detail: 'unresolved (external package or missing file)', provenance: 'UNKNOWN' });
      }
    }
    for (const ref of hood.references) {
      if (!ref.to_file) continue; // unbound name: no edge to draw
      push({ from: ref.from_file, kind: 'references', to: ref.to_file,
             detail: ref.symbol_name, provenance: ref.confidence as Provenance });
    }

    // Edges touching a seed come first; the rest are context.
    edges.sort((a, b) => {
      const aSeed = seeds.includes(a.from) || seeds.includes(a.to) ? 0 : 1;
      const bSeed = seeds.includes(b.from) || seeds.includes(b.to) ? 0 : 1;
      if (aSeed !== bSeed) return aSeed - bSeed;
      if (a.provenance !== b.provenance) return a.provenance === 'VERIFIED' ? -1 : 1;
      return a.from.localeCompare(b.from);
    });
    return edges.slice(0, KEEP_RELATIONSHIPS);
  }

  // ---------------------------------------------------------------- history

  /**
   * Put the diff next to the commit.
   *
   * Only the top few commits are diffed, and only against the files the query resolved
   * to: a pack that carried every hunk of every commit would be a worse `git log`, and
   * the point is to answer one question, not to reproduce the repository.
   *
   * A file the commit touched that no longer exists at HEAD is read out of the object
   * store as well.
   */
  private attachChanges(history: HistoricalEvent[], focus: string[], preferred: string[] = []): void {
    if (!this.changes || !focus.length) return;

    /*
      Which commits get their diff carried.

      Only commits that actually changed the target are eligible, in rank order, plus the
      one that introduced it. A commit that merely sits in the neighbourhood has no diff
      worth quoting against a question about this file, and quoting it costs the budget
      that the real evidence needs.

      The origin is reserved explicitly rather than trusted to ranking. For "why is this
      code like this" the commit that created the construct is the one that answers it,
      and it is reliably the oldest — the position ranking is worst at protecting.
    */
    const direct = history.filter((h) => h.relation === 'DIRECT_TARGET');
    // Commits that produced a decision first: whatever else the ordering prefers, the
    // hunks behind a decision are the ones a reader will want to check it against.
    const byShort = new Map(direct.map((h) => [h.shortHash, h]));
    const chosen: HistoricalEvent[] = [];
    // In decision order, not history order. Filtering the history list by membership
    // looks equivalent and is not: it keeps the history ranking, which had already put
    // the decisive middle commit third and out of reach of a two-slot budget.
    for (const hash of preferred) {
      const event = byShort.get(hash);
      if (event && !chosen.includes(event) && chosen.length < this.limits.diffedCommits) chosen.push(event);
    }
    for (const h of direct) {
      if (chosen.length >= this.limits.diffedCommits) break;
      if (!chosen.includes(h)) chosen.push(h);
    }
    const origin = direct.find((h) => h.introducedAnchor);
    if (origin && !chosen.includes(origin)) chosen.push(origin);
    // With no direct history at all, fall back to the best-ranked commit: a pack with a
    // weak diff still beats a pack with none, as long as its relation says what it is.
    if (!chosen.length && history.length) chosen.push(history[0]!);

    for (const event of chosen) {
      const detail = this.changes.changesFor(event.hash, focus);
      if (detail.files.length) {
        event.changes = detail.files.map((f) => ({
          path: f.path,
          ...(f.previousPath ? { previousPath: f.previousPath } : {}),
          status: f.status,
          hunks: f.hunks,
          hunksOmitted: f.hunksOmitted,
          linesOmitted: f.linesOmitted,
          // Exact git content. Nothing here is a reading of the change.
          provenance: 'VERIFIED' as Provenance,
        }));
      }
      if (detail.otherFiles.length) {
        event.alsoChanged = detail.otherFiles;
        event.alsoChangedOmitted = detail.otherFilesOmitted;
      }

      for (const testPath of this.changes.relatedTestFiles(event.hash, focus)) {
        if (this.changes.existsAtHead(testPath)) continue; // readable now; no need to quote it
        const content = this.changes.fileAtCommit(event.hash, testPath);
        if (!content) continue;
        (event.historicalFiles ??= []).push({
          path: content.path,
          status: content.status,
          sourceCommit: content.sourceCommit,
          lines: content.lines,
          linesOmitted: content.linesOmitted,
          provenance: 'VERIFIED' as Provenance,
        });
      }
    }
  }

  /**
   * Group commits that hit the same file into an ordered chain.
   *
   * The chain is VERIFIED as an ordering — git says which came first — and nothing more is
   * claimed. That one change *caused* the next is exactly the sort of reading this engine
   * leaves to the agent, which is why chains carry no narrative text.
   */
  /**
   * Group commits that hit the same file into an ordered chain, and say where it breaks.
   *
   * A chain of subject lines looks like an explanation and mostly is not. "TuneIt V 0.1
   * Compelete" tells a reader that something happened and nothing about what or why, so a
   * step with no diff carried and no record attached is marked `[why: UNKNOWN]` rather
   * than left to read as though it were accounted for.
   *
   * Gaps in the chain itself are stated too: history here reaches only as far back as the
   * indexed commit cache, and a chain whose first link is the oldest commit Strata holds
   * is not necessarily the beginning of the story.
   */
  private buildChains(
    history: HistoricalEvent[], files: string[], explained: Set<string>,
  ): ContextPack['changeChains'] {
    const chains: ContextPack['changeChains'] = [];
    for (const file of files.slice(0, 3)) {
      // `anchorFiles` rather than `touchedFiles`: the latter is capped for display, and a
      // chain assembled from a truncated list silently loses its own links.
      /*
        Ordered by git's ancestry for this file, not by the authored timestamp.

        `authoredAt` has second resolution and is not a total order — scripted
        commits, imports and rebases routinely share one — so sorting by it alone
        produced an arbitrary sequence under a heading that states the ordering is
        VERIFIED. Where git can supply the real order it decides; the timestamp is
        the fallback, and ties in it are broken by hash so the result is at least
        stable rather than dependent on the order history happened to arrive in.
      */
      const order = this.changes?.commitOrder(file);
      const rank = (h: HistoricalEvent): number => order?.get(h.shortHash) ?? Number.NaN;
      const touching = history
        .filter((h) => h.anchorFiles.includes(file) || h.touchedFiles.includes(file))
        .sort((a, b) => {
          const ra = rank(a), rb = rank(b);
          if (!Number.isNaN(ra) && !Number.isNaN(rb)) return ra - rb;
          return a.authoredAt - b.authoredAt || a.shortHash.localeCompare(b.shortHash);
        });
      if (touching.length < 2) continue;

      const gaps: string[] = [];
      const unexplained = touching.filter((h) => !explained.has(h.hash));
      if (unexplained.length) {
        gaps.push(`${unexplained.length} step(s) carry no diff and no record — what changed at ` +
          `${unexplained.map((h) => h.shortHash).join(', ')} is not established here.`);
      }
      if (!touching[0]!.introducedAnchor) {
        gaps.push(`${touching[0]!.shortHash} is the earliest indexed commit touching ${file}, ` +
          'which is not the same as the commit that created it.');
      }

      chains.push({
        files: [file],
        sequence: touching.map((h) => ({
          shortHash: h.shortHash, subject: h.subject, explained: explained.has(h.hash),
        })),
        gaps,
      });
    }
    return chains.slice(0, 3);
  }

  /**
   * What the pack could not establish, gathered rather than left implicit.
   *
   * An empty section reads as "nothing to say here", and for a record-fed section that is
   * exactly wrong — it means nobody wrote anything down. Saying so is the difference
   * between an agent knowing it is working without prior context and assuming there was
   * none.
   */
  private uncertaintyFor(
    pack: Omit<ContextPack, 'uncertainty' | 'provenanceSummary'>, indexed: boolean,
  ): string[] {
    const out: string[] = [];
    if (!pack.previousAttempts.length) {
      out.push('no previous attempt is recorded for this area — nobody wrote one down, which is not evidence that none was made.');
    }
    if (!pack.consequences.length) {
      out.push('no consequence of earlier work here is recorded.');
    }
    if (!pack.decisionsAndConstraints.length) {
      out.push('no constraint has been recorded for this area; the historical decisions in this pack come from git alone.');
    }
    for (const d of pack.historicalDecisions) {
      if (d.status === 'UNKNOWN') out.push(unsettledDecision(d.commit, d.path));
    }
    if (!pack.currentBehavior.length && pack.target.files.length) {
      out.push('the current contents of the target could not be read from the working tree.');
    }
    if (!indexed) out.push('the code graph is empty, so relationships and call sites are missing rather than absent.');
    return out.slice(0, this.limits.uncertainty);
  }

  // ---------------------------------------------------------------- records

  /**
   * Records relevant to *this* neighbourhood, nearest the resolved target first.
   *
   * A record earns its place by touching a file the query resolved to. Lexical agreement
   * alone does not qualify it: the free-text search happily returns a record about a
   * different subsystem that shares a common word, and a pack that quietly mixes one in
   * is worse than a pack with no records at all — the agent cannot tell which of the two
   * it is reading.
   *
   * The exception is a query that resolved to no code at all. There the lexical hit is the
   * only signal available, so it is used and flagged, rather than returning nothing.
   *
   * Order is target proximity, and it is load-bearing
   * ------------------------------------------------
   * Every statement section is built by walking this list, and the budget trims each
   * section from its end. So whichever record comes back first is the one that survives a
   * tight budget, and until this ordering existed that was decided by the *code
   * neighbourhood* ranking — a different question, answered by graph distance and shared
   * words rather than by what the request named.
   *
   * Measured: a question about `driftAlgorithm.ts` resolved to it as the primary target,
   * but the neighbourhood put `engineController.ts` first, so the record about the
   * controller was emitted first and the record about the drift algorithm — the one
   * carrying the two commits and the constant that answered the question — was trimmed
   * away. The pack kept a record about a file nobody asked about and dropped the record
   * about the file they did.
   *
   * So a record is ranked by the best anchor it names: the primary resolved target first,
   * then the remaining anchors in resolution order, then records that only touch the
   * wider neighbourhood, then free-text matches. Ties keep discovery order, so this
   * reorders records and never adds or removes one.
   */
  private recordsFor(query: string, anchorFiles: string[], neighborPaths: string[]) {
    const scopeFiles = neighborPaths.length ? neighborPaths : anchorFiles;
    const neighborhood = new Set(scopeFiles.map(normalizePath));
    const anchorRank = new Map(anchorFiles.map((f, i) => [normalizePath(f), i]));
    // Ranks below the anchors, so any anchor beats a neighbour and any neighbour beats a
    // record found only by shared words.
    const NEIGHBOR_RANK = anchorFiles.length;
    const LEXICAL_RANK = anchorFiles.length + 1;

    /*
      Anchors are looked up as well as the neighbourhood, not instead of it.

      The lookup used to run over the first eight neighbourhood entries only, so a record
      about the primary target was missed outright whenever that file ranked ninth or
      lower among its own neighbours. Adding the anchors widens the search and can only
      find more; the qualification rule below is unchanged.
    */
    const lookup: string[] = [];
    for (const f of [...anchorFiles, ...scopeFiles.slice(0, 8)]) {
      if (!lookup.includes(f)) lookup.push(f);
    }

    const merged = new Map<string, NonNullable<ReturnType<StrataRepository['getRecordById']>>>();
    for (const f of lookup) for (const r of this.repo.getRecordsByFile(f)) if (r) merged.set(r.id, r);
    // A record the request named by its id is in the pack whatever files it is about.
    for (const f of anchorFiles) {
      const named = /^\.strata\/records\/(.+)\.md$/.exec(normalizePath(f));
      const r = named ? this.repo.getRecordById(named[1]!) : null;
      if (r) merged.set(r.id, r);
    }

    for (const r of this.repo.searchRecords(query, 5)) {
      if (!r || merged.has(r.id)) continue;
      const touches = r.files.some((f) => neighborhood.has(normalizePath(f.path)));
      // With a neighbourhood in hand, a record that does not touch it is not about it.
      if (neighborhood.size > 0 && !touches) continue;
      merged.set(r.id, r);
    }

    /** The closest the record gets to what the request named. Lower is nearer. */
    const rankOf = (rec: NonNullable<ReturnType<StrataRepository['getRecordById']>>): number => {
      let best = LEXICAL_RANK;
      for (const p of recordPaths(rec)) {
        const anchor = anchorRank.get(p);
        if (anchor !== undefined) best = Math.min(best, anchor);
        else if (neighborhood.has(p)) best = Math.min(best, NEIGHBOR_RANK);
      }
      return best;
    };

    return [...merged.values()]
      .map((rec, order) => ({ rec, rank: rankOf(rec), order }))
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .map((x) => x.rec)
      .slice(0, this.limits.records);
  }

  /**
   * Anchor a record to the code it is about.
   *
   * Git says what changed; a record is supposed to say why, what was tried, and what
   * followed. That is only usable if the reader can see *which* file, symbol or commit the
   * claim attaches to — otherwise a constraint reads as a general opinion and an agent has
   * no way to tell whether it governs the line it is editing.
   *
   * Only links that hold up are emitted. A path is listed when it is in the neighbourhood,
   * a symbol when the index confirms that file defines it, a commit when the store has it.
   * A record naming a file that no longer exists contributes no link rather than a
   * plausible-looking one.
   */
  private linkRecord(
    rec: NonNullable<ReturnType<StrataRepository['getRecordById']>>, scope: Set<string>,
  ): { refs: string[]; where: string } {
    const refs: string[] = [rec.id];
    const files: string[] = [];
    const symbols: string[] = [];

    for (const f of rec.files) {
      const norm = normalizePath(f.path);
      if (!scope.has(norm)) continue;
      files.push(norm);
      refs.push(`file:${norm}`);
      const defined = new Set(this.graph.symbolsIn(norm).map((s) => s.name));
      for (const name of f.symbols ?? []) {
        if (!defined.has(name)) continue; // the index does not confirm it; do not assert it
        symbols.push(name);
        refs.push(`symbol:${norm}#${name}`);
      }
    }
    for (const e of rec.evidence) {
      if (e.type !== 'git_commit') continue;
      const commit = this.repo.getCommitByHash(String(e.reference));
      if (commit) refs.push(`commit:${commit.shortHash}`);
    }

    const where = symbols.length ? `${files[0]}#${symbols.join(', ')}`
      : files.length ? files.join(', ')
      : '';
    return { refs: refs.slice(0, 5), where };
  }

  /**
   * Where git contradicts what a record says (see `contradictions.ts`).
   *
   * Every part of the record that carries prose is read: title, intent, attempts,
   * constraints, consequences, stated reasons, result, and the descriptions attached to
   * its cited commits. The check uses the commit cache the store already holds; it never
   * runs git and never edits the record.
   */
  private contradictionsOf(rec: NonNullable<ReturnType<StrataRepository['getRecordById']>>): RecordContradiction[] {
    const cached = this.contradictionCache.get(rec.id);
    if (cached) return cached;
    const texts = [
      rec.title, rec.intent,
      ...rec.attempts.flatMap((a) => [a.approach, a.failureReason ?? '', a.replacedBy ?? '']),
      ...rec.constraints.map((c) => c.statement),
      ...rec.consequences.map((c) => c.statement),
      ...(rec.reasons ?? []).map((r) => r.statement),
      rec.result.summary ?? '',
      ...rec.evidence.filter((e) => e.type === 'git_commit' && e.description)
        .map((e) => `${String(e.reference)} ${e.description}`),
    ];
    const found = findContradictions(texts, rec.files.map((f) => normalizePath(f.path)), (hash) => {
      const commit = this.repo.getCommitByHash(hash);
      return commit ? { shortHash: commit.shortHash, changedFiles: commit.changedFiles } : null;
    });
    this.contradictionCache.set(rec.id, found);
    return found;
  }

  /** The marker a contradicted record's statements carry in the agent's pack. */
  private contradictionPrefix(rec: NonNullable<ReturnType<StrataRepository['getRecordById']>>, full: boolean): string {
    const found = this.contradictionsOf(rec);
    if (!found.length) return '';
    if (!full) return 'CONTRADICTED by git (see this record\'s intent) — ';
    const first = describeContradiction(found[0]!);
    return `CONTRADICTED by git (VERIFIED): it ${first}${found.length > 1 ? ` (+${found.length - 1} more)` : ''}. ` +
      'The record says, unchanged: ';
  }

  /** Which files of each named directory the resolver's ceiling left out (human view). */
  private directoryScope(
    anchors: TargetAnchor[], resolved: string[],
  ): { directories?: { directory: string; indexedFiles: number; leftOut: string[] }[] } {
    const covered = new Set(resolved);
    const out: { directory: string; indexedFiles: number; leftOut: string[] }[] = [];
    for (const ref of [...new Set(anchors.filter((a) => a.kind === 'explicit_path').map((a) => a.matched))]) {
      const files = this.graph.directoryFiles(ref);
      if (!files) continue;
      out.push({ directory: ref, indexedFiles: files.length, leftOut: files.filter((f) => !covered.has(f)) });
    }
    return out.length ? { directories: out } : {};
  }

  /**
   * The records, whole, for the human view.
   *
   * Each keeps its own confidence on every part, and says how it relates to the request:
   * a record about a file the target imports is shown, but not as though it were about
   * the target. Commits are listed only when the store confirms them.
   */
  private memoryFor(
    records: ReturnType<ContextEngine['recordsFor']>, anchorFiles: string[], scope: Set<string>,
  ): MemoryRecord[] {
    const anchors = new Set(anchorFiles.map(normalizePath));
    return records.map((rec) => {
      const files = rec.files.map((f) => normalizePath(f.path));
      const about: MemoryRecord['about'] = recordPaths(rec).some((f) => anchors.has(f)) ? 'target'
        : files.some((f) => scope.has(f)) ? 'connected' : 'wording';
      const commits: string[] = [];
      for (const e of rec.evidence) {
        if (e.type !== 'git_commit') continue;
        const commit = this.repo.getCommitByHash(String(e.reference));
        if (commit && !commits.includes(commit.shortHash)) commits.push(commit.shortHash);
      }
      // A symbol a record names is shown with whether the index holds it today: a
      // derived record can name a function a session added that never reached HEAD.
      const symbols: MemoryRecord['symbols'] = [];
      for (const f of rec.files) {
        const path = normalizePath(f.path);
        const defined = new Set(this.graph.symbolsIn(path).map((s) => s.name));
        for (const name of f.symbols ?? []) symbols.push({ file: path, name, indexed: defined.has(name) });
      }
      const statedBy = (s: { statedBy?: string }): { statedBy?: string } => (s.statedBy ? { statedBy: s.statedBy } : {});
      // Present only when the record has any, so a record without keeps its old shape.
      const cited = (e: string[] | undefined): { evidence?: string[] } => (e?.length ? { evidence: e } : {});
      return {
        id: rec.id,
        title: rec.title,
        author: rec.author.name,
        authorType: rec.author.type,
        recordedAt: rec.createdAt,
        about,
        files,
        intent: rec.intent,
        intentConfidence: (rec.intentConfidence as Provenance) ?? 'DECLARED',
        attempts: rec.attempts.map((a) => ({
          ...(a.sequence !== undefined ? { sequence: a.sequence } : {}),
          approach: a.approach,
          status: a.status,
          ...(a.failureReason ? { failureReason: a.failureReason } : {}),
          ...(a.replacedBy ? { replacedBy: a.replacedBy } : {}),
          confidence: (a.confidence as Provenance) ?? 'DECLARED',
          ...cited(a.evidence),
        })),
        constraints: rec.constraints.map((c) => ({
          statement: c.statement, status: c.status, confidence: c.confidence, ...cited(c.evidence), ...statedBy(c),
        })),
        consequences: rec.consequences.map((c) => ({
          statement: c.statement, confidence: c.confidence, ...cited(c.evidence), ...statedBy(c),
        })),
        reasons: (rec.reasons ?? []).map((r) => ({
          statement: r.statement, confidence: r.confidence, evidence: r.evidence ?? [], ...statedBy(r),
          ...(r.precedesAttempt !== undefined ? { precedesAttempt: r.precedesAttempt } : {}),
        })),
        evidence: rec.evidence.map((e) => ({
          type: e.type, reference: e.reference, confidence: e.confidence,
          ...(e.description ? { description: e.description } : {}),
        })),
        symbols,
        result: { status: rec.result.status, ...(rec.result.summary ? { summary: rec.result.summary } : {}) },
        status: rec.status,
        ...(rec.supersededBy ? { supersededBy: rec.supersededBy } : {}),
        commits,
        // Present only when git contradicts the record, so a record without keeps its old shape.
        ...(this.contradictionsOf(rec).length ? { contradictions: this.contradictionsOf(rec) } : {}),
      };
    });
  }

  private attemptStatements(
    records: ReturnType<ContextEngine['recordsFor']>, scope: Set<string>,
  ): Statement[] {
    const out: Statement[] = [];
    for (const rec of records) {
      const link = this.linkRecord(rec, scope);
      for (const a of rec.attempts) {
        // What a later change should know about: anything that did not simply work, and
        // anything that worked and was replaced anyway. Replaced is not failed; it is
        // said as "replaced by", never folded into the status.
        const previous = a.status !== 'succeeded' || !!a.replacedBy;
        if (!previous) continue;
        const prefix = `[${rec.id}]${link.where ? ` ${link.where} —` : ''} ${this.contradictionPrefix(rec, false)}${a.status}: `;
        const body = `${a.approach}` + (a.failureReason ? ` — ${a.failureReason}` : '') +
          (a.replacedBy ? ` — replaced by ${a.replacedBy}` : '');
        out.push({
          statement: capStatement(prefix, body, this.limits.attemptChars),
          // The record's own confidence is carried through, never raised.
          provenance: (a.confidence as Provenance) ?? 'DECLARED',
          evidence: link.refs,
        });
      }
    }
    return out.slice(0, this.limits.attempts);
  }

  private constraintStatements(
    records: ReturnType<ContextEngine['recordsFor']>, scope: Set<string>,
  ): Statement[] {
    const out: Statement[] = [];
    const links = new Map<string, ReturnType<ContextEngine['linkRecord']>>();
    for (const rec of records) {
      const link = this.linkRecord(rec, scope);
      links.set(rec.id, link);
      out.push({
        // A contradiction git shows is said first, so no cap can cut it; the record's own
        // words follow unchanged, with their own confidence.
        statement: capStatement(
          `[${rec.id}]${link.where ? ` ${link.where} —` : ''} ${this.contradictionPrefix(rec, true)}`,
          rec.intent, this.limits.intentChars),
        provenance: (rec.intentConfidence as Provenance) ?? 'DECLARED',
        evidence: link.refs,
      });
    }
    const intents = out.slice(0, this.limits.intents);
    /*
      Reasons somebody stated during the work, after every record's intent.

      Each is a quotation with its own confidence — DECLARED — so it is framed as an
      unverified claim like the intent it sits beside. They come last, so under budget
      pressure a stated reason gives way before any record's intent does.
    */
    const reasons: Statement[] = [];
    for (const rec of records) {
      if (!rec.reasons?.length) continue;
      const link = links.get(rec.id)!;
      for (const r of rec.reasons) {
        reasons.push({
          statement: capStatement(`[${rec.id}]${link.where ? ` ${link.where} —` : ''} ${this.contradictionPrefix(rec, false)}`,
            r.statement, this.limits.intentChars),
          provenance: (r.confidence as Provenance) ?? 'DECLARED',
          evidence: link.refs,
        });
      }
    }
    return [...intents, ...reasons.slice(0, this.limits.reasons)];
  }

  /**
   * Conditions a later change still has to respect.
   *
   * Separate from the record's intent, which says what one change was for. A
   * constraint is only a constraint because someone recorded it as one — nothing
   * here promotes an old configuration value into a requirement because it
   * survived, and a constraint whose status is SUPERSEDED is still shown, marked,
   * because "this used to bind and no longer does" is knowledge too.
   */
  private explicitConstraints(
    records: ReturnType<ContextEngine['recordsFor']>, scope: Set<string>,
  ): Statement[] {
    const out: Statement[] = [];
    for (const rec of records) {
      const link = this.linkRecord(rec, scope);
      for (const c of rec.constraints) {
        const status = c.status === 'UNKNOWN' ? '' : ` [${c.status}]`;
        out.push({
          statement: capStatement(
            `[${rec.id}]${status}${link.where ? ` ${link.where} —` : ''} ${this.contradictionPrefix(rec, false)}`,
            c.statement, this.limits.constraintChars),
          provenance: c.confidence,
          evidence: [...link.refs, ...c.evidence],
        });
      }
    }
    return out.slice(0, this.limits.constraints);
  }

  private consequenceStatements(
    records: ReturnType<ContextEngine['recordsFor']>, scope: Set<string>,
  ): Statement[] {
    const out: Statement[] = [];
    for (const rec of records) {
      const link = this.linkRecord(rec, scope);
      for (const c of rec.consequences) {
        out.push({
          statement: capStatement(
            `[${rec.id}]${link.where ? ` ${link.where} —` : ''} ${this.contradictionPrefix(rec, false)}`,
            c.statement, this.limits.consequenceChars),
          // The consequence carries its own confidence. A record author may state one
          // outright, and a deriver may attach evidence for it; neither is promoted,
          // and neither is flattened to the other's level.
          provenance: c.confidence,
          evidence: [...link.refs, ...c.evidence],
        });
      }
    }
    return out.slice(0, this.limits.consequences);
  }

  private whyStatements(
    target: { files: string[]; symbols: { name: string }[]; resolution: string },
    neighbors: CodeNeighbor[], history: HistoricalEvent[],
    records: ReturnType<ContextEngine['recordsFor']>,
  ): Statement[] {
    const out: Statement[] = [];
    if (target.files.length) {
      /*
        The list is capped for space, and the cap says so.

        It used to be cut at six with nothing to show for it, under VERIFIED: asked to list
        every export of an eight-export file, the pack stated "Target defines" six of them as
        if that were the set. A VERIFIED statement must be complete or say what it leaves
        out, so a longer list states the full count and how many are not named here.
      */
      const exported = target.files.flatMap((f) =>
        this.graph.symbolsIn(f).filter((s) => s.exported).map((s) => s.name));
      const shown = exported.slice(0, MAX_DEFINES_LISTED);
      if (shown.length) {
        const omitted = exported.length - shown.length;
        out.push({
          statement: omitted
            ? `Target defines ${exported.length} exported symbols; ${shown.length} listed here, ` +
              `${omitted} not listed: ${shown.join(', ')}.`
            : `Target defines ${shown.join(', ')}.`,
          provenance: 'VERIFIED',
          evidence: target.files.slice(0, 3),
        });
      }
    }
    const inbound = neighbors.filter((n) => n.reasons.some((r) => r.startsWith('imports') || r.startsWith('references')));
    if (inbound.length) {
      out.push({
        statement: `${inbound.length} file(s) in the neighbourhood depend on the target; changing its exported surface reaches them.`,
        provenance: 'VERIFIED',
        evidence: inbound.slice(0, 4).map((n) => n.path),
      });
    }
    if (history.length) {
      out.push({
        statement: `This area has ${history.length} recorded commit(s) touching it; the subjects are the authors' own descriptions and are not independently verified.`,
        provenance: 'DECLARED',
        evidence: history.slice(0, 4).map((h) => h.shortHash),
      });
    }
    if (records.length) {
      out.push({
        statement: `${records.length} Strata record(s) reference this area.`,
        provenance: 'VERIFIED',
        evidence: records.map((r) => r.id),
      });
    }
    return out;
  }

  /**
   * What the pack rests on, with the nearest record's own citations first.
   *
   * The evidence list is the first thing the budget reclaims, and that is right for most
   * of it — a commit line here restates a commit already described above. The exception
   * is the citations belonging to the record about the primary target. A record's
   * `evidence[]` is the set of commits, files and tests its author pointed at, and those
   * references survive nowhere else in the pack once the record's own statements have
   * been capped: the statement text is cut at a fixed width, and the commits it names
   * past that width are simply gone.
   *
   * So they lead the list, and `protectedCount` tells the budget how many of them to
   * keep. Ordering alone does the work — the trimmer pops from the end — and the count is
   * a floor, not an allocation: nothing is added to the pack to fill it.
   */
  private collectEvidence(
    history: HistoricalEvent[], records: ReturnType<ContextEngine['recordsFor']>, files: string[],
  ): { items: string[]; protectedCount: number } {
    const out = new Set<string>();
    const nearest = records[0];
    if (nearest) {
      out.add(`record ${nearest.id}`);
      for (const e of nearest.evidence) out.add(`${e.type}:${String(e.reference).slice(0, 40)}`);
    }
    const protectedCount = Math.min(out.size, MAX_PROTECTED_EVIDENCE);

    for (const h of history) out.add(`commit ${h.shortHash} (${h.subject.slice(0, 60)})`);
    for (const r of records) {
      out.add(`record ${r.id}`);
      for (const e of r.evidence) out.add(`${e.type}:${String(e.reference).slice(0, 40)}`);
    }
    for (const f of files.slice(0, 4)) out.add(`file ${f}`);
    return { items: [...out].slice(0, 16), protectedCount };
  }

  // ---------------------------------------------------------------- budget

  private countProvenance(pack: ContextPack): void {
    const counts: Record<Provenance, number> = { VERIFIED: 0, DECLARED: 0, INFERRED: 0, UNKNOWN: 0 };
    const tally = (s: Statement[]): void => { for (const x of s) counts[x.provenance]++; };
    tally(pack.whyThisAreaMatters);
    tally(pack.decisionsAndConstraints);
    tally(pack.previousAttempts);
    tally(pack.consequences);
    for (const r of pack.relationships) counts[r.provenance]++;
    for (const h of pack.historicalContext) counts[h.provenance]++;
    for (const b of pack.currentBehavior) counts[b.provenance]++;
    for (const c of pack.callSites) counts[c.provenance]++;
    for (const d of pack.historicalDecisions) {
      counts[d.statusProvenance]++;
      tally(d.whyItMatters);
      if (d.caution) counts[d.caution.provenance]++;
      for (const s of d.support) counts[s.provenance]++;
    }
    // Each stated uncertainty is a claim too — that nothing is known — and it is counted
    // so the tally describes the whole pack rather than only its confident half.
    counts.UNKNOWN += pack.uncertainty.length;
    pack.provenanceSummary = counts;
  }

  /**
   * Trim to the token budget, lowest priority first.
   *
   * The order is the priority list inverted — target, direct relationships, direct
   * historical changes, historical evidence, constraints, indirect context — so the
   * things an agent cannot recover cheaply are the last to go.
   *
   * The change that matters here is where history sits. It used to be trimmed fifth, at
   * `length > 3`, while second-ring neighbours and symbol listings survived to steps
   * eight and ten. Generic code neighbourhood is the cheapest material in the pack to
   * re-derive — the agent is about to open those files anyway — and it was outliving the
   * commits that explain why the code is the way it is. Now indirect and lexical-only
   * commits go early, and a commit that changed the target itself is the last thing
   * dropped before the pack stops being a pack.
   *
   * Trimming is recorded in `sectionsTruncated` so a short pack is distinguishable from a
   * pack about a small area.
   */
  private applyBudget(
    pack: ContextPack, maxTokens: number,
    anchoredMemory: { evidenceFloor: number; selectedRecords: string[]; callSiteFloor?: number } = {
      evidenceFloor: 0, selectedRecords: [],
    },
  ): void {
    /** Drop the lowest-ranked commit whose relation is in *relations*. */
    const dropCommit = (relations: string[], requireUndiffed: boolean): boolean => {
      for (let i = pack.historicalContext.length - 1; i >= 0; i--) {
        const h = pack.historicalContext[i]!;
        if (!relations.includes(h.relation)) continue;
        if (requireUndiffed && (h.changes?.length || h.historicalFiles?.length)) continue;
        pack.historicalContext.splice(i, 1);
        return true;
      }
      return false;
    };
    const indirect = ['INDIRECTLY_RELATED', 'LEXICAL_ONLY'];

    /*
      How far each memory section may be trimmed.

      Measured once, before anything is removed, from the statements the nearest record
      contributes. Sections are ordered nearest-record-first, so keeping `floor` entries
      keeps that record's own statements and nothing else's.
    */
    const nearest = anchoredMemory.selectedRecords[0];
    const floorFor = (list: Statement[]): number => {
      if (!nearest) return 1;
      const own = list.filter((s) => s.evidence.includes(nearest)).length;
      return Math.max(1, Math.min(ANCHORED_MEMORY_FLOOR, own));
    };
    const floors = {
      consequences: floorFor(pack.consequences),
      attempts: floorFor(pack.previousAttempts),
      intents: floorFor(pack.decisionsAndConstraints),
      constraints: floorFor(pack.constraints),
    };

    /*
      Decision trimming, cheapest part first.

      A decision is several things stacked: a status, a before, an after, supporting
      evidence, a rationale and possibly a caution. They are not equally valuable. The
      status line is the whole point and costs one line; the quoted before/after is what
      makes the status checkable; the rationale restates things stated elsewhere. So the
      rationale goes first, then supporting quotes, then quoted lines, and a decision is
      dropped whole only when nothing else remains.
    */
    const thinDecision = (): boolean => {
      for (let i = pack.historicalDecisions.length - 1; i >= 0; i--) {
        const d = pack.historicalDecisions[i]!;
        if (d.whyItMatters.length > 1) { d.whyItMatters.pop(); return true; }
        if (d.consequences.length > 1) { d.consequences.pop(); return true; }
        if (d.historicalState.length + d.currentState.length > 2) {
          if (d.historicalState.length > 1) { d.historicalState.pop(); d.historicalOmitted++; }
          else if (d.currentState.length > 1) { d.currentState.pop(); d.currentOmitted++; }
          else continue;
          return true;
        }
      }
      return false;
    };

    const trimOrder: { name: string; trim: () => boolean }[] = [
      /*
        Explanations go before evidence.

        The notices say how to read a DECLARED claim and an UNKNOWN decision; the boundary
        on each line — UNVERIFIED CLAIM, NOT ESTABLISHED — says what each one is, and is
        never trimmed. Measured on six real packs: with the notices placed late, the budget
        thinned VERIFIED quotes to keep them, and where they did give way they took the
        per-line boundary with them. So they are the first thing removed, and the restore
        pass below gives them back whenever trimming leaves room.
      */
      { name: FRAMING_STEP, trim: () => {
        const framed = hasDeclaredRecordClaims(pack) || pack.historicalDecisions.some((d) => d.status === 'UNKNOWN');
        if (pack.diagnostics.claimsCompact || !framed) return false;
        pack.diagnostics.claimsCompact = true;
        return true;
      } },
      // The nearest record's own citations sit at the front of this list and stay: they
      // are the only place its cited commits survive once its statements have been capped.
      { name: 'evidence', trim: () => pack.evidence.length > anchoredMemory.evidenceFloor && pop(pack.evidence) },
      // Filler commits before anything else. They are in the pack only to show that the
      // ranking beat them; they are the first thing the budget should reclaim.
      { name: 'history(lexical-only)', trim: () => dropCommit(['LEXICAL_ONLY'], false) },
      { name: 'neighborhood(distance>=2)', trim: () => {
        const idx = pack.codeNeighborhood.findIndex((n) => n.distance >= 2);
        if (idx === -1) return false;
        pack.codeNeighborhood.splice(idx, 1);
        return true;
      } },
      { name: 'history(indirect)', trim: () => dropCommit(indirect, false) },
      { name: 'relationships', trim: () => pack.relationships.length > 4 && pop(pack.relationships) },
      { name: 'neighborhood', trim: () => pack.codeNeighborhood.length > 3 && pop(pack.codeNeighborhood) },
      /*
        Recorded memory trims after the neighbourhood, and never to nothing.

        Consequences had no floor while attempts had one, so on a real target the
        budget emptied the section outright: three recorded consequences went in
        and the pack rendered "UNKNOWN — nothing recorded", which is a different
        claim and a false one. A neighbourhood entry names a file the reader can
        open; a recorded consequence is knowledge that exists nowhere else in the
        repository, so it is worth more per token and goes later.
      */
      { name: 'consequences', trim: () => pack.consequences.length > floors.consequences && pop(pack.consequences) },
      { name: 'previous-attempts', trim: () => pack.previousAttempts.length > floors.attempts && pop(pack.previousAttempts) },
      // Related history without a diff attached: a pointer, and cheaper to lose than the
      // neighbourhood entry that at least names a file worth opening.
      { name: 'history(related,undiffed)', trim: () =>
        pack.historicalContext.length > 2 && dropCommit(['DIRECTLY_RELATED'], true) },
      { name: 'change-chains', trim: () => pop(pack.changeChains) },
      // The uses of a named symbol, and one call site per named file, lead the list and
      // stay: they are direct target evidence, and the rest are the ones to lose first.
      { name: 'call-sites', trim: () =>
        pack.callSites.length > Math.max(3, anchoredMemory.callSiteFloor ?? 0) && pop(pack.callSites) },
      { name: 'constraints', trim: () => pack.decisionsAndConstraints.length > floors.intents && pop(pack.decisionsAndConstraints) },
      // Recorded constraints trim after the record intents above them: a condition the
      // next change has to respect outlives the story of the change that found it.
      // The last one is kept until the minimal stages, like the target itself.
      { name: 'recorded-constraints', trim: () => pack.constraints.length > floors.constraints && pop(pack.constraints) },
      // Below here the pack is already minimal; these strip detail from what remains
      // rather than dropping whole findings, so the target survives to the end.
      { name: 'symbol-lists', trim: () => {
        const withSymbols = pack.codeNeighborhood.find((n) => n.symbols?.length);
        if (!withSymbols) return false;
        delete withSymbols.symbols;
        return true;
      } },
      { name: 'why', trim: () => pack.whyThisAreaMatters.length > 1 && pop(pack.whyThisAreaMatters) },
      { name: 'target-symbols', trim: () => {
        if (!pack.target.symbols.length) return false;
        pack.target.symbols = [];
        return true;
      } },
      /*
        Shed commits that carry no diff before shedding any that do.

        A commit listed by subject alone is the thing this feature exists to replace. A
        commit with its diff attached answers the question outright, and is trimmed only
        once nothing cheaper is left.
      */
      { name: 'undiffed-commits', trim: () => {
        /*
          Not blindly, though: a commit a retained decision cites is not a spare
          pointer, whether or not a diff happened to be attached to it.

          Diffs are rationed to two commits per pack, so the commit that settled
          the target's current shape routinely carries none — and this stage, which
          only asked "does it have a diff?", shed exactly that commit while keeping
          a neighbouring one whose diff it had. The pack was then left stating a
          decision against a commit it no longer listed anywhere.
        */
        const cited = new Set(pack.historicalDecisions.map((d) => d.commit));
        /*
          Nor the commits the history ranking put first, while another can go.

          Decisions are chosen for being settled and small, so a change that was reverted
          and re-landed is rarely one, and its commits carried neither a decision nor a
          diff. A line each is cheap; the top of the ranking stays until nothing else is
          left.
        */
        const top = new Set(pack.historicalContext.filter((h) => h.matchesRequest)
          .slice(0, RANKED_HISTORY_KEPT).map((h) => h.hash));
        const drop = (wanted: (h: HistoricalEvent) => boolean): boolean => {
          for (let i = pack.historicalContext.length - 1; i >= 0; i--) {
            const h = pack.historicalContext[i]!;
            if (h.changes?.length || h.historicalFiles?.length) continue;
            if (!wanted(h)) continue;
            pack.historicalContext.splice(i, 1);
            return true;
          }
          return false;
        };
        /*
          The top is not shed here at all. A third pass used to drop it once nothing else
          was undiffed, while lower commits kept their diffs. Their diffs are thinned
          below, and the top goes only in `history(minimal)`, from the end of the
          ranking.
        */
        return drop((h) => !cited.has(h.shortHash) && !top.has(h.hash) && h.relation !== 'DIRECT_TARGET')
            || drop((h) => !cited.has(h.shortHash) && !top.has(h.hash));
      } },
      /*
        Recovered file content, and the target's own goes last.

        A file that was deleted is the one kind of evidence an agent cannot reach at all
        without going to the object store — it is not in the working tree to be read. When
        it hangs off the commit that changed the target, it is the most expensive thing in
        the pack to lose, so excerpts belonging to anything else are shed first.
      */
      { name: 'historical-file-excerpts', trim: () => {
        const pass = (wanted: (h: HistoricalEvent) => boolean): boolean => {
          for (let i = pack.historicalContext.length - 1; i >= 0; i--) {
            const event = pack.historicalContext[i]!;
            if (!wanted(event)) continue;
            const f = event.historicalFiles;
            if (f?.length) { f.pop(); if (!f.length) delete event.historicalFiles; return true; }
          }
          return false;
        };
        return pass((h) => !CORE_RELATIONS.includes(h.relation)) ||
               pass((h) => h.relation !== 'DIRECT_TARGET') ||
               pass(() => true);
      } },
      /*
        Trim whichever commit is currently carrying the most diff, not the last one
        listed. Draining from the end starves exactly the wrong commit: a grab-bag
        "V0.1 complete" ranked first kept a 200-line hunk while the four-line schema
        flip that actually explained the code — ranked second — lost its diff entirely.
        Fair-share keeps every diffed commit represented until the budget really bites.
      */
      { name: 'diff-hunks', trim: () => {
        let worstIdx = -1;
        let worstSize = 0;
        pack.historicalContext.forEach((h, i) => {
          const size = (h.changes ?? []).reduce(
            (n, c) => n + c.hunks.reduce((m, hunk) => m + hunk.split('\n').length, 0), 0);
          if (size > worstSize) { worstSize = size; worstIdx = i; }
        });
        if (worstIdx === -1) return false;
        /*
          Never strip the last commit still carrying evidence while another has more.
          Trimming purely by size sacrificed the small, surgical diff — a key flip — and
          kept the bulky one, which is the opposite of useful: a large diff is usually the
          bulk work, and the bulk work is rarely the surprise.
        */
        const carrying = pack.historicalContext.filter((h) => h.changes?.length).length;
        if (carrying === 1) {
          const only = pack.historicalContext[worstIdx]!.changes!;
          const biggestOnly = only.reduce((a, b) =>
            b.hunks.join('').length > a.hunks.join('').length ? b : a, only[0]!);
          if (biggestOnly.hunks.length > 1) { biggestOnly.hunks.pop(); biggestOnly.hunksOmitted++; return true; }
        }
        const changes = pack.historicalContext[worstIdx]!.changes!;
        const biggest = changes.reduce((a, b) =>
          b.hunks.join('').length > a.hunks.join('').length ? b : a, changes[0]!);
        if (biggest.hunks.length > 1) { biggest.hunks.pop(); biggest.hunksOmitted++; return true; }
        const idx = changes.indexOf(biggest);
        changes.splice(idx, 1);
        if (!changes.length) delete pack.historicalContext[worstIdx]!.changes;
        return true;
      } },
      { name: 'decision-detail', trim: thinDecision },
      { name: 'neighborhood(minimal)', trim: () => pack.codeNeighborhood.length > 1 && pop(pack.codeNeighborhood) },
      { name: 'current-behavior', trim: () => {
        // Signatures before whole files: a file named with one export quoted still tells
        // the agent where to look, which a removed entry does not.
        for (const b of pack.currentBehavior) {
          if (b.signatures.length > 1) { b.signatures.pop(); b.signaturesOmitted++; return true; }
        }
        return pack.currentBehavior.length > 1 && pop(pack.currentBehavior);
      } },
      { name: 'uncertainty', trim: () => pop(pack.uncertainty) },
      { name: 'history(minimal)', trim: () => pop(pack.historicalContext) },
      { name: 'decisions(minimal)', trim: () => pack.historicalDecisions.length > 1 && pop(pack.historicalDecisions) },
      { name: 'relationships(minimal)', trim: () => pop(pack.relationships) },
    ];

    const trimmed = new Set<string>();
    let guard = 0;
    /*
      The notice is written before each measurement, not after the loop.

      Rendering appends `_Truncated to fit N tokens; trimmed: ..._`, and that line grows
      with every step recorded. Setting the flags only at the end meant the loop measured
      a string shorter than the one the caller receives, so a pack could stop trimming at
      the budget and be handed over above it — measured at 3,214 against a budget of
      3,200. Same class of fault as the provenance tally that used to be counted late.
    */
    const record = (): void => {
      pack.diagnostics.truncated = trimmed.size > 0;
      pack.diagnostics.sectionsTruncated = [...trimmed];
      // Recomputed on every pass, so the notice is measured inside the budget like the
      // truncation line above it rather than appearing after the last measurement.
      const present = new Set<string>();
      for (const s of [...pack.decisionsAndConstraints, ...pack.constraints,
                       ...pack.previousAttempts, ...pack.consequences]) {
        for (const e of s.evidence) if (/^REC-/.test(e)) present.add(e);
      }
      pack.diagnostics.recordsOmitted =
        anchoredMemory.selectedRecords.filter((id) => !present.has(id));
      this.countProvenance(pack);
    };
    record();
    let estimate = estimateTokens(renderPack(pack));
    while (estimate > maxTokens && guard++ < 500) {
      let didTrim = false;
      for (const step of trimOrder) {
        if (step.trim()) {
          trimmed.add(step.name);
          didTrim = true;
          break;
        }
      }
      if (!didTrim) break; // nothing left that is safe to remove
      record();
      estimate = estimateTokens(renderPack(pack));
    }

    /*
      Give the notices back if their removal bought nothing.

      Trimming is greedy: the notices go when the pack is over budget at that step, and a
      later step may then remove a whole commit anyway — after which there is room for
      them again. Measured: a pack compacted its framing, still had to drop
      history, and finished some 200 tokens under budget without the notice. The
      compaction is rendering only, so it can be undone exactly; it is kept only when
      undoing it would break the budget.
    */
    if (pack.diagnostics.claimsCompact && trimmed.has(FRAMING_STEP)) {
      // Measured with the step still listed, which only overstates the size: if it fits
      // like this it fits without the name. The record of what was trimmed, and in what
      // order, changes only when the restoration is kept.
      pack.diagnostics.claimsCompact = false;
      if (estimateTokens(renderPack(pack)) > maxTokens) {
        pack.diagnostics.claimsCompact = true;
      } else {
        trimmed.delete(FRAMING_STEP);
      }
    }

    record();

    /*
      Measure the pack that is actually returned, not the one measured mid-loop.

      Rendering appends a truncation notice and a provenance tally that the loop's own
      estimate never saw, so the text handed to the caller was slightly larger than the
      number reported beside it — enough to land over the budget while `budgetExceeded`
      still read false. The figures now describe the same string the caller receives.
    */
    // Counts describe the trimmed pack, so they report what the caller gets rather
    // than what ranking started with.
    pack.diagnostics.scope = {
      targets: pack.target.files.length,
      neighborhoodFiles: pack.codeNeighborhood.length,
      symbols: pack.target.symbols.length,
      relationships: pack.relationships.length,
    };
    /*
      Measure to a fixed point.

      When the budget cannot be met the render says so, and the notice quotes the
      token count — so storing a count changes the text whose count was stored, and
      the figure beside the pack disagreed with the pack by the width of its own
      digits. Re-measuring until it stops moving costs at most a couple of renders
      and makes the reported number describe the string the caller actually gets.
    */
    for (let pass = 0; pass < 4; pass++) {
      const measured = estimateTokens(renderPack(pack));
      const settled = measured === pack.diagnostics.estimatedTokens;
      pack.diagnostics.estimatedTokens = measured;
      // Say so rather than overshooting quietly: a caller sizing an agent's context
      // window needs to know the number it asked for was not achievable.
      pack.diagnostics.budgetExceeded = measured > maxTokens;
      if (settled) break;
    }
  }
}

/**
 * The pack returned when the query named a file the index does not hold.
 *
 * Empty on purpose. The alternative — quietly running the word search instead — returns a
 * complete-looking pack about some other file, and there is nothing in it to tell a reader
 * that the question was never answered. A named target that cannot be found is a result,
 * and this is what that result looks like.
 */
function notFoundPack(
  query: string, unresolved: string[], indexed: boolean, filesInIndex: number,
  depth: number, maxTokens: number, notes: string[],
): ContextPack {
  return {
    target: { query, type: 'file', resolution: 'target_not_found', files: [], symbols: [],
              anchors: [], unresolved,
              confidence: { level: 'NOT_FOUND', reason: describeMissing(unresolved) } },
    targetNotFound: true,
    whyThisAreaMatters: [], codeNeighborhood: [], currentBehavior: [], callSites: [],
    relationships: [], historicalDecisions: [], historicalContext: [],
    changeChains: [], decisionsAndConstraints: [], constraints: [],
    previousAttempts: [], consequences: [],
    evidence: [], uncertainty: [],
    provenanceSummary: { VERIFIED: 0, DECLARED: 0, INFERRED: 0, UNKNOWN: 0 },
    diagnostics: {
      indexed, filesInIndex, depth, maxTokens,
      scope: { targets: 0, neighborhoodFiles: 0, symbols: 0, relationships: 0 },
      estimatedTokens: 0, truncated: false, budgetExceeded: false, sectionsTruncated: [],
      recordsOmitted: [], notes,
    },
  };
}

/**
 * The one line of a recovered file worth quoting beside a decision.
 *
 * A test added alongside a change is the closest thing a repository holds to a statement
 * of intent in the author's own words — and it is one line in a file of setup. Dropping
 * forty lines of scaffolding into the pack and leaving the reader to find the point is a
 * second search, which is the thing this engine exists to remove.
 *
 * Two passes, both mechanical. First a line that names what the decision changed *and*
 * reads like a claim; then either alone. The line is quoted verbatim, so a reader who
 * disagrees with the choice can see exactly what was chosen and why.
 */
function evidenceLine(lines: string[], subject: string[]): string | null {
  const claim = /\b(expect|assert|should|SUCCESS|FAIL|PASS|toBe|toEqual|same|different)\b|✅|❌/i;
  const usable = lines.filter((l) => l.trim().length > 12 && l.trim().length < 200);
  const namesSubject = (l: string): boolean =>
    subject.some((w) => matchesWord(l, w.toLowerCase()));

  return usable.find((l) => namesSubject(l) && claim.test(l))?.trim()
      ?? usable.find((l) => claim.test(l))?.trim()
      ?? usable.find(namesSubject)?.trim()
      ?? null;
}

/**
 * The paths a record is about, for deciding how near it is to the target: the files it
 * names, and its own file, so a record the request named by its id is about the target.
 */
function recordPaths(rec: { id: string; files: { path: string }[] }): string[] {
  return [...rec.files.map((f) => normalizePath(f.path)), recordFilePath(rec.id)];
}

/** Compare paths in one direction: the index stores POSIX, records may hold Windows separators. */
function normalizePath(p: string): string {
  return p.split(String.fromCharCode(92)).join('/');
}

function pop(arr: unknown[]): boolean {
  if (!arr.length) return false;
  arr.pop();
  return true;
}

/**
 * Names in a request that can only be code: identifiers of six characters or more with a
 * capital after a lower-case letter, or an underscore (`appendPlugins`,
 * `__NEXT_EXPERIMENTAL_APP_NEW_SCROLL_HANDLER`). Paths are left out; they name the target.
 */
export function codeTerms(query: string): string[] {
  const out = new Set<string>();
  for (const m of query.replace(/\S*[\\/]\S*/g, ' ').matchAll(/[A-Za-z_$][\w$]*/g)) {
    const t = m[0];
    if (t.length >= 6 && (/[a-z][A-Z]/.test(t) || t.includes('_'))) out.add(t);
  }
  return [...out];
}
