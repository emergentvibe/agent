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
