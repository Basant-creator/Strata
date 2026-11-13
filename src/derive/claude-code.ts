/**
 * Claude Code `--output-format stream-json` adapter.
 *
 * The stream is NDJSON, one envelope per line. Only four envelope shapes carry
 * anything this module needs:
 *
 *   {"type":"system","subtype":"task_started"|"task_updated"|...,...}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use"|"text"|"thinking",...}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","is_error":..,"content":..}]}}
 *   {"type":"result","subtype":..,"num_turns":N,"duration_ms":..,"permission_denials":[..]}
 *
 * A malformed line is skipped rather than fatal: transcripts are captured from a
 * live process and a truncated final line is ordinary, not a reason to derive
 * nothing from the 200 events that did parse.
 */

import { NormalizedEvent, ParsedTranscript } from './types.js';

/** Flatten a tool_result's `content`, which is a string or a content-block array. */
function flattenResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text: unknown }).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

export function parseClaudeCodeTranscript(raw: string, source: string): ParsedTranscript {
  const events: NormalizedEvent[] = [];
  const session: { id?: string; agent?: string; model?: string; cwd?: string } = {};
  const outcome: { status?: string; numTurns?: number; durationSeconds?: number } = {};
  let prompt: string | undefined;
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

    const type = String(envelope.type ?? '');

    if (type === 'system') {
      if (envelope.subtype === 'init') {
        session.id = typeof envelope.session_id === 'string' ? envelope.session_id : session.id;
        session.agent = 'Claude Code';
        if (typeof envelope.model === 'string') session.model = envelope.model;
        if (typeof envelope.cwd === 'string') session.cwd = envelope.cwd;
      }
      events.push({
        index: index++,
        kind: 'system',
        subtype: typeof envelope.subtype === 'string' ? envelope.subtype : undefined,
        toolUseId: typeof envelope.tool_use_id === 'string' ? envelope.tool_use_id : undefined,
        text: JSON.stringify(envelope),
        raw: envelope,
      });
      continue;
    }

    if (type === 'result') {
      outcome.status = typeof envelope.subtype === 'string' ? envelope.subtype : undefined;
      if (typeof envelope.num_turns === 'number') outcome.numTurns = envelope.num_turns;
      if (typeof envelope.duration_ms === 'number') outcome.durationSeconds = envelope.duration_ms / 1000;
      const denials = Array.isArray(envelope.permission_denials) ? envelope.permission_denials : [];
      events.push({
        index: index++,
        kind: 'result',
        text: typeof envelope.result === 'string' ? envelope.result : JSON.stringify(envelope),
        ...(denials.length ? { denials } : {}),
        raw: envelope,
      });
      continue;
    }

    // Heartbeats on a long-running tool call. They are the only place the stream
    // states how long a command actually ran before it was backgrounded.
    if (type === 'tool_progress') {
      events.push({
        index: index++,
        kind: 'system',
        subtype: 'tool_progress',
        toolUseId:
          typeof envelope.parent_tool_use_id === 'string' ? envelope.parent_tool_use_id : undefined,
        text: JSON.stringify(envelope),
        raw: envelope,
      });
      continue;
    }

    const message = envelope.message as Record<string, unknown> | undefined;
    if (!message) continue;
    if (typeof message.model === 'string' && !session.model) session.model = message.model;

    const content = message.content;

    // A user turn whose content is a bare string is the task prompt, not a result.
    if (type === 'user' && typeof content === 'string') {
      if (prompt === undefined) prompt = content;
      events.push({ index: index++, kind: 'prompt', text: content, raw: envelope });
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const block of content as Array<Record<string, unknown>>) {
      const blockType = String(block.type ?? '');
      if (blockType === 'tool_use') {
        events.push({
          index: index++,
          kind: 'tool_use',
          name: typeof block.name === 'string' ? block.name : undefined,
          toolUseId: typeof block.id === 'string' ? block.id : undefined,
          input: (block.input ?? {}) as Record<string, unknown>,
          text: JSON.stringify(block.input ?? {}),
          raw: envelope,
        });
      } else if (blockType === 'tool_result') {
        const text = flattenResultContent(block.content);
        const isError = block.is_error === true;
        events.push({
          index: index++,
          kind: 'tool_result',
          toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
          isError,
          // How Claude Code words a refusal; the result envelope's list, below, names the rest.
          ...(isError && /^Claude requested permissions? to /i.test(text) ? { denied: true } : {}),
          text,
          raw: envelope,
        });
      } else if (blockType === 'text') {
        const text = typeof block.text === 'string' ? block.text : '';
        if (type === 'user' && prompt === undefined) prompt = text;
        events.push({
          index: index++,
          kind: type === 'user' ? 'prompt' : 'assistant_text',
          text,
          raw: envelope,
        });
      }
      // 'thinking' blocks are deliberately not normalised. They are the agent's
      // own account of itself, which is exactly the source this module exists to
      // stop depending on.
    }
  }

  // The result envelope names refused calls by id, whatever their result's wording.
  const refused = new Set<string>();
  for (const e of events) {
    for (const d of e.denials ?? []) {
      const id = (d as { tool_use_id?: unknown } | null)?.tool_use_id;
      if (typeof id === 'string') refused.add(id);
    }
  }
  for (const e of events) if (e.kind === 'tool_result' && e.toolUseId && refused.has(e.toolUseId)) e.denied = true;

  return { adapter: 'claude-code', source, events, prompt, session, outcome };
}
