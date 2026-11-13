/**
 * `strata setup`: wire Strata into the editors a project uses, with one command.
 *
 * Why per editor
 * --------------
 * Each editor offers a different way to put context in front of its agent, and none
 * offers all of them. What each gets is the strongest mechanism it has:
 *
 *   Claude Code   a `UserPromptSubmit` hook: a context pack for every prompt, before the
 *                 agent's first turn (`strata hook user-prompt-submit`).
 *   Antigravity   no prompt hook, so an always-on workspace rule
 *                 (`.agents/rules/strata.md`) that points the agent at the project docs
 *                 and at `strata context`.
 *
 * Every editor shares the layer that needs no integration at all: `docs/strata/DECISIONS.md`
 * and `docs/strata/FLOW.md`, which any agent and any person can read. A git `post-commit`
 * hook keeps them current for editors that have no prompt hook to do it.
 *
 * What it never does
 * ------------------
 * It never overwrites what it did not write. Settings are merged, not replaced, and a
 * settings file it cannot parse is reported rather than rewritten; a rule file or a git
 * hook it does not recognise as its own is left alone or extended with a clearly marked
 * block. Running it twice changes nothing the second time.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export type Editor = 'claude-code' | 'antigravity';
export const EDITORS: Editor[] = ['claude-code', 'antigravity'];
const ALIASES: Record<string, Editor> = {
  'claude-code': 'claude-code', claude: 'claude-code', claudecode: 'claude-code',
  antigravity: 'antigravity', agy: 'antigravity', gemini: 'antigravity',
};

export function parseEditor(name: string): Editor | null {
  return ALIASES[name.trim().toLowerCase()] ?? null;
}

export interface SetupStep {
  /** What the step touched, relative to the repository root where it is inside it. */
  target: string;
  outcome: 'created' | 'updated' | 'unchanged' | 'skipped';
  note?: string;
}

const MANAGED = 'managed by `strata setup`';

// ------------------------------------------------------------------ the strata command

/**
 * How hooks should invoke Strata: `strata` when it is on PATH (portable, safe to commit),
 * otherwise this installation's own CLI by absolute path (works here, not on another
 * machine — said so in the step's note).
 */
export function strataCommand(cliEntry: string | undefined): { command: string; portable: boolean } {
  if (onPath('strata')) return { command: 'strata', portable: true };
  const entry = cliEntry ? path.resolve(cliEntry).replace(/\\/g, '/') : null;
  return entry ? { command: `node "${entry}"`, portable: false } : { command: 'strata', portable: true };
}

function onPath(name: string): boolean {
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat', '.ps1'] : [''];
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, name + ext)).isFile()) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

// ------------------------------------------------------------------ Claude Code

/** The prompt hook, merged into the project's `.claude/settings.json`. */
export function setupClaudeCode(repoRoot: string, command: string): SetupStep {
  const file = path.join(repoRoot, '.claude', 'settings.json');
  const target = '.claude/settings.json';
  let settings: Record<string, unknown> = {};
  let existed = false;
  if (fs.existsSync(file)) {
    existed = true;
    const text = fs.readFileSync(file, 'utf-8');
    try {
      const parsed: unknown = text.trim() ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      settings = parsed as Record<string, unknown>;
    } catch {
      return { target, outcome: 'skipped', note: 'the file is not valid JSON; it was left untouched. Fix it and run setup again.' };
    }
  }

  const hookCommand = `${command} hook user-prompt-submit`;
  const hooks = (settings['hooks'] && typeof settings['hooks'] === 'object' ? settings['hooks'] : {}) as Record<string, unknown>;
  const groups = Array.isArray(hooks['UserPromptSubmit']) ? hooks['UserPromptSubmit'] as { hooks?: { command?: string }[] }[] : [];
  const already = groups.some((g) => (g.hooks ?? []).some((h) => typeof h.command === 'string'
    && /\bhook\s+user-prompt-submit\b/.test(h.command) && /strata|cli[\\/]index\.js/.test(h.command)));
  if (already) return { target, outcome: 'unchanged', note: 'the Strata prompt hook is already configured' };

  groups.push({ hooks: [{ type: 'command', command: hookCommand } as { command: string }] });
  hooks['UserPromptSubmit'] = groups;
  settings['hooks'] = hooks;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return { target, outcome: existed ? 'updated' : 'created' };
}

// ------------------------------------------------------------------ Antigravity

/** The always-on workspace rule Antigravity loads from `.agents/rules/`. */
export function antigravityRule(command: string): string {
  return [
    '---',
    'trigger: always_on',
    'description: Use this project\'s Strata memory (decisions, history, rules) before changing code.',
    '---',
    `<!-- ${MANAGED}; rerun it to update this file instead of editing it -->`,
    '',
    '# Project memory (Strata)',
    '',
    'This repository keeps its development memory with Strata: why the code is the way it is, what was tried and',
    'failed, and the rules a change must respect.',
    '',
    'Before you change code:',
    '',
    '1. Read `docs/strata/DECISIONS.md` for decisions, failed approaches and rules that apply to the files you will',
    '   touch. A decision marked `OUT OF DATE` or `CONTRADICTED BY GIT` must not be relied on without checking the code.',
    '   Items labelled `DECLARED` are claims someone wrote down, not verified facts.',
    '2. Read `docs/strata/FLOW.md` for how the project evolved and how its modules fit together.',
    `3. If you can run commands, get context for your exact task: \`${command} context "<your task>"\`.`,
    '   Its first section, APPLICABILITY, says how far the context answers the task.',
    '',
    'After you finish, if you made a decision or an approach failed, record it so the next agent knows:',
    '',
    `\`${command} record --intent "<what was decided and why>" --files <paths> --attempt "<approach>:failed:<why>"\``,
    '',
  ].join('\n');
}

export function setupAntigravity(repoRoot: string, command: string): SetupStep {
  const file = path.join(repoRoot, '.agents', 'rules', 'strata.md');
  const target = '.agents/rules/strata.md';
  const text = antigravityRule(command);
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, 'utf-8');
    if (current === text) return { target, outcome: 'unchanged' };
    if (!current.includes(MANAGED)) {
      return { target, outcome: 'skipped', note: 'a rule file with this name exists and was not written by Strata; it was left untouched' };
    }
    fs.writeFileSync(file, text, 'utf-8');
    return { target, outcome: 'updated' };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf-8');
  return { target, outcome: 'created' };
}

// ------------------------------------------------------------------ git post-commit hook

const HOOK_BEGIN = `# >>> strata (${MANAGED}; edits inside this block are overwritten)`;
const HOOK_END = '# <<< strata';

/** The managed block: refresh the index and the docs after each commit, and never fail the commit. */
export function postCommitBlock(command: string): string {
  return [
    HOOK_BEGIN,
    `( ${command} index >/dev/null 2>&1 && ${command} docs --if-present --no-index >/dev/null 2>&1 ) || true`,
    HOOK_END,
  ].join('\n');
}

/**
 * Add the managed block to the repository's `post-commit` hook.
 *
 * The hooks directory is the one git itself uses (`git rev-parse --git-path hooks`), so
 * worktrees resolve correctly. A `core.hooksPath` pointing inside the working tree (a
 * hooks directory the project commits, such as `.husky/`) is not edited: that file belongs
 * to the project, and the block to add is reported instead.
 */
export function installPostCommitHook(repoRoot: string, command: string): SetupStep {
  let hooksDir: string;
  try {
    hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return { target: 'git post-commit hook', outcome: 'skipped', note: 'not a Git repository' };
  }
  hooksDir = path.resolve(repoRoot, hooksDir);
  const rel = path.relative(repoRoot, hooksDir).replace(/\\/g, '/');
  const insideTree = !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.startsWith('.git');
  const block = postCommitBlock(command);
  if (insideTree) {
    return { target: `${rel}/post-commit`, outcome: 'skipped',
             note: `core.hooksPath points into the project (${rel}); add this to its post-commit hook yourself:\n${block}` };
  }

  const file = path.join(hooksDir, 'post-commit');
  const target = '.git/hooks/post-commit';
  let current: string | null = null;
  try { current = fs.readFileSync(file, 'utf-8'); } catch { current = null; }

  let next: string;
  if (current === null) {
    next = `#!/bin/sh\n${block}\n`;
  } else if (current.includes(HOOK_BEGIN) && current.includes(HOOK_END)) {
    const start = current.indexOf(HOOK_BEGIN);
    const end = current.indexOf(HOOK_END) + HOOK_END.length;
    next = current.slice(0, start) + block + current.slice(end);
  } else {
    next = `${current.replace(/\s*$/, '')}\n\n${block}\n`;
  }
  if (next === current) return { target, outcome: 'unchanged' };
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(file, next, 'utf-8');
  try { fs.chmodSync(file, 0o755); } catch { /* permissions are not enforced on every platform */ }
  return { target, outcome: current === null ? 'created' : 'updated' };
}

// ------------------------------------------------------------------ .gitignore

/** The local, rebuildable parts of `.strata/`. Records stay committable. */
export const GITIGNORE_LINES = ['.strata/strata.db*', '.strata/docs-state.json'];

export function ensureGitignore(repoRoot: string): SetupStep {
  const file = path.join(repoRoot, '.gitignore');
  let current = '';
  try { current = fs.readFileSync(file, 'utf-8'); } catch { current = ''; }
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  // A broader rule that already ignores all of .strata/ covers these too.
  const covered = (entry: string): boolean => lines.includes(entry) || lines.includes('.strata/') || lines.includes('.strata');
  const missing = GITIGNORE_LINES.filter((l) => !covered(l));
  if (!missing.length) return { target: '.gitignore', outcome: 'unchanged' };
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, `${current}${prefix}# Strata's local cache (records in .strata/records/ are meant to be committed)\n${missing.join('\n')}\n`, 'utf-8');
  return { target: '.gitignore', outcome: current ? 'updated' : 'created' };
}
