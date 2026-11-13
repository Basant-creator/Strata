import { Command } from 'commander';
import { StrataService } from '../../records/service.js';

/**
 * `strata docs` — write docs/strata/DECISIONS.md and docs/strata/FLOW.md.
 *
 * The readable face of the store: every decision recorded, and how the project evolved,
 * as Markdown any agent or person can open. Files are rewritten only when their content
 * changed. See `src/docs/project-docs.ts`.
 */
export function registerDocsCommand(program: Command): void {
  program
    .command('docs')
    .description('Write docs/strata/DECISIONS.md and docs/strata/FLOW.md from the records, git and the code index')
    .option('--if-present', 'only update docs that already exist (used by the git hook); do nothing otherwise')
    .option('--no-index', 'skip refreshing the code index first')
    .option('--json', 'print what was written as JSON')
    .action((options) => {
      const service = new StrataService();
      try {
        if (!service.isInitialized()) {
          if (options.ifPresent) return;
          console.error('Strata is not initialized. Run "strata init" (or "strata setup <editor>") first.');
          process.exit(1);
        }
        if (options.index !== false) service.indexCode({ trustFileTimes: true });
        const result = options.ifPresent ? service.refreshDocsIfPresent() : service.writeDocs();
        if (options.json) {
          console.log(JSON.stringify(result ?? { written: [], unchanged: [] }, null, 2));
          return;
        }
        if (!result) return;
        for (const f of result.written) console.log(`wrote     ${f}`);
        for (const f of result.unchanged) console.log(`unchanged ${f}`);
      } catch (err: unknown) {
        console.error(`strata docs failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        service.close();
      }
    });
}
