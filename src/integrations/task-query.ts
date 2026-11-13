/**
 * The part of a submitted prompt that says what to investigate.
 *
 * Why this exists
 * ---------------
 * A prompt submitted to an agent is not a query. It is a query wrapped in talk about
 * the exchange itself — "Answer the question below about this repository", "justify
 * your answer with specifics", "Answer only; do not edit files" — and the task-start
 * hook used to hand all of it to the resolver as though every word named something in
 * the repository.
 *
 * The resolver did what it is built to do with words: it scored files by them.
 * Measured on three controlled tasks, the clause "why. Answer only" resolved by itself
 * to `frontend/src/utils/trackNaming.test.ts` on the strength of "answer" and "only",
 * in all three tasks; the wrapper sentence, which the resolver does not split from the
 * task because it does not split at full stops, added "answer", "question", "below",
 * "about" and "repository" to the terms every file was scored against. Six targets
 * shared a budget sized for one, and in one task the commits that answered the
 * question were no longer in the pack.
 *
 * What it removes, and what it never removes
 * ------------------------------------------
 * Text is removed in whole pieces — a sentence, a line, or one of the resolver's own
 * clauses — and only when *every* word in the piece that the resolver would score is a
 * word about the exchange rather than about the code: asking and answering, the prompt
 * or the repository as a whole, and the directives that limit a reply. A piece with a
 * single other word in it is kept verbatim, so "describe the earlier method" survives
 * although "describe" is on the list. So does any piece that names something
 * explicitly — a path, a backticked span, or an identifier shaped like code — whatever
 * words surround it.
 *
 * Kept text is not rewritten: each surviving piece is a contiguous span of what the user
 * typed — whole, or with a workflow step cut from its edges ("commit the record" keeps "the
 * record"; see `trimWorkflowEdges`), never with a word taken from its middle — and
 * the pieces keep the resolver's clause structure, because the resolver treats each
 * clause separately and regrouping them would change the answer for reasons unrelated
 * to the wrapper. A prompt with nothing to remove comes back byte-for-byte, and one
 * with nothing *but* such words comes back whole, so the resolver sees it exactly as
 * it did before.
 *
 * It deliberately does not consult the index, weigh words, or guess at intent. It is a
 * closed list applied to whole pieces; the resolver that follows is unchanged.
 */

import { splitClauses, tokenize } from '../code/graph.js';
import { extractReferences, stripPunctuation } from '../code/references.js';

/**
 * Words whose subject is the exchange, never the code.
 *
 * Three classes: asking and answering; pointers to the prompt or to the repository as a
 * whole; and the directives and qualifiers that limit a reply. The resolver's own
 * stopwords are already gone by the time this list is consulted, which is why "do",
 * "the" and "modify" are absent.
 *
 * Kept narrow on purpose. A word that is also an ordinary name for something in a
 * codebase is left out even when it usually appears in wrappers: "request",
 * "response", "task", "state", "list" and "code" would each make a real clause
 * disappear in some repository. The price is that some wrapper text survives; the
 * alternative is losing the question.
 */
const EXCHANGE_WORDS = new Set([
  // asking and answering
  'answer', 'answers', 'answered', 'answering', 'question', 'questions', 'reply', 'respond',
  // the prompt, or the repository as a whole
  'below', 'above', 'following', 'about', 'here', 'repository', 'repo', 'codebase',
  // directives and their qualifiers
  'only', 'just', 'please', 'thanks', 'thank', 'not', 'don', 'never', 'any', 'anything',
  'edit', 'edits', 'editing', 'file', 'files',
  'justify', 'specifics', 'specific', 'detail', 'details', 'detailed', 'reasoning',
  'explain', 'explanation', 'describe', 'concise', 'concisely', 'brief', 'briefly', 'cite',
]);

/**
 * Words about the conversation and the workflow around it, never about what the code does.
 *
 * Measured on Strata's own repository once its prompt hook was on: "record the key
 * decisions first, then commit and push" and "yes, add the docs-only commit fix" each got
 * a pack resolved from "commit", "push" and "yes", with CAUTION lines saying the task
 * "names push, which 2c1f97e moved away from". A reply to the agent ("yes", "looks good,
 * go ahead") and a version-control step ("commit and push", "run the tests again") are
 * instructions about the session, not questions about the repository.
 *
 * Two classes: acknowledging and steering the conversation, and the steps of the
 * development workflow. Kept narrow like the list above: a word that also names
 * something in many codebases ("record", "deploy", "release", "branch", "tag", "build
 * step") is left out, so a real question about it is never mistaken for small talk.
 * Words the resolver already drops ("fix", "add", "it", "this", "then", "ok", "go") need
 * no entry.
 */
const CONVERSATION_WORDS = new Set([
  // acknowledging and steering
  'yes', 'yeah', 'yep', 'yup', 'nope', 'okay', 'sure', 'fine', 'great', 'good', 'nice', 'cool',
  'perfect', 'right', 'correct', 'agreed', 'agree', 'alright', 'lgtm', 'sounds', 'looks', 'seems',
  'ahead', 'proceed', 'continue', 'carry', 'done', 'now', 'yet', 'first', 'next', 'also', 'again', 'same',
  'both', 'all', 'everything', 'let', 'lets', 'want', 'would', 'like',
  // the workflow around the code
  'commit', 'commits', 'committed', 'committing', 'push', 'pushed', 'pushing', 'pull', 'merge',
  'rebase', 'stash', 'amend', 'cherry', 'pick', 'diff', 'run', 'rerun', 'retry', 'test', 'tests',
  'lint', 'verify', 'review',
]);

/** Sentence ends, line breaks, and a label's colon. Never inside a path or a URL. */
const PIECE_BOUNDARY = /(?<=[.!?])\s+|\s*\n\s*|(?<=:)\s+/;
const CODE_SHAPED = /[a-z][A-Z]|_|\$|[A-Za-z][0-9]/;

export interface TaskQuery {
  /** What the resolver should see. Equal to the prompt when nothing was removed. */
  query: string;
  /** The pieces removed, in prompt order, for the delivery log. */
  removed: string[];
  /**
   * True when the prompt is conversation and nothing else: every piece is made of exchange
   * and conversation words, at least one of them a conversation word, and none names
   * anything outright. There is no question about the repository to build context for.
   */
  conversational: boolean;
}

/** Does *piece* name something outright? Such a piece is never removed. */
function namesSomething(piece: string): boolean {
  if (/`[^`]+`/.test(piece)) return true;
  if (extractReferences(piece).some((r) => r.kind === 'path')) return true;
  return piece.split(/\s+/).some((raw) => CODE_SHAPED.test(stripPunctuation(raw)));
}

/**
 * Is *piece* only about the exchange or the conversation? A piece with no scorable word is
 * left alone, and so is one that names something outright.
 */
function isExchangeOnly(piece: string): boolean {
  const terms = tokenize(piece);
  return terms.length > 0 && terms.every((t) => EXCHANGE_WORDS.has(t) || CONVERSATION_WORDS.has(t))
    && !namesSomething(piece);
}

/** Does *piece* carry a conversation word (not only exchange words)? */
function hasConversationWord(piece: string): boolean {
  return tokenize(piece).some((t) => CONVERSATION_WORDS.has(t));
}

/**
 * A workflow step at the edge of a clause that also asks something.
 *
 * Whole pieces are removed only when every word in them is talk. Measured on Strata's own
 * repository, that left the step inside a clause that carried anything else: "commit the
 * fix to task-query" resolved to `src/history/changes.ts` on "commit" and never reached
 * task-query; "push the docs changes" and "go ahead and commit the record" got CAUTION lines
 * saying the task names push and commit; "run the tests for task-query again" and "review
 * the hook changes before pushing" kept "again" and "pushing".
 *
 * So a clause may also lose its edges, never its middle. At the start: steering words the
 * resolver would score ("now", "please", "yes"), and a workflow verb in the imperative — at the start of the
 * clause, after nothing but steering words, and followed by a determiner or pronoun, which
 * is what tells "push the branch" from "push notifications fail" and "commit the record"
 * from "commit cache misses commits". At the end: "again", "too", and a step tied on with
 * "before" or "after" ("before pushing"). What remains is a contiguous span of what the
 * user typed, and it must still carry a word the resolver would score or name something
 * outright; a clause whose only object is the pending work itself ("commit the changes")
 * is a step, and goes whole.
 */
const STEERING_LEADS = new Set([
  'now', 'then', 'also', 'please', 'just', 'so', 'and', 'ok', 'okay', 'yes', 'yeah', 'yep',
  'sure', 'alright', 'finally', 'again',
]);
/** What may come between the steering words and the verb: "go ahead and", "let's", "can you". */
const VERB_LEADS = new Set([...STEERING_LEADS, 'go', 'ahead', 'let', 'lets', 'us', 'can', 'could', 'you', 'we']);
const WORKFLOW_VERBS = new Set([
  'commit', 'push', 'pull', 'merge', 'rebase', 'stash', 'amend', 'diff', 'run', 'rerun', 'retry',
  'test', 'lint', 'verify', 'review',
]);
/** A verb's object starts here: determiners and pronouns, never a noun the verb modifies. */
const OBJECT_STARTS = new Set([
  'the', 'this', 'that', 'these', 'those', 'it', 'them', 'all', 'everything', 'my', 'our', 'your', 'a', 'an',
]);
/** An object that is nothing but the work in progress. */
const PENDING_WORK = new Set(['changes', 'change', 'work', 'updates', 'update', 'fixes', 'fix', 'edits', 'everything', 'all', 'it', 'them', 'this', 'that']);
/** Never "now": "the one it uses now" is part of the question. */
const TRAILING = new Set(['again', 'too', 'please', 'thanks']);
const STEP_CONNECTORS = new Set(['before', 'after']);
const STEP_FORMS = new Set([
  ...WORKFLOW_VERBS, 'committed', 'committing', 'pushed', 'pushing', 'pulling', 'merging', 'rebasing',
  'stashing', 'amending', 'running', 'rerunning', 'retrying', 'testing', 'linting', 'verifying', 'reviewing',
]);
/** Words a tied-on step may carry besides the step itself: "before you push it". */
const STEP_FILLERS = new Set(['you', 'we', 'it', 'them', 'this', 'that', 'everything', 'anything']);

/** The words of *piece*, normalised for the lists above, with their character offsets. */
function words(piece: string): { norm: string; start: number; end: number }[] {
  return [...piece.matchAll(/\S+/g)].map((m) => ({
    norm: stripPunctuation(m[0]).toLowerCase().replace(/['’]/g, ''),
    start: m.index!,
    end: m.index! + m[0].length,
  }));
}

/**
 * Trim a workflow step from the edges of *piece*. Returns the span to keep and the text
 * cut from each edge, or `step: true` when nothing but the step and its pending work remain.
 */
function trimWorkflowEdges(piece: string): { kept: string; cut: string[]; step: boolean } {
  const w = words(piece);
  const norm = (k: number): string => w[k]?.norm ?? '';
  const startOf = (k: number): number => w[k]?.start ?? 0;
  const endOf = (k: number): number => w[k]?.end ?? piece.length;
  let from = 0;
  let to = w.length;
  let verb = false;

  // The start: steering words, then an imperative workflow verb with an object after it.
  let i = 0;
  while (i < w.length - 1 && VERB_LEADS.has(norm(i))) i++;
  if (WORKFLOW_VERBS.has(norm(i)) && OBJECT_STARTS.has(norm(i + 1))) {
    from = i + 1;
    verb = true;
  } else {
    while (from < w.length - 1 && STEERING_LEADS.has(norm(from))) from++;
    // Only worth cutting if the resolver would have scored it: "and", "so", "then" stay.
    if (!tokenize(piece.slice(0, startOf(from))).length) from = 0;
  }

  // The end: trailing adverbs, then a step tied on with "before" or "after".
  while (to - 1 > from && TRAILING.has(norm(to - 1))) to--;
  let j = to;
  while (j - 1 > from && (STEP_FORMS.has(norm(j - 1)) || STEP_FILLERS.has(norm(j - 1)))) j--;
  if (j - 1 > from && STEP_CONNECTORS.has(norm(j - 1)) && w.slice(j, to).some((x) => STEP_FORMS.has(x.norm))) {
    to = j - 1;
    while (to - 1 > from && TRAILING.has(norm(to - 1))) to--;
  }

  if (from === 0 && to === w.length) return { kept: piece, cut: [], step: false };
  const kept = piece.slice(startOf(from), endOf(to - 1));
  // An object that is only the pending work: the clause was a step and nothing else.
  if (verb && w.slice(from, to).every((x) => OBJECT_STARTS.has(x.norm) || PENDING_WORK.has(x.norm))) {
    return { kept: '', cut: [], step: true };
  }
  // What is left must still say something, or the trim is not ours to make.
  if (!tokenize(kept).length && !namesSomething(kept)) return { kept: piece, cut: [], step: false };
  const cut = [piece.slice(0, startOf(from)).trim(), piece.slice(endOf(to - 1)).trim()].filter(Boolean);
  return { kept, cut, step: false };
}

/** Split *text* into pieces, keeping the separator that preceded each one. */
function pieces(text: string): { lead: string; body: string }[] {
  const out: { lead: string; body: string }[] = [];
  const boundary = new RegExp(PIECE_BOUNDARY.source, 'g');
  let start = 0;
  let lead = '';
  for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
    if (m[0].length === 0) { boundary.lastIndex++; continue; }
    out.push({ lead, body: text.slice(start, m.index) });
    lead = m[0];
    start = m.index + m[0].length;
  }
  out.push({ lead, body: text.slice(start) });
  return out.filter((p) => p.body.trim());
}

export function extractTaskQuery(prompt: string): TaskQuery {
  const removed: string[] = [];
  const kept: string[] = [];

  // The resolver's own clauses first, so that what survives is grouped exactly as the
  // resolver would have grouped it; then sentences and lines within each clause, which
  // the resolver does not separate and a wrapper sentence therefore hides inside.
  for (const clause of splitClauses(prompt)) {
    let text = '';
    for (const { lead, body } of pieces(clause)) {
      if (isExchangeOnly(body)) { removed.push(body.trim()); continue; }
      const trimmed = trimWorkflowEdges(body);
      if (trimmed.step) { removed.push(body.trim()); continue; }
      removed.push(...trimmed.cut);
      text += (text ? lead : '') + trimmed.kept;
    }
    if (text.trim()) kept.push(text.trim());
  }

  // Nothing left, and some of it conversation: not a question about the repository at all.
  // (A prompt of exchange words alone, "Answer only", keeps its old behaviour below.)
  if (removed.length && !kept.length && removed.some(hasConversationWord)) {
    return { query: prompt, removed, conversational: true };
  }
  // Nothing to remove, or nothing left: the prompt goes through untouched.
  if (!removed.length || !kept.length) return { query: prompt, removed: [], conversational: false };
  // "; " is a boundary the resolver splits on, so each kept clause stays its own clause.
  return { query: kept.join('; '), removed, conversational: false };
}
