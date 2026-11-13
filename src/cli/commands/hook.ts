import { Command } from 'commander';
import { buildPromptContext, PromptHookPayload } from '../../integrations/claude-hook.js';

/**
 * `strata hook user-prompt-submit` — task-start context for Claude Code.
 *
 * Reads the hook payload on stdin, writes the hook response on stdout, and exits 0 in
 * every case. Claude Code treats stdout as the hook's answer, so nothing else may be
 * written there; and it treats a non-zero exit as a hook failure the user sees, which
 * a missing or broken Strata store must never cause. See `src/integrations/claude-hook.ts`.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let raw = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (raw += chunk));
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
}

export function registerHookCommand(program: Command): void {
  const hook = program
    .command('hook')
    .description('Integrations that deliver Strata context to an agent without being asked');

  hook
    .command('user-prompt-submit')
    .description('Claude Code UserPromptSubmit hook: inject a context pack for the submitted prompt')
    .option('-m, --max-tokens <n>', 'explicit context budget (default: sized to fit inline)')
    .option('--inline-limit <chars>', 'characters the host injects inline', '10000')
    .option('--no-refresh', 'build the pack from the stored index without refreshing it first')
    .action(async (options) => {
      const raw = await readStdin();
      let payload: PromptHookPayload = {};
      try {
        payload = raw.trim() ? (JSON.parse(raw) as PromptHookPayload) : {};
      } catch {
        // A payload we cannot read is not a reason to fail the user's prompt.
        process.exit(0);
      }

      const maxTokens = options.maxTokens === undefined
        ? Number.NaN : Number.parseInt(String(options.maxTokens), 10);
      const inlineLimit = Number.parseInt(String(options.inlineLimit), 10);
      const result = buildPromptContext(payload, {
        maxTokens: Number.isNaN(maxTokens) ? undefined : maxTokens,
        inlineLimit: Number.isNaN(inlineLimit) ? undefined : inlineLimit,
        deliveryLog: process.env['STRATA_DELIVERY_LOG'] || undefined,
        refresh: options.refresh !== false,
      });
      if (result.output) process.stdout.write(JSON.stringify(result.output));
      process.exit(0);
    });
}
