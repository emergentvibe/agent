import { describe, expect, it, beforeEach } from 'vitest';
import { registerCommand, getCommand, getAllCommands } from './registry.js';

describe('Command Registry', () => {
  it('registers and retrieves a command', () => {
    registerCommand({
      name: 'test-cmd',
      description: 'A test command',
      type: 'local',
      handler: async () => 'ok',
    });
    const cmd = getCommand('test-cmd');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('test-cmd');
    expect(cmd!.type).toBe('local');
  });

  it('returns undefined for unknown commands', () => {
    expect(getCommand('nonexistent')).toBeUndefined();
  });

  it('lists all registered commands', () => {
    const all = getAllCommands();
    expect(all.length).toBeGreaterThan(0);
    const names = all.map((c) => c.name);
    expect(names).toContain('test-cmd');
  });
});

describe('Commands registered via barrel import', () => {
  // The barrel import in telegram.ts (or direct import here) triggers registration
  beforeEach(async () => {
    await import('./index.js');
  });

  it('has agent commands registered', () => {
    expect(getCommand('today')).toBeDefined();
    expect(getCommand('today')!.type).toBe('agent');
    expect(getCommand('hello')).toBeDefined();
    expect(getCommand('connect')).toBeDefined();
  });

  it('has subscribe commands registered', () => {
    expect(getCommand('subscribe')).toBeDefined();
    expect(getCommand('subscribe')!.type).toBe('local');
    expect(getCommand('subscribe')!.featureGate).toBe('subscribe');
    expect(getCommand('subscribe')!.handler).toBeDefined();

    expect(getCommand('unsubscribe')).toBeDefined();
    expect(getCommand('subscriptions')).toBeDefined();
  });

  it('has utility commands registered', () => {
    expect(getCommand('chatid')).toBeDefined();
    expect(getCommand('chatid')!.visible).toBe(false);
    expect(getCommand('ping')).toBeDefined();
    expect(getCommand('ping')!.visible).toBe(false);
  });
});
