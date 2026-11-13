import { describe, it, expect } from 'vitest';
import { deriveRecord, detectTranscriptFormat } from '../src/derive/derive.js';
import { parseAntigravityTranscript } from '../src/derive/antigravity.js';
import { parseClaudeCodeTranscript } from '../src/derive/claude-code.js';

/**
 * Deriving a record from an Antigravity CLI session, and refusing files that are not one.
 *
 * The fixture has the shape of a real `agy -p … --output-format stream-json` session
 * (agy 1.5.0): the agent read two files, edited math.mjs, and its `node check.mjs` was
 * refused by the permission layer. Read as Claude Code's stream, that session used to give
 * "Events: 0" and a record about the transcript file itself.
 */

const CONV = 'fca464c0-2c19-42e2-91fc-6966d3c02cef';
const CWD_WIN = 'C:\\work\\demo';
const line = (o: unknown): string => JSON.stringify(o);
const step = (s: Record<string, unknown>): string => line({ event: 'step_update', step_update: { conversation_id: CONV, ...s } });
const tool = (i: number, state: string, name: string, parameters: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  step({ step_index: i, state, step_type: 'tool', tool_name: name, tool_info: { name, parameters, ...extra } });

function session(opts: { cwd?: string; check?: 'refused' | 'failed' | 'passed'; status?: string } = {}): string {
  const cwd = opts.cwd ?? CWD_WIN;
  const sep = cwd.includes('\\') ? '\\' : '/';
  const file = (n: string) => `${cwd}${sep}${n}`;
  const check = opts.check ?? 'refused';
  const end = check === 'passed'
    ? tool(7, 'DONE', 'run_command', { CommandLine: 'node check.mjs' }, { output: 'ok' })
    : check === 'failed'
      ? tool(7, 'ERROR', 'run_command', { CommandLine: 'node check.mjs' }, { error: { type: 'TOOL_ERROR', message: 'FAIL: add(2, 3) = -1\nexit code 1' } })
      : tool(7, 'ERROR', 'run_command', { CommandLine: 'node check.mjs' }, { error: { type: 'TOOL_ERROR',
          message: 'permission check failed for unsandboxed "node check.mjs": user denied permission to run command:\nnode check.mjs' } });
  return [
    line({ event: 'init', conversation_id: CONV, init: { cwd, model: 'gemini-3.8-flash-medium', tools: ['edit_file', 'run_command'], permission_mode: 'request-review' } }),
    step({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
    step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'I will read math.mjs and fix add().' }),
    tool(2, 'ACTIVE', 'read_file', { Path: file('math.mjs') }),
    tool(2, 'DONE', 'read_file', { Path: file('math.mjs') }, { output: '3 lines, 46 bytes' }),
    tool(5, 'ACTIVE', 'edit_file', { Path: file('math.mjs') }),
    tool(5, 'DONE', 'edit_file', { Path: file('math.mjs') }),
    tool(7, 'ACTIVE', 'run_command', { CommandLine: 'node check.mjs' }),
    end,
    line({ event: 'result', result: { conversation_id: CONV, status: opts.status ?? 'SUCCESS', response: '', duration_seconds: 13.2, num_turns: 1,
      denied_actions: check === 'refused' ? [{ action: 'command', display_name: 'RunCommand' }] : [] } }),
    '{"event":"step_update","step_upd', // a truncated last line, as a killed capture leaves
  ].join('\n');
}

const PROMPT = 'check.mjs fails because add() in math.mjs is wrong. Fix add() so check.mjs passes, then run node check.mjs.';

describe('reading an Antigravity stream', () => {
  it('pairs each tool step\'s ACTIVE and DONE into one call and its result, in the detectors\' vocabulary', () => {
    const t = parseAntigravityTranscript(session(), 'agy.jsonl');
    expect(t.adapter).toBe('antigravity');
    expect(t.session).toEqual({ agent: 'Antigravity', id: CONV, model: 'gemini-3.8-flash-medium', cwd: CWD_WIN });
    const uses = t.events.filter((e) => e.kind === 'tool_use');
    expect(uses.map((e) => e.name)).toEqual(['Read', 'Edit', 'PowerShell']);
    expect(uses[1]!.input).toEqual({ Path: `${CWD_WIN}\\math.mjs`, file_path: `${CWD_WIN}\\math.mjs` });
    expect(uses[2]!.input).toEqual({ CommandLine: 'node check.mjs', command: 'node check.mjs' });
    const results = t.events.filter((e) => e.kind === 'tool_result');
    expect(results.map((e) => e.toolUseId)).toEqual(uses.map((e) => e.toolUseId));
    expect(results.map((e) => [e.isError, e.denied ?? false])).toEqual([[false, false], [false, false], [true, true]]);
    expect(t.events.find((e) => e.kind === 'assistant_text')?.text).toBe('I will read math.mjs and fix add().');
    expect(t.outcome).toEqual({ status: 'success', numTurns: 1, durationSeconds: 13.2 });
    expect(t.events.find((e) => e.kind === 'result')?.denials).toEqual([{ action: 'command', display_name: 'RunCommand' }]);
    expect(t.prompt).toBeUndefined(); // the stream does not carry it
  });

  it('names the shell by the session\'s platform', () => {
    const t = parseAntigravityTranscript(session({ cwd: '/home/dev/demo' }), 'agy.jsonl');
    expect(t.events.filter((e) => e.kind === 'tool_use').map((e) => e.name)).toEqual(['Read', 'Edit', 'Bash']);
  });

  it('keeps a status other than SUCCESS as the stream reports it', () => {
    expect(parseAntigravityTranscript(session({ status: 'CANCELLED' }), 'agy.jsonl').outcome?.status).toBe('cancelled');
  });
});

describe('a record derived from an Antigravity session', () => {
  it('names the file it changed, the agent, and the intent from the supplied prompt', () => {
    const { record, findings } = deriveRecord(session(), 'auto', 'agy.jsonl', { prompt: PROMPT });
    expect(record.agent?.name).toBe('Antigravity');
    expect(record.files).toEqual([{ path: 'math.mjs', changeType: 'modify' }]);
    expect(record.intent).toMatch(/^check\.mjs fails because add\(\) in math\.mjs is wrong/);
    expect(record.result.status).toBe('success');
    expect(findings.map((f) => f.kind)).toEqual(['permission_denied']);
  });

  it('a refused check neither passes nor fails the change', () => {
    const { record } = deriveRecord(session(), 'auto', 'agy.jsonl', { prompt: PROMPT });
    expect(record.attempts.map((a) => a.status)).toEqual(['unknown']);
  });

  it('a check that ran and failed does fail it; one that ran and passed succeeds', () => {
    expect(deriveRecord(session({ check: 'failed' }), 'auto', 'agy.jsonl', { prompt: PROMPT }).record.attempts.map((a) => a.status))
      .toEqual(['failed']);
    expect(deriveRecord(session({ check: 'passed' }), 'auto', 'agy.jsonl', { prompt: PROMPT }).record.attempts.map((a) => a.status))
      .toEqual(['succeeded']);
  });

  it('without a prompt, the intent is UNKNOWN, not invented', () => {
    expect(deriveRecord(session(), 'auto', 'agy.jsonl').record.intent).toMatch(/^UNKNOWN: the transcript did not carry a task prompt/);
  });
});

describe('the format check', () => {
  const claude = [
    line({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5', cwd: '/work/demo' }),
    line({ type: 'user', message: { content: 'Fix add() in math.mjs.' } }),
    line({ type: 'result', subtype: 'success', num_turns: 1, duration_ms: 1000 }),
  ].join('\n');

  it('tells the formats apart', () => {
    expect(detectTranscriptFormat(session())).toBe('antigravity');
    expect(detectTranscriptFormat(claude)).toBe('claude-code');
    expect(detectTranscriptFormat('Fix add() in math.mjs.\n')).toBeNull();
    expect(detectTranscriptFormat('')).toBeNull();
  });

  it('a session read as the wrong format is an error that names the right one', () => {
    expect(() => deriveRecord(session(), 'claude-code', 'agy.jsonl'))
      .toThrow('agy.jsonl is Antigravity\'s session format, not Claude Code\'s; use --adapter antigravity');
    expect(() => deriveRecord(claude, 'antigravity', 'cc.jsonl'))
      .toThrow('cc.jsonl is Claude Code\'s session format, not Antigravity\'s; use --adapter claude-code');
  });

  it('a file that is no session, or holds no events, is an error, not an empty record', () => {
    expect(() => deriveRecord('Fix add() in math.mjs.\n', 'auto', 'notes.txt'))
      .toThrow('notes.txt is not a session stream Strata can read (supported: claude-code, antigravity).');
    // With the format named, an empty capture (an aborted run leaves one) says what it lacks.
    expect(() => deriveRecord('', 'claude-code', 'empty.jsonl')).toThrow('empty.jsonl holds no Claude Code session events; there is nothing to derive.');
    expect(() => deriveRecord('{}', 'gemini', 'r.jsonl')).toThrow(/Unknown transcript adapter "gemini"/);
  });

  it('auto reads a Claude Code stream exactly as naming it does', () => {
    expect(deriveRecord(claude, 'auto', 'cc.jsonl').record).toEqual(deriveRecord(claude, 'claude-code', 'cc.jsonl').record);
  });
});

describe('a refused call in a Claude Code session', () => {
  const run = (resultText: string, denials: unknown[] = []) => [
    line({ type: 'system', subtype: 'init', session_id: 's2', cwd: '/work/demo' }),
    line({ type: 'user', message: { content: 'Fix add() in math.mjs, then run node check.mjs.' } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/work/demo/math.mjs', old_string: 'a - b', new_string: 'a + b' } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'The file has been updated.' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'node check.mjs' } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: resultText }] } }),
    line({ type: 'result', subtype: 'success', num_turns: 2, duration_ms: 2000, permission_denials: denials }),
  ].join('\n');

  it('is marked by its wording, or by the result\'s list of refused ids, and does not fail the change', () => {
    const worded = parseClaudeCodeTranscript(run("Claude requested permissions to use Bash, but you haven't granted it yet."), 'cc.jsonl');
    expect(worded.events.find((e) => e.toolUseId === 't2' && e.kind === 'tool_result')?.denied).toBe(true);
    const listed = parseClaudeCodeTranscript(run('Permission denied', [{ tool_name: 'Bash', tool_use_id: 't2', tool_input: {} }]), 'cc.jsonl');
    expect(listed.events.find((e) => e.toolUseId === 't2' && e.kind === 'tool_result')?.denied).toBe(true);
    const { record, findings } = deriveRecord(run('Permission denied', [{ tool_name: 'Bash', tool_use_id: 't2', tool_input: {} }]), 'auto', 'cc.jsonl');
    expect(record.attempts.map((a) => a.status)).toEqual(['unknown']);
    expect(findings.map((f) => f.kind)).toEqual(['permission_denied']);
  });

  it('an ordinary error still fails it', () => {
    const { record } = deriveRecord(run('FAIL: add(2, 3) = -1\nexit code 1'), 'auto', 'cc.jsonl');
    expect(record.attempts.map((a) => a.status)).toEqual(['failed']);
  });
});
