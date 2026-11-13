/**
 * Task-start context delivery for Claude Code.
 *
 * Why this exists
 * ---------------
 * Every other way to reach Strata is pull: the agent has to know the server exists,
 * decide it needs help, and call a tool. Measured on six controlled tasks, that
 * decision came late or not at all — in three of the six the agent never called
 * Strata, and where it did, the first call landed at turn 5, 7 and 10. Context that
 * arrives at turn 10 cannot prevent turns 1 to 9, which is exactly the exploration it
 * was built to replace. The packs were correct wherever they were consulted; the
 * problem was never what Strata said, only when.
 *
 * Claude Code runs a `UserPromptSubmit` hook when a prompt is submitted, before the
 * model's first turn, and adds whatever the hook returns as `additionalContext`. So
 * the context is in front of the agent before it has made a single tool call, and the
 * agent never has to discover that Strata exists to receive it.
 *
 * What it deliberately does not do
 * --------------------------------
 * It builds nothing of its own. The pack comes from `getContextPack` and
 * `renderContextPack` — the same resolver, history anchoring, memory, provenance,
 * truncation markers and budget that the earlier phases validated. The only text
 * added is a one-paragraph header saying where the block came from, and it neither
 * asks the agent to trust the pack nor tells it not to explore.
 *
 * What it hands the engine is the task, not the whole prompt: pieces that only talk
 * about the exchange ("Answer only; do not edit files") are removed first, because the
 * resolver scores every word it is given. See `task-query.ts`.
 *
 * And it fails open. A prompt must never be blocked, delayed indefinitely, or
 * polluted because Strata is missing, uninitialised or broken; in every such case the
 * hook returns nothing and the prompt proceeds exactly as it would have without it.
 *
 * It keeps the store current itself. Before building the pack it runs the same
 * incremental refresh as `strata index`, so a commit or an edit made since the last
 * index is in the pack without anyone remembering to re-index. When nothing moved this
 * costs a stat per source file and one `git rev-parse`; a refresh that fails is logged
 * and the pack is built from what is stored. `--no-refresh` turns it off. Where the
 * repository has `docs/strata/`, the same refresh brings those docs up to date, and only
 * when something they are built from moved.
 *
 * Installing it
 * -------------
 * In `.claude/settings.json` (project) or `~/.claude/settings.json` (user):
 *
 *   { "hooks": { "UserPromptSubmit": [
 *       { "hooks": [ { "type": "command", "command": "strata hook user-prompt-submit" } ] }
 *   ] } }
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StrataService } from '../records/service.js';
import { ContextPack } from '../context/pack.js';
import { APPLICABILITY_BLOCK_CHARS } from '../context/applicability.js';
import { extractTaskQuery } from './task-query.js';

/** The fields of Claude Code's hook payload this module reads. */
export interface PromptHookPayload {
  prompt?: string;
  cwd?: string;
  session_id?: string;
  hook_event_name?: string;
}

/**
 * The most additionalContext Claude Code injects inline.
 *
 * Measured, not documented: on Claude Code 2.1.x a hook answer of 9,900 characters is
 * placed in the conversation whole, and one of 10,100 is written to a file with only a
 * 2 KB preview and a path left in its place. The first version of this hook sent the
 * engine's default 3,200-token pack — about 12,800 characters — so it was *always*
 * persisted. The preview ran out inside the code neighbourhood; history, attempts,
 * constraints, consequences and the provenance legend never reached the agent unless it
 * chose to open the file, which is pull-based delivery again, one hop later. One agent
 * in three never opened it.
 *
 * Configurable, because it is a property of the host and may move between versions.
 */
export const INLINE_CONTEXT_LIMIT = 10_000;

/**
 * Characters below the inline limit the applicability block never uses.
 *
 * The limit sits between the two sizes measured — 9,900 inline, 10,100 persisted — and
 * where between them the host switches was not measured. Packs sized by `budgetForInline`
 * reach at most 9,800 characters, inside the measured side. The block, which is added
 * outside the budget, may take the room above that only up to the largest size measured
 * inline, so adding it cannot move a pack into the unmeasured band.
 */
export const INLINE_MARGIN = 100;

/**
 * The token budget that renders inside *limitChars*.
 *
 * The engine's estimate is four characters per token, so a budget derived this way
 * lets the engine's own priority trimming decide what to drop — the protected
 * historical and memory floors, the truncation markers and the list of trimmed
 * sections all behave exactly as validated. Nothing here cuts text directly.
 */
export function budgetForInline(limitChars: number): number {
  const room = limitChars - CONTEXT_HEADER.length - 2 /* separator */ - 200 /* margin */;
  return Math.max(400, Math.floor(room / 4));
}

export interface PromptContextOptions {
  /** Explicit budget. When omitted, the budget is derived from `inlineLimit`. */
  maxTokens?: number;
  /** Characters Claude Code will inject inline. Defaults to INLINE_CONTEXT_LIMIT. */
  inlineLimit?: number;
  /** Append one JSON line per decision here. Instrumentation only; off by default. */
  deliveryLog?: string;
  /** Refresh the index and commit cache before building the pack. Defaults to true. */
  refresh?: boolean;
  /**
   * Let the developer's current work (uncommitted changes, recent commits) break a tie
   * between wording matches. Defaults to true.
   */
  currentWork?: boolean;
}

/** What the pre-pack refresh did, for the delivery log and for tests. */
export interface RefreshSummary {
  ms: number;
  filesIndexed?: number;
  filesRemoved?: number;
  commitsRefreshed?: boolean;
  /** Records read from their files because the file differed from the store. */
  recordsUpdated?: number;
  /** Record files that could not be read as written (see `syncRecordFiles`). */
  recordProblems?: string[];
  /** docs/strata/ files rewritten because the project changed (only where the docs exist). */
  docsWritten?: string[];
  /** Set when the refresh failed; the pack was then built from the stored index. */
  error?: string;
}

/** What the hook decided, for the delivery log and for tests. */
export interface PromptContextResult {
  /** The JSON object to print on stdout, or null to print nothing. */
  output: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit'; additionalContext: string } } | null;
  decision: 'delivered' | 'skipped-no-store' | 'skipped-no-target' | 'skipped-no-prompt'
    | 'skipped-system-notification' | 'skipped-conversational' | 'failed-open';
  resolution?: string;
  confidence?: string;
  targets?: string[];
  /** What the engine was asked, after the exchange-only pieces were removed. */
  query?: string;
  /** Those pieces, for the delivery log. Empty when the prompt went through whole. */
  removed?: string[];
  estimatedTokens?: number;
  /** Characters actually handed to the host, header included. */
  deliveredChars?: number;
  /** True when the answer exceeded the inline limit and the host will persist it. */
  oversize?: boolean;
  /** Present when a refresh was attempted. */
  refresh?: RefreshSummary;
  error?: string;
}

/**
 * Printed ahead of the pack, and nothing else is.
 *
 * Deliberately neutral. It says what the block is and where it came from. It does not
 * tell the agent to rely on it, and it does not tell the agent to skip exploring —
 * either instruction would be an intervention on behaviour rather than the delivery of
 * evidence, and would make any change in behaviour unattributable to the context
 * itself. The pack's own PROVENANCE section explains the labels.
 */
export const CONTEXT_HEADER =
  '[Strata] Context assembled automatically from this repository — code index, git ' +
  'history and recorded development notes — before this prompt was answered. Each ' +
  'statement carries its own provenance label; the labels are explained at the end.';

/**
 * The pack as it goes inline, after the header: the budgeted pack with its applicability
 * block under the target lines.
 *
 * The block is outside the pack's token budget, so it is sized to the room the pack leaves
 * under *inlineLimit*, less `INLINE_MARGIN`, rather than taking any of the pack's own. A
 * pack that meets its budget leaves at least 100 characters of that room, enough for the
 * class, whether the pack was trimmed, and a first reason; whatever else does not fit is
 * counted in the block.
 */
export function inlineAgentContext(service: StrataService, pack: ContextPack, inlineLimit: number): string {
  const plain = service.renderContextPack(pack);
  // The header and its blank line, the pack, and the blank line the block brings with it.
  const room = inlineLimit - INLINE_MARGIN - (CONTEXT_HEADER.length + 2 + plain.length) - 2;
  return service.renderAgentContext(pack, {
    maxApplicabilityChars: Math.min(APPLICABILITY_BLOCK_CHARS, Math.max(0, room)),
  });
}

/**
 * A message Claude Code submits on its own behalf, not a request from the user.
 *
 * When a background task finishes, Claude Code hands the model a `<task-notification>`
 * block through the same path as a typed prompt, and this hook receives it as one. Treated
 * as a request, its words ("task-id", "status completed", an output-file path) resolved to
 * whatever shared them and delivered a LOW VALUE pack about unrelated code. Only a prompt
 * that *opens* with the tag is the notification; a user prompt that mentions the tag later
 * is still a user prompt.
 *
 * A subagent's report reaches the parent session the same way, as an `<agent-message>`
 * block.
 */
const SYSTEM_NOTIFICATION = /^<(?:task-notification|agent-message)(?:\s[^>]*)?>/;

export function isSystemNotification(prompt: string): boolean {
  return SYSTEM_NOTIFICATION.test(prompt.trim());
}

/** The repository that owns *dir*, so a prompt issued from a subdirectory still resolves. */
function repositoryRoot(dir: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || dir;
  } catch {
    return dir;
  }
}

function logDecision(file: string | undefined, entry: Record<string, unknown>): void {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
  } catch {
    // Instrumentation must never be the reason a prompt fails.
  }
}

/**
 * Turn a submitted prompt into task-start context.
 *
 * A query that resolves to nothing at all is skipped rather than delivered: a pack
 * whose every section reads UNKNOWN costs the agent several hundred tokens to learn
 * nothing. A query that names a path the index does not hold *is* delivered, because
 * "that file does not exist" is exactly the kind of thing worth knowing before
 * starting to look for it.
 *
 * A system notification Claude Code submits itself (`<task-notification>`) is not a
 * request at all, and is skipped before the store is touched; see `isSystemNotification`.
 */
export function buildPromptContext(
  payload: PromptHookPayload, options: PromptContextOptions = {},
): PromptContextResult {
  const prompt = (payload.prompt ?? '').trim();
  let refresh: RefreshSummary | undefined;
  const log = (result: PromptContextResult): PromptContextResult => {
    const r = refresh ? { ...result, refresh } : result;
    logDecision(options.deliveryLog, {
      session: payload.session_id, decision: r.decision, resolution: r.resolution,
      confidence: r.confidence, targets: r.targets, query: r.query, removed: r.removed,
      estimatedTokens: r.estimatedTokens,
      deliveredChars: r.deliveredChars, oversize: r.oversize, refresh: r.refresh,
      error: r.error, promptChars: prompt.length,
    });
    return r;
  };

  if (!prompt) return log({ output: null, decision: 'skipped-no-prompt' });
  // Before the store is opened, refreshed or asked anything: there is no request to answer.
  if (isSystemNotification(prompt)) return log({ output: null, decision: 'skipped-system-notification' });
  // The same for a prompt that is only conversation ("yes", "commit and push"): it asks
  // nothing about the repository, and a pack built from its words is noise. See task-query.ts.
  const task = extractTaskQuery(prompt);
  if (task.conversational) return log({ output: null, decision: 'skipped-conversational', removed: task.removed });

  let service: StrataService | undefined;
  try {
    service = new StrataService(repositoryRoot(payload.cwd ?? process.cwd()));
    if (!service.isInitialized()) return log({ output: null, decision: 'skipped-no-store' });

    // Bring the index and commit cache up to date before reading them, so the pack shows
    // the code and history as they are now, not as of the last `strata index`. A refresh
    // that fails withholds nothing: the pack is built from what is already stored.
    if (options.refresh !== false) {
      const started = Date.now();
      try {
        // Trust file times: this runs on every prompt, and a stat is a sixteenth of a hash.
        const stats = service.indexCode({ trustFileTimes: true });
        refresh = {
          ms: Date.now() - started, filesIndexed: stats.filesIndexed,
          filesRemoved: stats.filesRemoved, commitsRefreshed: stats.commitsRefreshed,
          ...(stats.recordsUpdated ? { recordsUpdated: stats.recordsUpdated } : {}),
          ...(stats.recordProblems.length ? { recordProblems: stats.recordProblems.map((p) => `${p.file}: ${p.message}`) } : {}),
        };
        // docs/strata/ follows the store, where a repository has it. Its own failure is
        // not the prompt's: the pack below does not depend on it.
        try {
          const docs = service.refreshDocsIfPresent();
          if (docs?.written.length) refresh.docsWritten = docs.written;
        } catch {
          // The next refresh tries again.
        }
        refresh.ms = Date.now() - started;
      } catch (err: unknown) {
        refresh = { ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const inlineLimit = options.inlineLimit ?? INLINE_CONTEXT_LIMIT;
    const { query, removed } = task;
    const svc = service;
    // What the developer is changing now breaks a tie between wording matches; see
    // `resolveTarget`. Two git reads; on failure, nothing is preferred.
    let activeFiles: string[] | undefined;
    if (options.currentWork !== false) {
      try { activeFiles = svc.activeFiles(); } catch { activeFiles = undefined; }
    }
    const render = (maxTokens: number) => {
      const built = svc.getContextPack(query, { maxTokens, activeFiles });
      return { pack: built, text: `${CONTEXT_HEADER}\n\n${inlineAgentContext(svc, built, inlineLimit)}` };
    };

    // An explicit budget is honoured as given: a caller who asks for more than fits
    // inline has chosen the host's persisted delivery. Otherwise size to the limit,
    // and if the engine's minimum pack still overflows, ask once for less.
    let { pack, text } = render(options.maxTokens ?? budgetForInline(inlineLimit));
    if (options.maxTokens === undefined && text.length > inlineLimit) {
      ({ pack, text } = render(Math.floor(budgetForInline(inlineLimit) * 0.75)));
    }

    const base = {
      resolution: pack.target.resolution,
      confidence: pack.target.confidence.level,
      targets: pack.target.files,
      query,
      removed,
      estimatedTokens: pack.diagnostics.estimatedTokens,
    };
    if (pack.target.resolution === 'none' && !pack.targetNotFound) {
      return log({ output: null, decision: 'skipped-no-target', ...base });
    }

    // Still over: delivered anyway. The host's persisted form says the output was too
    // large and where the rest is, which is honest; cutting it here would not be.
    return log({
      output: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } },
      decision: 'delivered',
      deliveredChars: text.length,
      oversize: text.length > inlineLimit,
      ...base,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return log({ output: null, decision: 'failed-open', error: message });
  } finally {
    service?.close();
  }
}
