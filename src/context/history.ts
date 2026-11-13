/**
 * History anchoring: find the commits that changed *this target*, then rank inside them.
 *
 * The failure this replaces
 * ------------------------
 * History used to be gathered for the whole expanded neighbourhood and scored with one
 * blended number — how many neighbourhood files a commit touched, then recency. Three
 * things went wrong with that, and all three were measured rather than imagined.
 *
 * The overlap count saturated. It was taken from a list already truncated to four paths,
 * so every commit touching four or more neighbourhood files tied at four, and the tie was
 * broken by date. A wide neighbourhood therefore made *every* large commit equal and
 * handed the ordering to recency alone.
 *
 * Recency then buried the answer. The commit that created the file under discussion was
 * older than several commits that had merely brushed against its neighbours, so it ranked
 * below them and fell off the end of the list — and once it is not in the list, nothing
 * downstream can put its diff back.
 *
 * And the neighbourhood itself was only as good as the resolver. One extra word in the
 * query turned an exact path into five lexical guesses, whose neighbourhoods dragged in
 * four unrelated subsystems, whose commits then out-competed the real one.
 *
 * What replaces it
 * ----------------
 * Evidence is classified by its relationship to the *resolved target* before anything is
 * ranked, and the classes are ordered absolutely:
 *
 *   DIRECT_TARGET      changed a file the query named
 *   DIRECTLY_RELATED   changed something one edge away from it
 *   INDIRECTLY_RELATED changed something further out in the neighbourhood
 *   LEXICAL_ONLY       shares words with the query and touched none of it
 *
 * No amount of recency, size or vocabulary moves a commit between classes. Within a class
 * the comparison is lexicographic over six signals rather than a weighted sum, for the
 * same reason: in a sum, a large enough value in one term buries every other term, which
 * is exactly how the decisive commit was lost. Recency is the last of the six, and it can
 * only break a tie between commits that are already equally related to the target.
 *
 * Nothing here is specific to a repository, a commit or a subject line. The rules are
 * "did this commit change the thing that was asked about", "did it create it", "did it
 * last change it" — all mechanical, all derivable from the index.
 */

import { CodeGraph, TargetAnchor, matchesWord, tokenize } from '../code/graph.js';
import { StrataRepository } from '../storage/repository.js';
import { HistoricalEvent, HistoryRelation } from './pack.js';

const RELATION_RANK: Record<HistoryRelation, number> = {
  DIRECT_TARGET: 0,
  DIRECTLY_RELATED: 1,
  INDIRECTLY_RELATED: 2,
  LEXICAL_ONLY: 3,
};

/** Classes that count as core historical context. Everything else is filler. */
export const CORE_RELATIONS: HistoryRelation[] = ['DIRECT_TARGET', 'DIRECTLY_RELATED'];

/**
 * How many commits to pull per source.
 *
 * Deliberately far above the number that survives into the pack. Truncating the candidate
 * pool by date is how the origin commit disappeared in the first place: a cap applied
 * before classification is a recency filter wearing a limit's clothes.
 */
const CANDIDATE_LIMIT = 200;

/** Lexical-only commits are filler, and at most this many are ever carried. */
const MAX_LEXICAL_ONLY = 2;
/** Below this many core commits, filler is allowed to top the list up. */
const CORE_SUFFICIENT = 3;
/** Commits the request was found to be about, taken before any chain end is reserved. */
const LEADING_MATCHED = 3;

export interface AnchoredHistoryInput {
  /** Resolved targets, best first. */
  anchors: TargetAnchor[];
  /** Files one edge from an anchor. */
  related: string[];
  /** The rest of the neighbourhood. */
  indirect: string[];
  /** Query terms, used only to find lexical-only filler. */
  queryTerms: string[];
  /**
   * Commits that wrote the target's lines the request names, by how many of those lines
   * each wrote (`ContextEngine.namedLineAuthors`).
   */
  lineAuthors?: Map<string, number>;
  /**
   * The first commits of a shallow history (`GitClient.shallowRoots`). Every file older than
   * the history appears in one, which therefore created none of them.
   */
  shallowRoots?: Set<string>;
  limit: number;
}

interface Candidate {
  hash: string;
  authoredAt: number;
  /** Every file this commit touched that is in scope, by class. */
  anchorFiles: string[];
  relatedFiles: string[];
  indirectFiles: string[];
  relation: HistoryRelation;
  /** Anchor files the developer named outright, as opposed to lexical guesses. */
  explicitHits: number;
  /** Anchor files that define a symbol the query named. */
  symbolHits: number;
  /** The request's words that the commit's message uses, counted once each. */
  wordHits: number;
  /** 1 when the commit reverts another, or another commit in the pool reverts it. */
  revertChain: number;
  /** Lines of the target the request names that this commit wrote, as they stand at HEAD. */
  lineHits: number;
  /** 2 = introduced an anchor, 1 = last changed one, 0 = neither. */
  structuralRole: number;
}

export class HistoryAnchoring {
  private graph: CodeGraph;
  private repo: StrataRepository;

  constructor(graph: CodeGraph, repo: StrataRepository) {
    this.graph = graph;
    this.repo = repo;
  }

  public gather(input: AnchoredHistoryInput): HistoricalEvent[] {
    const anchorFiles = input.anchors.map((a) => a.file);
    if (!anchorFiles.length && !input.related.length && !input.indirect.length) return [];

    // Named outright: not a word-ranking guess, and not a file a plain word happened to spell.
    const explicit = new Set(input.anchors.filter((a) => a.kind !== 'lexical' && !a.plainWord).map((a) => a.file));
    const withSymbols = new Set(input.anchors.filter((a) => a.symbols.length).map((a) => a.file));
    const anchorSet = new Set(anchorFiles);
    const relatedSet = new Set(input.related.filter((f) => !anchorSet.has(f)));
    const indirectSet = new Set(
      input.indirect.filter((f) => !anchorSet.has(f) && !relatedSet.has(f)));

    const candidates = new Map<string, Candidate>();
    const ensure = (hash: string, authoredAt: number): Candidate => {
      let c = candidates.get(hash);
      if (!c) {
        c = { hash, authoredAt, anchorFiles: [], relatedFiles: [], indirectFiles: [],
              relation: 'LEXICAL_ONLY', explicitHits: 0, symbolHits: 0, wordHits: 0, revertChain: 0,
              lineHits: 0, structuralRole: 0 };
        candidates.set(hash, c);
      }
      return c;
    };

    /*
      Anchors first, and without a recency cap.

      `commitsForFiles` sorts by date before it slices, so any limit applied here is a
      "most recent N" filter. For the target itself that is unacceptable — the commit
      that explains why the code looks like this is routinely the oldest one that touched
      it — so the whole file history is taken and the trimming happens after ranking.
    */
    for (const commit of this.graph.commitsForFiles(anchorFiles, CANDIDATE_LIMIT)) {
      const c = ensure(commit.hash, commit.authored_at);
      for (const f of commit.files) {
        if (!anchorSet.has(f)) continue;
        c.anchorFiles.push(f);
        if (explicit.has(f)) c.explicitHits++;
        if (withSymbols.has(f)) c.symbolHits++;
      }
    }
    for (const commit of this.graph.commitsForFiles([...relatedSet], CANDIDATE_LIMIT)) {
      const c = ensure(commit.hash, commit.authored_at);
      for (const f of commit.files) if (relatedSet.has(f)) c.relatedFiles.push(f);
    }
    for (const commit of this.graph.commitsForFiles([...indirectSet], CANDIDATE_LIMIT)) {
      const c = ensure(commit.hash, commit.authored_at);
      for (const f of commit.files) if (indirectSet.has(f)) c.indirectFiles.push(f);
    }
    /*
      Lexical matches enter the pool, and lose.

      They are carried not because they are wanted but because leaving them out would make
      the ordering unfalsifiable: the claim is that a commit which merely shares vocabulary
      cannot outrank one that changed the target, and that claim needs something to beat.
    */
    for (const commit of this.graph.commitsMatchingTerms(input.queryTerms, MAX_LEXICAL_ONLY * 4)) {
      ensure(commit.hash, commit.authored_at);
    }

    for (const c of candidates.values()) {
      c.relation = c.anchorFiles.length ? 'DIRECT_TARGET'
        : c.relatedFiles.length ? 'DIRECTLY_RELATED'
        : c.indirectFiles.length ? 'INDIRECTLY_RELATED'
        : 'LEXICAL_ONLY';
      c.lineHits = c.relation === 'DIRECT_TARGET' ? input.lineAuthors?.get(c.hash) ?? 0 : 0;
    }

    this.markStructuralRoles(candidates, anchorFiles, input.shallowRoots ?? new Set());
    // The words that name a target say what is asked about, not what about it is asked.
    const naming = new Set(input.anchors.filter((a) => a.kind !== 'lexical').flatMap((a) => tokenize(a.matched)));
    this.markMessages(candidates, input.queryTerms.filter((t) => !naming.has(t)));

    const ranked = [...candidates.values()].sort(compare);
    const chosen = this.select(ranked, input.limit);
    return this.toEvents(chosen);
  }

  /**
   * Mark the ends of each anchor's chain.
   *
   * "Earliest commit that touched this file" is a mechanical stand-in for "the commit
   * that introduced it", and "latest" for "the state you are looking at now". Keeping
   * both is what preserves a development chain instead of collapsing it to whichever end
   * happened to rank higher — a pack holding only the most recent change to a file can
   * say what the code is and never why.
   */
  private markStructuralRoles(candidates: Map<string, Candidate>, anchorFiles: string[],
                              shallowRoots: Set<string>): void {
    for (const file of anchorFiles) {
      const touching = [...candidates.values()]
        .filter((c) => c.anchorFiles.includes(file))
        .sort((a, b) => a.authoredAt - b.authoredAt || a.hash.localeCompare(b.hash));
      if (!touching.length) continue;
      // A file a shallow history's first commit holds is older than the history, and its
      // origin is not here to mark.
      const origin = touching.some((c) => shallowRoots.has(c.hash)) ? undefined : touching[0]!;
      if (origin) origin.structuralRole = Math.max(origin.structuralRole, 2);
      const latest = touching[touching.length - 1]!;
      if (latest !== origin) latest.structuralRole = Math.max(latest.structuralRole, 1);
    }
  }

  /**
   * Read what each commit to the target says about itself: which of the request's words
   * its message uses, and whether it is one end of a revert.
   *
   * Once a target's whole history is read (see `ContextEngine.readTargetHistory`), a file
   * like React's `CodegenReactiveFunction.ts` brings well over a hundred commits, and the
   * structural signals cannot tell them apart: a 2025 "Rename babel plugin" touched every
   * file a question named, and outranked the change, revert and re-land the question was
   * about. A subject line that uses the question's words is about what was asked; a change
   * that was undone, and the commit that undid it, are the attempts a "how did this come
   * about" answer turns on. Both are read from the message only, which git records.
   *
   * Words are matched in the subject alone, and a word that most of the target's commits
   * use counts for nothing: every commit to React's compiler starts "[compiler]", and a long
   * body matches any question's words by its length alone.
   */
  private markMessages(candidates: Map<string, Candidate>, queryTerms: string[]): void {
    const subjects = new Map<string, Candidate>();
    const reverted: string[] = [];
    const core = [...candidates.values()].filter((c) => CORE_RELATIONS.includes(c.relation));
    const messages = new Map(core.map((c) => [c, this.repo.getCommitByHash(c.hash)?.message ?? '']));
    const subjectOf = (c: Candidate): string => messages.get(c)!.split('\n')[0]!.trim();
    const telling = queryTerms.filter((t) => core.filter((c) => matchesWord(subjectOf(c), t)).length * 2 <= core.length);
    for (const c of core) {
      const message = messages.get(c)!;
      const subject = subjectOf(c);
      subjects.set(subject, c);
      c.wordHits = telling.filter((t) => matchesWord(subject, t)).length;
      const reverts = /^Revert\b/i.test(subject) || /This reverts commit [0-9a-f]{7,40}/i.test(message);
      if (!reverts) continue;
      c.revertChain = 1;
      for (const m of message.matchAll(/This reverts commit ([0-9a-f]{7,40})/gi)) reverted.push(m[1]!.toLowerCase());
      const quoted = /^Revert\s+"(.+)"/i.exec(subject)?.[1];
      if (quoted) reverted.push(`subject:${quoted}`);
    }
    for (const r of reverted) {
      const target = r.startsWith('subject:')
        ? subjects.get(r.slice(8))
        : [...candidates.values()].find((c) => c.hash.startsWith(r));
      if (target) target.revertChain = 1;
    }
  }

  /**
   * Take the top *limit*, but never at the cost of breaking a chain.
   *
   * The origin and the most recent change to each anchor are reserved outright. On a file
   * with a long history the plain top-N is all recent work, which is the one shape that
   * cannot answer "why is this like this".
   *
   * Except that the commits the request was found to be about come first. Two ends per
   * anchor fill eight slots with four anchors: on a Prettier question that named
   * `appendPlugins`, a fifth anchor from the developer's current work pushed out the commit
   * that wrote it, which the ranking had put first.
   */
  private select(ranked: Candidate[], limit: number): Candidate[] {
    const core = ranked.filter((c) => CORE_RELATIONS.includes(c.relation));
    const filler = ranked.filter((c) => !CORE_RELATIONS.includes(c.relation));

    const chosen: Candidate[] = [];
    const take = (c: Candidate | undefined): void => {
      if (c && !chosen.includes(c) && chosen.length < limit) chosen.push(c);
    };

    for (const c of core.filter((c) => c.lineHits || c.wordHits || c.revertChain).slice(0, LEADING_MATCHED)) take(c);
    for (const c of core) if (c.structuralRole > 0) take(c);
    for (const c of core) take(c);

    if (chosen.length < Math.min(limit, CORE_SUFFICIENT)) {
      for (const c of filler.slice(0, MAX_LEXICAL_ONLY)) take(c);
    }
    return chosen.sort(compare);
  }

  private toEvents(chosen: Candidate[]): HistoricalEvent[] {
    const events: HistoricalEvent[] = [];
    for (const c of chosen) {
      const full = this.repo.getCommitByHash(c.hash);
      if (!full) continue;
      // Anchor files first: with a four-path display cap, showing the neighbourhood files
      // and hiding the target would describe the commit as being about something else.
      const touched = [...new Set([...c.anchorFiles, ...c.relatedFiles, ...c.indirectFiles])];
      events.push({
        hash: full.hash,
        shortHash: full.shortHash,
        subject: full.message.split('\n')[0]!.trim(),
        authoredAt: full.authoredAt,
        authorName: full.authorName,
        touchedFiles: touched.slice(0, 4),
        touchedFilesOmitted: Math.max(0, touched.length - 4),
        relation: c.relation,
        anchorFiles: [...new Set(c.anchorFiles)],
        introducedAnchor: c.structuralRole === 2,
        ...(c.wordHits || c.revertChain || c.lineHits ? { matchesRequest: true } : {}),
        // The commit and its file list are VERIFIED; the subject line is the author's
        // own claim and is labelled where it is used as an explanation, not here.
        provenance: 'VERIFIED',
      });
    }
    return events;
  }
}

/**
 * Order two candidates.
 *
 * Lexicographic, never summed. A weighted total lets one large term swamp the rest, and
 * that is the exact mechanism by which a commit with a lot of neighbourhood overlap and a
 * recent date displaced the commit that created the file. Here a later signal is consulted
 * only when every earlier one is equal, so recency — the weakest — decides nothing except
 * between commits that are otherwise indistinguishable.
 */
function compare(a: Candidate, b: Candidate): number {
  return (
    // 1. Relationship to the target. Absolute: no other signal crosses this boundary.
    RELATION_RANK[a.relation] - RELATION_RANK[b.relation] ||
    // 2. Exact target match — anchors the developer named outright.
    b.explicitHits - a.explicitHits ||
    // 3. What the commit wrote: the lines of the target the request names, as they stand
    //    now. Ahead of what commits say: on Next.js's config.ts, two commits whose subjects
    //    read "experimental … option" outranked the one that wrote the option a question
    //    named, because a busy file's subjects share the request's ordinary words.
    b.lineHits - a.lineHits ||
    // 4. What the commit says it did: the request's words, then a change undone or undoing.
    b.wordHits - a.wordHits ||
    b.revertChain - a.revertChain ||
    // 5. Symbol/file relevance.
    b.symbolHits - a.symbolHits ||
    // 6. Evidence strength: how much of the target this commit actually changed.
    b.anchorFiles.length - a.anchorFiles.length ||
    // 7. Historical sequence: the ends of the chain before its middle.
    b.structuralRole - a.structuralRole ||
    // 8. Recency, and only now.
    b.authoredAt - a.authoredAt ||
    a.hash.localeCompare(b.hash)
  );
}

/** Exported for tests: the ordering contract, checkable without a repository. */
export const compareHistoryCandidates = compare;
export type { Candidate as HistoryCandidate };
export { matchesWord };
