#!/usr/bin/env node

// Suppress Node's experimental SQLite warning for clean CLI output
const originalEmit = process.emit;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).emit = function (name: string, data: unknown, ...args: unknown[]) {
  if (
    name === 'warning' &&
    typeof data === 'object' &&
    data !== null &&
    'name' in data &&
    (data as { name: string }).name === 'ExperimentalWarning' &&
    'message' in data &&
    typeof (data as { message: string }).message === 'string' &&
    (data as { message: string }).message.includes('SQLite')
  ) {
    return false;
  }
  return Reflect.apply(originalEmit, process, [name, data, ...args]);
};

import { Command } from 'commander';
import { registerInitCommand } from './commands/init.js';
import { registerStatusCommand } from './commands/status.js';
import { registerRecordCommand } from './commands/record.js';
import { registerHistoryCommand } from './commands/history.js';
import { registerExplainCommand } from './commands/explain.js';
import { registerContextCommand } from './commands/context.js';
import { registerDeriveCommand } from './commands/derive.js';
import { registerIndexCommand } from './commands/index-code.js';
import { registerHookCommand } from './commands/hook.js';
import { registerDocsCommand } from './commands/docs.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerMigrateRecordsCommand } from './commands/migrate-records.js';
import { registerMcpCommand } from './commands/mcp.js';

const program = new Command();

program
  .name('strata')
  .description('Repository-local development context and provenance framework for AI-assisted software development')
  .version('0.1.0');

// Register subcommands
registerInitCommand(program);
registerStatusCommand(program);
registerRecordCommand(program);
registerHistoryCommand(program);
registerExplainCommand(program);
registerContextCommand(program);
registerDeriveCommand(program);
registerIndexCommand(program);
registerHookCommand(program);
registerDocsCommand(program);
registerSetupCommand(program);
registerMigrateRecordsCommand(program);
registerMcpCommand(program);

program.parse(process.argv);
