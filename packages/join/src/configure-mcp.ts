import * as fs from 'fs';
import * as path from 'path';

export interface McpConfig {
  mcpServers: Record<string, {
    type?: string;
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
}

/**
 * Configure Mem0 MCP server in Claude Code project settings.
 * Writes to .claude/settings.json in the target directory.
 */
export function configureMcp(targetDir: string, mem0Url: string): void {
  const claudeDir = path.join(targetDir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // Read existing settings or start fresh
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      // Corrupted settings — start fresh
    }
  }

  // Ensure mcpServers exists
  if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
    settings.mcpServers = {};
  }

  const mcpServers = settings.mcpServers as Record<string, unknown>;

  // Add mem0 server config
  mcpServers['mem0'] = {
    type: 'sse',
    url: mem0Url,
  };

  // Write back
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}
