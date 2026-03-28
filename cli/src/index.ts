import { Command } from 'commander';
import { registerConfigCommand } from './commands/config.js';
import { registerJoinCommand } from './commands/join.js';
import { registerAgentsCommand } from './commands/agents.js';
import { registerIcsCommands } from './commands/intent.js';
import { registerObjectCommand } from './commands/object.js';
import { registerPollCommand } from './commands/poll.js';
import { registerDoneCommand } from './commands/done.js';
import { registerEscalateCommands } from './commands/escalate.js';
import { registerLockCommands } from './commands/lock.js';

const program = new Command();

program
  .name('pact')
  .description('PACT — Protocol for Agent Consensus and Truth. Coordination and consensus primitives for multi-agent collaboration.')
  .version('0.2.0');

registerConfigCommand(program);
registerJoinCommand(program);
registerAgentsCommand(program);
registerIcsCommands(program);
registerObjectCommand(program);
registerPollCommand(program);
registerDoneCommand(program);
registerEscalateCommands(program);
registerLockCommands(program);

program.parse();
