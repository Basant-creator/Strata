/**
 * Antigravity CLI (`agy -p … --output-format stream-json`) adapter.
 *
 * The stream is NDJSON, one envelope per line, each with an `event` key and one payload:
 *
 *   {"event":…,"conversation_id":…,"init":{"cwd":…,"model":…,"tools":[…],"permission_mode":…}}
 *   {"event":…,"step_update":{"step_index":N,"state":"ACTIVE"|"DONE"|"ERROR","step_type":…,
 *                             "tool_name":…,"tool_info":{"name":…,"parameters":{…},"output"|"error":…},
 *                             "text_delta":…}}
 *   {"event":…,"result":{"status":"SUCCESS"|…,"response":…,"num_turns":N,"duration_seconds":…,
 *                        "denied_actions":[{"action":…,"display_name":…}]}}
 *
 * A tool call is one step reported twice, ACTIVE and then DONE or ERROR, under the same step
 * index; it becomes one tool_use and one tool_result here.
 *
 * Tools are named the way the Claude Code stream names them — `run_command` as the shell,
 * `edit_file` as Edit, `view_file` as Read — because that is the vocabulary the detectors and
 * the work reader are written in; the vendor's own name stays in `raw`. Two things this stream
 * does not carry, and this adapter does not invent:
 *
 * - The prompt. The `user_input` step has no text. Pass it with `--prompt-file`.
 * - What an edit changed. `edit_file` reports the path and nothing else, so a derived record
 *   names the file it changed and no lines or symbols; the diff is in git.
 *
 * A malformed line is skipped, as in the Claude Code adapter: a truncated last line is
 * ordinary in a captured stream.
 */

import { NormalizedEvent, ParsedTranscript } from './types.js';

/** Vendor tool names, mapped onto the names the detectors read. */
const TOOL_NAMES: Record<string, string> = {
  edit_file: 'Edit',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  sed_file: 'Edit',
  write_to_file: 'Write',
  notebook_edit: 'NotebookEdit',
  view_file: 'Read',
  read_file: 'Read',
  grep_search: 'Grep',
  find_by_name: 'Glob',
};

/** Parameter keys a vendor tool names its file by. `Path` is the one seen on edit_file. */
const PATH_KEYS = ['Path', 'AbsolutePath', 'TargetFile', 'FilePath'];

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A vendor error payload as text: its message where it has one. */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  const e = object(error);
  if (e && typeof e.message === 'string') return e.message;
  return error === undefined ? '' : JSON.stringify(error);
}

export function parseAntigravityTranscript(raw: string, source: string): ParsedTranscript {
  const events: NormalizedEvent[] = [];
  const session: NonNullable<ParsedTranscript['session']> = { agent: 'Antigravity' };
  const outcome: NonNullable<ParsedTranscript['outcome']> = {};
  // Step index -> the tool_use already emitted for it, so DONE pairs with ACTIVE.
  const opened = new Map<number, string>();
  let windows = false;
  let index = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const conversation = typeof envelope.conversation_id === 'string' ? envelope.conversation_id : undefined;

    const init = object(envelope.init);
    if (init) {
      if (conversation) session.id = conversation;
      if (typeof init.model === 'string') session.model = init.model;
      if (typeof init.cwd === 'string') {
        session.cwd = init.cwd;
        windows = /^[A-Za-z]:[\\/]/.test(init.cwd);
      }
      events.push({ index: index++, kind: 'system', subtype: 'init', text: JSON.stringify(envelope), raw: envelope });
      continue;
    }

    const result = object(envelope.result);
    if (result) {
      const status = typeof result.status === 'string' ? result.status : undefined;
      // Only the vendor's own success word is success; anything else is kept as it reads.
      if (status) outcome.status = status.toUpperCase() === 'SUCCESS' ? 'success' : status.toLowerCase();
      if (typeof result.num_turns === 'number') outcome.numTurns = result.num_turns;
      if (typeof result.duration_seconds === 'number') outcome.durationSeconds = result.duration_seconds;
      const denied = Array.isArray(result.denied_actions) ? result.denied_actions : [];
      events.push({
        index: index++, kind: 'result',
        text: typeof result.response === 'string' && result.response ? result.response : JSON.stringify(result),
        ...(denied.length ? { denials: denied } : {}),
        raw: envelope,
      });
      continue;
    }

    const step = object(envelope.step_update);
    if (!step) continue;
    const stepIndex = typeof step.step_index === 'number' ? step.step_index : undefined;
    const state = typeof step.state === 'string' ? step.state : '';
    const stepType = typeof step.step_type === 'string' ? step.step_type : '';

    if (stepType === 'tool' && stepIndex !== undefined) {
      const info = object(step.tool_info) ?? {};
      const vendor = typeof info.name === 'string' ? info.name : typeof step.tool_name === 'string' ? step.tool_name : 'tool';
      const parameters = object(info.parameters) ?? {};
      const id = `${conversation ?? 'agy'}:${stepIndex}`;
      if (!opened.has(stepIndex)) {
        opened.set(stepIndex, id);
        const input: Record<string, unknown> = { ...parameters };
        if (typeof parameters.CommandLine === 'string') input.command = parameters.CommandLine;
        const file = PATH_KEYS.map((k) => parameters[k]).find((v) => typeof v === 'string');
        if (typeof file === 'string') input.file_path = file;
        const name = vendor === 'run_command' ? (windows ? 'PowerShell' : 'Bash') : TOOL_NAMES[vendor] ?? vendor;
        events.push({ index: index++, kind: 'tool_use', name, toolUseId: id, input, text: JSON.stringify(parameters), raw: envelope });
      }
      if (state === 'DONE' || state === 'ERROR') {
        const isError = state === 'ERROR' || info.error !== undefined;
        const text = isError ? errorText(info.error) : typeof info.output === 'string' ? info.output : JSON.stringify(info.output ?? '');
        // As agy 1.5.0 words a refusal: 'permission check failed for … user denied permission to run'.
        const denied = isError && /denied permission|permission check failed/i.test(text);
        events.push({ index: index++, kind: 'tool_result', toolUseId: id, isError, ...(denied ? { denied } : {}), text, raw: envelope });
      }
      continue;
    }

    // The agent's prose arrives as text deltas on its response steps.
    if (stepType === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
      events.push({ index: index++, kind: 'assistant_text', text: step.text_delta, raw: envelope });
      continue;
    }
    if (stepType === 'system_message') {
      events.push({ index: index++, kind: 'system', subtype: 'system_message', text: JSON.stringify(step), raw: envelope });
    }
    // user_input carries no text, and agent_response without a delta carries nothing to read.
  }

  return { adapter: 'antigravity', source, events, session, outcome };
}
