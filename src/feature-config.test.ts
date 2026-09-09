import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  loadFeatureConfig,
  DEFAULT_FEATURES,
  stripDisabledFeatures,
} from './feature-config.js';

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => `/tmp/test-groups/${folder}`,
}));

const TEST_DIR = '/tmp/test-groups/test-group';

describe('loadFeatureConfig', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync('/tmp/test-groups', { recursive: true, force: true });
  });

  it('returns defaults when no features.json exists', () => {
    const config = loadFeatureConfig('test-group');
    expect(config).toEqual(DEFAULT_FEATURES);
  });

  it('returns a copy, not a reference to defaults', () => {
    const a = loadFeatureConfig('test-group');
    const b = loadFeatureConfig('test-group');
    a.commands.purchase = true;
    expect(b.commands.purchase).toBe(false);
  });

  it('merges partial overrides with defaults', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'features.json'),
      JSON.stringify({
        commands: { subscribe: false },
        behaviors: { daily_digest: true },
      }),
    );

    const config = loadFeatureConfig('test-group');
    expect(config.commands.subscribe).toBe(false);
    expect(config.behaviors.daily_digest).toBe(true);
    expect(config.commands.purchase).toBe(false);
    expect(config.behaviors.crew_digest).toBe(false);
  });

  it('returns defaults on invalid JSON', () => {
    fs.writeFileSync(path.join(TEST_DIR, 'features.json'), 'not json');
    const config = loadFeatureConfig('test-group');
    expect(config).toEqual(DEFAULT_FEATURES);
  });
});

describe('stripDisabledFeatures', () => {
  const allEnabled: typeof DEFAULT_FEATURES = {
    commands: { purchase: true, subscribe: true, rota: true },
    behaviors: { daily_digest: true, crew_digest: true },
  };

  const template = [
    'Header',
    '<!-- feature:purchase -->',
    'Buy stuff here',
    '<!-- /feature:purchase -->',
    '<!-- feature:rota -->',
    'Shifts here',
    '<!-- /feature:rota -->',
    '<!-- feature:subscribe -->',
    'Subscribe info',
    '<!-- /feature:subscribe -->',
    'Footer',
  ].join('\n');

  it('keeps all sections when all features enabled', () => {
    const result = stripDisabledFeatures(template, allEnabled);
    expect(result).toContain('Buy stuff here');
    expect(result).toContain('Shifts here');
    expect(result).toContain('Subscribe info');
    expect(result).toContain('Footer');
  });

  it('strips purchase section when purchase disabled', () => {
    const features = {
      ...allEnabled,
      commands: { ...allEnabled.commands, purchase: false },
    };
    const result = stripDisabledFeatures(template, features);
    expect(result).not.toContain('Buy stuff here');
    expect(result).toContain('Shifts here');
    expect(result).toContain('Subscribe info');
  });

  it('strips multiple sections when multiple features disabled', () => {
    const features = {
      commands: { purchase: false, subscribe: false, rota: true },
      behaviors: { daily_digest: true, crew_digest: true },
    };
    const result = stripDisabledFeatures(template, features);
    expect(result).not.toContain('Buy stuff here');
    expect(result).not.toContain('Subscribe info');
    expect(result).toContain('Shifts here');
    expect(result).toContain('Header');
    expect(result).toContain('Footer');
  });

  it('returns template unchanged when no markers present', () => {
    const plain = 'No markers here';
    const result = stripDisabledFeatures(plain, DEFAULT_FEATURES);
    expect(result).toBe(plain);
  });
});
