import { Command } from 'commander';
import { StrataService } from '../../records/service.js';
import { GitClient } from '../../git/git.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize Strata in an existing Git repository')
    .action(() => {
      try {
        if (!GitClient.isGitRepo()) {
          console.error('❌ Error: Strata must be initialized inside an existing Git repository.');
          console.error('Run "git init" first or navigate into a Git repository.');
          process.exit(1);
        }

        const service = new StrataService();
        const result = service.init();
        const status = service.getStatus();

        console.log('✅ Strata initialized successfully.');
        console.log(`📂 Strata directory: ${result.strataDir}`);
        console.log(`🗄️ Database: ${status.dbPath}`);
        console.log(`🌿 Git branch: ${status.currentBranch}`);
        console.log(`📜 Git commits indexed: ${result.commitsIndexed}`);
        console.log(`✨ Ready to capture development context and provenance.`);
        service.close();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`❌ Initialization failed: ${message}`);
        process.exit(1);
      }
    });
}
