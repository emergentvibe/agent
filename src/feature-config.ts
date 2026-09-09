import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';

export interface FeatureConfig {
  commands: {
    purchase: boolean;
    subscribe: boolean;
    rota: boolean;
  };
  behaviors: {
    daily_digest: boolean;
    crew_digest: boolean;
  };
}

export const DEFAULT_FEATURES: FeatureConfig = {
  commands: {
    purchase: false,
    subscribe: true,
    rota: false,
  },
  behaviors: {
    daily_digest: false,
    crew_digest: false,
  },
};

export function stripDisabledFeatures(
  template: string,
  features: FeatureConfig,
): string {
  const disabled = new Set<string>();
  for (const [key, enabled] of Object.entries(features.commands)) {
    if (!enabled) disabled.add(key);
  }
  for (const [key, enabled] of Object.entries(features.behaviors)) {
    if (!enabled) disabled.add(key);
  }

  let result = template;
  for (const flag of disabled) {
    const pattern = new RegExp(
      `<!-- feature:${flag} -->[\\s\\S]*?<!-- /feature:${flag} -->\\n?`,
      'g',
    );
    result = result.replace(pattern, '');
  }
  return result;
}

export function loadFeatureConfig(groupFolder: string): FeatureConfig {
  const configPath = path.join(
    resolveGroupFolderPath(groupFolder),
    'features.json',
  );

  if (!fs.existsSync(configPath)) {
    return structuredClone(DEFAULT_FEATURES);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      commands: { ...DEFAULT_FEATURES.commands, ...raw.commands },
      behaviors: { ...DEFAULT_FEATURES.behaviors, ...raw.behaviors },
    };
  } catch {
    return structuredClone(DEFAULT_FEATURES);
  }
}
