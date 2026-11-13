import { Command } from 'commander';
import { startServer } from '../../mcp/server.js';

/**
 * `strata mcp` — run the MCP server on stdio. The published package is one bundled file,
 * so the server cannot be started as a file of its own; it is started from here.
 */
export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Run the Strata MCP server on stdio')
    .option('--repo <path>', 'Repository root (defaults to the current directory)')
    .action(async (options: { repo?: string }) => {
      await startServer(options.repo);
    });
}
