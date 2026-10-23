export interface CommandContext {
  userId: string;
  userName: string;
  chatJid: string;
  dmJid: string;
  groupFolder: string | null;
  args: string;
}

export interface CommandDef {
  name: string;
  description: string;
  type: 'local' | 'agent';
  featureGate?: string;
  visible?: boolean;
  handler?: (ctx: CommandContext) => Promise<string>;
}
