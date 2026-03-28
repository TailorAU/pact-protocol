import { Command } from 'commander';
import * as api from '../api.js';

export function registerObjectCommand(program: Command): void {
  program
    .command('object <proposalId>')
    .description('Object to a proposal — blocks auto-merge, forces renegotiation')
    .requiredOption('--doc <docId>', 'Document ID')
    .requiredOption('--reason <text>', 'Why this violates your constraints')
    .option('--json', 'Output as JSON')
    .action(async (proposalId: string, opts: { doc: string; reason: string; json?: boolean }) => {
      try {
        await api.objectToProposal(opts.doc, proposalId, opts.reason);
        if (opts.json) {
          console.log(JSON.stringify({ status: 'objected', proposalId }));
        } else {
          console.log(`Objection raised against proposal ${proposalId}.`);
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
