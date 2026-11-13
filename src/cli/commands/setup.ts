import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { StrataService } from '../../records/service.js';
import { DOCS_DIR } from '../../docs/project-docs.js';
import {
  Editor, EDITORS, SetupStep, ensureGitignore, installPostCommitHook, parseEditor, setupAntigravity, setupClaudeCode,
  strataCommand,
} from '../../integrations/setup.js';

/**
 * `strata setup <editor...>` — make Strata automatic in the editors this project uses.
 *
 * Initialises Strata if needed, indexes, writes docs/strata/, adds the local cache to
 * .gitignore, installs the post-commit hook that keeps the docs current, and wires each
 * named editor with the strongest mechanism it has. See `src/integrations/setup.ts`.
 */
export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description(`Wire Strata into your editors so it runs automatically (editors: ${EDITORS.join(', ')})`)
    .argument('<editors...>', `one or more of: ${EDITORS.join(', ')}`)
    .option('--no-git-hook', 'do not install the post-commit hook that keeps docs/strata/ current')
    .option('--command <cmd>', 'how hooks should run Strata (default: "strata" when it is on PATH)')
    .action((names: string[], options) => {
      const editors: Editor[] = [];
      for (const name of names) {
        const editor = parseEditor(name);
        if (!editor) {
          console.error(`Unknown editor "${name}". Supported: ${EDITORS.join(', ')}.`);
          process.exit(1);
        }
        if (!editors.includes(editor)) editors.push(editor);
      }

      const service = new StrataService();
      const steps: SetupStep[] = [];
      try {
        const root = service.getRepoRoot();
        if (!service.isInitialized()) {
          service.init();
          steps.push({ target: '.strata/', outcome: 'created', note: 'Strata initialised' });
        }
        steps.push(ensureGitignore(root));
        const { command, portable } = options.command
          ? { command: String(options.command), portable: true }
          : strataCommand(process.argv[1]);
        if (options.gitHook !== false) steps.push(installPostCommitHook(root, command));
        for (const editor of editors) {
          steps.push(editor === 'claude-code' ? setupClaudeCode(root, command) : setupAntigravity(root, command));
        }

        // Last, so the index and the docs already include every file setup wrote: run twice,
        // the second run changes nothing.
        const existed = new Set(['DECISIONS.md', 'FLOW.md'].filter((f) => fs.existsSync(path.join(root, DOCS_DIR, f)))
          .map((f) => `${DOCS_DIR.replace(/\\/g, '/')}/${f}`));
        service.indexCode();
        const docs = service.writeDocs();
        for (const f of docs.written) steps.push({ target: f, outcome: existed.has(f) ? 'updated' : 'created' });
        for (const f of docs.unchanged) steps.push({ target: f, outcome: 'unchanged' });

        console.log(`Strata setup in ${root}\n`);
        for (const s of steps) {
          console.log(`  ${s.outcome.padEnd(9)} ${s.target}${s.note ? `\n            ${s.note.replace(/\n/g, '\n            ')}` : ''}`);
        }
        if (!portable) {
          console.log(`\nNote: "strata" is not on PATH, so the hooks call ${command}.` +
            ' That path works on this machine only; run "npm link" in the Strata repository and setup again' +
            ' to use the portable "strata" command.');
        }
        console.log('\nWhat happens now:');
        if (editors.includes('claude-code')) console.log('  Claude Code   every prompt gets a Strata context pack automatically.');
        if (editors.includes('antigravity')) console.log('  Antigravity   an always-on rule points the agent to docs/strata/ and `strata context`.');
        console.log('  Every editor  docs/strata/DECISIONS.md and FLOW.md stay current; commit them with the project.');
      } catch (err: unknown) {
        console.error(`strata setup failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        service.close();
      }
    });
}
