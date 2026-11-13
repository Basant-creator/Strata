import { Command } from 'commander';
import { StrataService } from '../../records/service.js';
import { TargetType } from '../../code/graph.js';

/**
 * `strata context` — the context engine's front door.
 *
 * This extends the original command rather than sitting beside it. The old behaviour (a
 * record-only digest) is still reachable with `--records-only`, because the MCP tool
 * `strata_get_context` and its existing clients depend on that exact output and a silent
 * change of shape would break them.
 *
 * The query is positional and untyped on purpose. `strata context src/server.ts`,
 * `strata context --symbol googleConfig` and `strata context "why is this still here"`
 * all go through the same resolver, because forcing the caller to declare which kind of
 * thing they are asking about is precisely the manual work the engine exists to remove.
 */
export function registerContextCommand(program: Command): void {
  program
    .command('context <query>')
    .description('Assemble a compact, evidence-backed development context pack for a task, file or symbol')
    .option('-d, --depth <n>', 'graph expansion depth (0-3)', '1')
    .option('-m, --max-tokens <n>', 'hard budget for the evidence (the applicability block is added outside it)', '3200')
    .option('--symbol', 'treat the query as a symbol name')
    .option('--file', 'treat the query as a file path')
    .option('--task', 'treat the query as a task description')
    .option('--json', 'emit the structured pack instead of rendered text')
    .option('-f, --files <files...>', 'extra files (records-only mode)')
    .option('--records-only', 'use the original record digest instead of the context engine')
    .action((query: string, options) => {
      const service = new StrataService();
      try {
        if (!service.isInitialized()) {
          console.error('Strata is not initialized. Run "strata init" first.');
          process.exit(1);
        }

        if (options.recordsOnly) {
          const digest = service.getContext(query, options.files || []);
          console.log(options.json ? JSON.stringify(digest, null, 2) : `\n${digest.formattedContext}\n`);
          return;
        }

        let targetType: TargetType | undefined;
        if (options.symbol) targetType = 'symbol';
        else if (options.file) targetType = 'file';
        else if (options.task) targetType = 'task';

        const depth = Number.parseInt(String(options.depth), 10);
        const maxTokens = Number.parseInt(String(options.maxTokens), 10);
        if (Number.isNaN(depth) || Number.isNaN(maxTokens)) {
          console.error('--depth and --max-tokens must be numbers.');
          process.exit(1);
        }

        const pack = service.getContextPack(query, { depth, maxTokens, targetType });

        if (options.json) {
          console.log(JSON.stringify(pack, null, 2));
        } else {
          console.log(`\n${service.renderAgentContext(pack)}\n`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Context retrieval failed: ${message}`);
        process.exit(1);
      } finally {
        service.close();
      }
    });
}
