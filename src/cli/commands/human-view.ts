import { Command } from 'commander';
import { StrataService } from '../../records/service.js';
import { TargetType } from '../../code/graph.js';
import { HumanView } from '../../context/human.js';

/**
 * `strata explain` and `strata history`: the human views of the context engine.
 *
 * The target is untyped for the same reason as `strata context`: a file, a symbol, a
 * directory and a sentence all go through one resolver, and asking the developer to say
 * which kind of thing they typed is the work the resolver exists to remove. The flags are
 * there for when the resolver's reading is not the one meant.
 */
export function addHumanViewOptions(command: Command): Command {
  return command
    .option('--symbol', 'treat the target as a symbol name')
    .option('--file', 'treat the target as a file path')
    .option('--task', 'treat the target as a description in words')
    .option('-d, --depth <n>', 'how far to follow code relationships (0-3)', '1')
    .option('--json', 'emit the structured pack instead of the rendered view');
}

export function runHumanView(target: string, view: HumanView, options: Record<string, unknown>): void {
  const service = new StrataService();
  try {
    if (!service.isInitialized()) {
      console.error('Strata is not initialized. Run "strata init" first.');
      process.exit(1);
    }
    let targetType: TargetType | undefined;
    if (options['symbol']) targetType = 'symbol';
    else if (options['file']) targetType = 'file';
    else if (options['task']) targetType = 'task';
    const depth = Number.parseInt(String(options['depth'] ?? '1'), 10);
    if (Number.isNaN(depth)) {
      console.error('--depth must be a number.');
      process.exit(1);
    }
    const { pack, text } = service.humanView(target, view, { targetType, depth });
    console.log(options['json'] ? JSON.stringify(pack, null, 2) : text);
    if (pack.targetNotFound) process.exitCode = 2;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${view === 'history' ? 'History' : 'Explain'} failed: ${message}`);
    process.exit(1);
  } finally {
    service.close();
  }
}
