/**
 * Historical decisions: what the repository decided, whether it still holds, and what it
 * would cost to undo.
 *
 * Why this exists
 * ---------------
 * Retrieval stopped being the problem. In the last history-dependent run Strata surfaced
 * the decisive commit, its diff and a deleted test in every case — and one agent read all
 * of it and chose against it anyway, describing the reversal as a deliberate trade. It was
 * not wrong to be able to choose. It was wrong that nothing in the pack told it the thing
 * it was about to undo was a decision still in force.
 *
 * A diff on its own does not say that. `- videoId @id` / `+ trackKey @id` is a fact about
 * one commit. Whether that fact still describes the code, whether anything later overturned
 * it, and whether the task in hand is about to walk back into it are three separate
 * questions, and all three are answerable mechanically from git.
 *
 * What is and is not claimed
 * --------------------------
 * Everything this module *measures* is VERIFIED: which lines a commit added and removed,
 * whether those lines are in the file at HEAD, which later commit removed them. Nothing
 * here reads a commit message for meaning, and nothing summarises. The single INFERRED
 * statement it will make is the weakest possible one — "the repository records no evidence
 * that this was reconsidered" — which is a statement about the absence of evidence, not
 * about the author's reasoning.
 *
 * The status is deliberately conservative. A file whose change only partly survives is
 * UNKNOWN, not ACTIVE: half a decision surviving is not a decision still standing, and
 * saying so would be the silent DECLARED-to-VERIFIED promotion this whole system exists to
 * refuse.
 */

import { CommitChangeReader } from '../history/changes.js';
import { isCodeShaped } from '../code/graph.js';
import {
  DecisionStatus, HistoricalDecision, HistoricalEvent, Provenance, Statement,
} from './pack.js';

/** A line shorter than this carries no identity worth tracking. */
const MIN_SIGNIFICANT = 6;

/**
 * Tokens that appear in every other line of a typed language.
 *
 * A caution fires when the task names something an active decision moved away from. If
 * `String` or `const` counted, every task touching a typed file would be cautioned, and a
 * warning that always fires is a warning nobody reads.
 */
const KEYWORDS = new Set([
  'string', 'number', 'boolean', 'int', 'float', 'bigint', 'datetime', 'date', 'json',
  'true', 'false', 'null', 'undefined', 'void', 'const', 'let', 'var', 'function',
  'return', 'import', 'export', 'from', 'class', 'interface', 'type', 'enum', 'async',
  'await', 'public', 'private', 'static', 'readonly', 'model', 'table', 'index',
  'unique', 'default', 'optional', 'required', 'this', 'new', 'else', 'with',
]);

/**
 * Decisions carried per pack.
 *
 * Four rather than three because a single file legitimately carries more than one: the
 * change that created it, the change that settled its current shape, and the change
 * nobody can tell about any more are three different statements, and the third is a
 * warning in its own right. They are cheap — six lines each — and the budget trims them
 * late.
 */
const MAX_DECISIONS = 4;
/** Lines of before/after quoted per decision. */
const MAX_QUOTED = 4;
/** Files examined per commit. The anchor and a schema beside it, not the whole commit. */
const MAX_PATHS_PER_COMMIT = 3;
/** Above this many files a commit's edgeless companions are bulk, not decisions. */
const MAX_COMPANION_SOURCE_FILES = 200;
/** The best-ranked history commits whose decisions lead whatever their standing. */
const LEADING_HISTORY = 3;

export class DecisionAnalyzer {
  private changes: CommitChangeReader;

  constructor(changes: CommitChangeReader) {
    this.changes = changes;
  }

  /**
   * Derive decisions from the commits already ranked into the pack.
   *
   * Only commits that changed the resolved target are considered. A commit elsewhere in
   * the neighbourhood may well have decided something, but it decided it about a different
   * piece of code, and presenting it beside the target invites exactly the confusion
   * between "this code" and "code near this code" that the pack is supposed to remove.
   */
  public analyze(
    history: HistoricalEvent[], anchorFiles: string[], queryTerms: string[],
    limits: { decisions: number; quotedLines: number } = { decisions: MAX_DECISIONS, quotedLines: MAX_QUOTED },
    query = '',
  ): HistoricalDecision[] {
    const anchors = new Set(anchorFiles);
    const candidates: HistoricalDecision[] = [];
    this.changes.prefetchTouched(history.filter((e) => e.relation === 'DIRECT_TARGET').map((e) => e.hash));

    for (const event of history) {
      if (event.relation !== 'DIRECT_TARGET') continue;
      /*
        Read the commit's own file list rather than whatever diff the pack happened to
        carry.

        Diffs are rationed — two commits per pack, with the origin and the latest change
        reserved — so a three-commit history gave its middle commit no diff at all, and
        deriving decisions from diffs meant the decisive middle change produced nothing.
        A decision costs six lines and a name-status read; it should not be rationed like
        forty lines of hunks.
      */
      // A commit that touched hundreds of files — an import, a shallow history's root, a
      // sweep — carries its edgeless companions by bulk, not by decision.
      // By current path: a commit made before the target was renamed touched it by its old one.
      const all = this.changes.touchedPaths(event.hash)
        .map((t) => ({ ...t, path: this.changes.currentPath(event.hash, t.path) }));
      const bulk = all.length > MAX_COMPANION_SOURCE_FILES;
      const touched = all
        .filter((t) => anchors.has(t.path) || (!bulk && isEdgeless(t.path)))
        .slice(0, MAX_PATHS_PER_COMMIT);

      for (const change of touched) {
        const decision = this.forChange(event, change.path, change.status, anchors, queryTerms,
                                        limits.quotedLines, query);
        if (!decision) continue;
        /*
          Not every change in a commit is a decision worth surfacing.

          A commit diffs the target plus a couple of its travelling companions, and most
          companions are simply work done at the same time — measured, a helper that
          normalises artist names arrived alongside the cache change and has nothing to do
          with cache identity, but produced a perfectly valid ACTIVE decision that cost
          fifteen lines of the budget.

          Three things earn the slot. The target itself, because the task is about it.
          A file no code edge can reach — a schema, a migration, a config — because that is
          where identity and constraints live and nothing else will bring it in. And any
          change the task is about to walk back into, which is the entire point.
        */
        if (decision.inTarget || isEdgeless(decision.path) || decision.caution) {
          candidates.push(decision);
        }
      }
    }

    /*
      Rank the decisions.

      A settled question outranks an open one, and a small surgical change outranks a large
      one. Both follow from what a decision is for: `- videoId @id / + trackKey @id` states
      an identity in two lines, while a 200-line rewrite of a service states an
      implementation. The first is a decision someone could walk back into by accident; the
      second is just work.

      Except for the commits the history ranking put first (`HistoryAnchoring`: the request's
      words, then a revert chain), whose decisions lead whatever their standing.
    */
    // Only commits the ranking found by what they say (`matchesRequest`); a ranking that
    // found nothing of the kind leaves the order to standing, as before.
    const rank = new Map(history.filter((e) => e.matchesRequest).map((e, i) => [e.shortHash, i]));
    const leading = (d: HistoricalDecision): number => {
      const r = rank.get(d.commit);
      return r !== undefined && r < LEADING_HISTORY ? r : LEADING_HISTORY;
    };
    candidates.sort((a, b) =>
      leading(a) - leading(b) ||
      statusRank(a.status) - statusRank(b.status) ||
      (b.caution ? 1 : 0) - (a.caution ? 1 : 0) ||
      a.changedLines - b.changedLines ||
      b.authoredAt - a.authoredAt ||
      a.path.localeCompare(b.path));

    return candidates.slice(0, limits.decisions);
  }

  private forChange(
    event: HistoricalEvent, path: string, changeStatus: string,
    anchors: Set<string>, queryTerms: string[], quoted = MAX_QUOTED, query = '',
  ): HistoricalDecision | null {
    const { added, removed } = this.changes.editedLines(event.hash, path);
    const addedSig = added.filter(significant);
    const removedSig = removed.filter(significant);
    // For quoting only. Counts stay on the real lines: two identical edits are two edits,
    // and reporting one would understate what the commit did.
    const uniq = (xs: string[]): string[] => [...new Map(xs.map((x) => [x.trim(), x])).values()];
    if (!addedSig.length && !removedSig.length) return null;

    const head = this.changes.contentAtHead(path);
    const headLines = head === null ? null : new Set(head.split('\n').map((l) => l.trim()));
    const present = (line: string): boolean => headLines?.has(line.trim()) ?? false;

    const surviving = addedSig.filter(present);
    const returned = removedSig.filter(present);

    const { status, reason, supersededBy } =
      this.status(event, path, headLines, addedSig, surviving, removedSig, returned);

    const decision: HistoricalDecision = {
      path,
      inTarget: anchors.has(path),
      commit: event.shortHash,
      commitSubject: event.subject,
      authoredAt: event.authoredAt,
      changeKind: changeStatus,
      changedLines: addedSig.length + removedSig.length,
      // The exact lines, both sides. Quoted, never paraphrased.
      historicalState: uniq(removedSig).slice(0, quoted),
      historicalOmitted: Math.max(0, uniq(removedSig).length - quoted),
      currentState: uniq(surviving.length ? surviving : addedSig).slice(0, quoted),
      currentOmitted: Math.max(0, uniq(surviving.length ? surviving : addedSig).length - quoted),
      currentIsAtHead: surviving.length > 0,
      survivingLines: surviving.length,
      addedLines: addedSig.length,
      status,
      statusReason: reason,
      // The measurement is exact git and exact file content; the label is a reading of it.
      statusProvenance: status === 'UNKNOWN' ? 'UNKNOWN' : 'VERIFIED',
      ...(supersededBy ? { supersededBy } : {}),
      consequences: this.changes.laterCommitsTouching(event.hash, path, 3),
      support: [],
      whyItMatters: [],
    };

    decision.whyItMatters = this.why(decision, event);
    const caution = this.caution(decision, removedSig, queryTerms, head, query);
    if (caution) decision.caution = caution;
    return decision;
  }

  /**
   * Is the decision still in force?
   *
   * Measured against the file at HEAD, which is the accumulation of every commit since —
   * so this consults later history by construction rather than assuming a change stands
   * because it is old.
   */
  private status(
    event: HistoricalEvent, path: string, headLines: Set<string> | null,
    addedSig: string[], surviving: string[], removedSig: string[], returned: string[],
  ): { status: DecisionStatus; reason: string; supersededBy?: { shortHash: string; subject: string } } {
    if (headLines === null) {
      const remover = this.changes.laterCommitsTouching(event.hash, path, 1)[0];
      return remover
        ? { status: 'SUPERSEDED', supersededBy: remover,
            reason: `${path} does not exist at HEAD; ${remover.shortHash} is the next commit that touched it.` }
        : { status: 'UNKNOWN', reason: `${path} does not exist at HEAD and no later commit touching it was found.` };
    }

    // A removed line that is back in the file is the clearest possible reversal.
    if (returned.length && !surviving.length) {
      const back = this.changes.commitRemoving(event.hash, path, surviving[0] ?? addedSig[0] ?? '');
      return {
        status: 'SUPERSEDED',
        ...(back ? { supersededBy: back } : {}),
        reason: `${returned.length} line(s) this commit removed are present in ${path} at HEAD again.`,
      };
    }

    if (addedSig.length && !surviving.length) {
      const back = this.changes.commitRemoving(event.hash, path, addedSig[0]!);
      return {
        status: 'SUPERSEDED',
        ...(back ? { supersededBy: back } : {}),
        reason: `None of the ${addedSig.length} line(s) this commit added are in ${path} at HEAD.`,
      };
    }

    if (addedSig.length && surviving.length === addedSig.length && !returned.length) {
      const later = this.changes.laterCommitsTouching(event.hash, path, 1).length;
      return {
        status: 'ACTIVE',
        reason: `All ${addedSig.length} line(s) this commit added are in ${path} at HEAD` +
          (later ? ', and later commits to the file left them in place.' : ', and no later commit has touched the file.'),
      };
    }

    // A pure deletion that stayed deleted.
    if (!addedSig.length && removedSig.length && !returned.length) {
      return {
        status: 'ACTIVE',
        reason: `The ${removedSig.length} line(s) this commit removed from ${path} are still absent at HEAD.`,
      };
    }

    /*
      Partial survival is not a partial decision, it is an unanswered question.

      Measured on a real service file, 53% of one commit's added lines survived a later
      rewrite. Calling that ACTIVE would assert the decision stands when half of it is
      gone; calling it SUPERSEDED would assert it was overturned when half of it remains.
      The ratio is reported and the label is withheld.
    */
    return {
      status: 'UNKNOWN',
      reason: `${surviving.length} of ${addedSig.length} line(s) this commit added are in ${path} at HEAD; ` +
        'the change was partly rewritten, so whether the decision still holds is not established.',
    };
  }

  /**
   * Why this decision bears on the task, one mechanical sentence at a time.
   *
   * Each sentence is a restatement of something measured, and carries its own provenance.
   * Nothing here is a summary: a generated paragraph that reads well and cites nothing is
   * indistinguishable from a guess, and an agent has no way to discount it.
   */
  private why(decision: HistoricalDecision, event: HistoricalEvent): Statement[] {
    const out: Statement[] = [];
    const ev = [decision.commit, decision.path];

    if (decision.inTarget) {
      out.push({
        statement: `${decision.commit} changed ${decision.path}, which this query resolved to.`,
        provenance: 'VERIFIED', evidence: ev,
      });
    } else {
      out.push({
        statement: `${decision.commit} changed ${decision.path} in the same commit as ${event.anchorFiles[0] ?? 'the target'}.`,
        provenance: 'VERIFIED', evidence: ev,
      });
    }

    if (decision.historicalState.length && decision.currentState.length) {
      out.push({
        statement: `It replaced ${decision.historicalState.length} line(s) with ${decision.addedLines}.`,
        provenance: 'VERIFIED', evidence: ev,
      });
    }

    if (decision.status === 'ACTIVE') {
      out.push({
        statement: 'The repository records no later change reversing this; that is an absence of evidence, not a guarantee it was reconsidered and kept.',
        // A reading of what the history does *not* contain. Not a fact about intent.
        provenance: 'INFERRED', evidence: ev,
      });
    }
    return out;
  }

  /**
   * Flag a collision between the task and a decision still in force.
   *
   * The rule is narrow on purpose: the task must *name* something the decision moved away
   * from. That is the shape of the failure this is for — a task asking to key a cache on
   * the identifier a previous commit had deliberately stopped keying it on. It raises a
   * question; it does not answer it, and it does not tell the agent what to do.
   */
  private caution(
    decision: HistoricalDecision, removedSig: string[], queryTerms: string[],
    head: string | null, query: string,
  ): Statement | undefined {
    if (decision.status !== 'ACTIVE' || !removedSig.length || !queryTerms.length) return undefined;

    /*
      Whole identifier, exact match, nothing looser.

      `matchesWord` tolerates a prefix so that "alias" finds "aliases", and that tolerance
      is right for finding files and wrong for this. Measured: the query term `videoid`
      matched the `video` hump of `videoOwnerChannelTitle`, and the pack asserted "this
      task names videoOwnerChannelTitle" about a task that does no such thing. A caution
      that misstates its own trigger is worse than no caution — it is a false claim in the
      one section asking the reader to slow down.
    */
    /*
      A plain word collides only where the file has stopped using it.

      A code-shaped name, or one the task puts in backticks, is a reference on sight (the
      same line a recorded decision draws for anchors): `uploadId` names the field even though the
      column is still declared, because what the decision moved away from was keying on
      it. A plain English word is not. Measured on Strata's own repository, "record",
      "commit", "query" and "refresh" each matched a local variable on a line some commit
      had rewritten, in files that still use the word throughout, and the pack told the
      reader the task named something "still absent at HEAD" that was on every other
      line. So a plain word counts only when no identifier in the file at HEAD is that
      word, which is the one case where the sentence below is true of it.
    */
    const atHead = new Set(identifiers(head ?? '').map((w) => w.toLowerCase()));
    const collisions = new Set<string>();
    const mentioned = new Set(queryTerms.map((t) => t.toLowerCase()));
    for (const line of removedSig) {
      for (const word of identifiers(line)) {
        if (KEYWORDS.has(word.toLowerCase()) || word.length < 4) continue;
        if (!mentioned.has(word.toLowerCase())) continue;
        if (isCodeShaped(word, query) || !atHead.has(word.toLowerCase())) collisions.add(word);
      }
    }
    if (!collisions.size) return undefined;

    const named = [...collisions].slice(0, 3).join(', ');
    return {
      statement: `This task names ${named}, which ${decision.commit} moved away from in ${decision.path} ` +
        `and which is still absent at HEAD. Reintroducing it would reverse that change. ` +
        `Strata does not know whether that is wrong here — the evidence is above; the decision is yours.`,
      // The collision is VERIFIED (the words are in the query and in the removed lines);
      // that it *matters* here is a reading, and is labelled as one.
      provenance: 'INFERRED',
      evidence: [decision.commit, decision.path],
    };
  }
}

/**
 * A file no import can reach: schema, migration, config.
 *
 * Kept in step with the same idea in `src/history/changes.ts`, where it decides which of
 * a commit's other files are worth diffing at all. Both rest on the same fact — nothing
 * imports one of these, so a commit is the only thing that can carry it into a pack.
 */
function isEdgeless(path: string): boolean {
  return /\.(prisma|sql|ya?ml|toml|graphql|env|ini|conf|cfg)$/i.test(path);
}

/** A line worth tracking: long enough, and not pure punctuation. */
function significant(line: string): boolean {
  const t = line.trim();
  return t.length >= MIN_SIGNIFICANT && /[A-Za-z0-9]/.test(t) && !/^[{}()[\];,]+$/.test(t);
}

/** Identifier-shaped words in a line of code, camelCase kept whole. */
export function identifiers(line: string): string[] {
  return (line.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
}

/**
 * Identifiers from a line that actually name something, keywords removed.
 *
 * A decision's own vocabulary is what decides whether a piece of recovered
 * evidence belongs to it. Left unfiltered that vocabulary includes `const`,
 * `export` and `string`, which appear in every other line of a typed file — so a
 * deleted test about one field attached itself to an unrelated decision on the
 * same file purely because both lines contained `const`.
 */
export function subjectTerms(lines: string[]): string[] {
  const out = new Set<string>();
  for (const line of lines) {
    for (const word of identifiers(line)) {
      if (word.length < 4 || KEYWORDS.has(word.toLowerCase())) continue;
      out.add(word);
    }
  }
  return [...out];
}

function statusRank(s: DecisionStatus): number {
  return s === 'ACTIVE' ? 0 : s === 'SUPERSEDED' ? 1 : 2;
}

export const __testing = { significant, statusRank };
export type { Provenance };
