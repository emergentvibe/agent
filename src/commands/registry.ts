import { CommandDef } from './types.js';

const commands = new Map<string, CommandDef>();

export function registerCommand(cmd: CommandDef): void {
  commands.set(cmd.name, cmd);
}

export function getCommand(name: string): CommandDef | undefined {
  return commands.get(name);
}

export function getAllCommands(): CommandDef[] {
  return [...commands.values()];
}
