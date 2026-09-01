import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';

export interface FeatureConfig {
  commands: {
    today: boolean;
    hello: boolean;
    connect: boolean;
    forget: boolean;
    subscribe: boolean;
  };
  behaviors: {
    daily_digest: boolean;
    crew_digest: boolean;
    escalation: boolean;
    memory_extraction: boolean;
    welcome_dm: boolean;
    pattern_sensing: boolean;
    epistemic_markers: boolean;
    operational_history: boolean;
    first_person_authority: boolean;
  };
}

export const DEFAULT_FEATURES: FeatureConfig = {
  commands: {
    today: true,
    hello: true,
    connect: true,
    forget: true,
    subscribe: false,
  },
  behaviors: {
    daily_digest: false,
    crew_digest: false,
    escalation: false,
    memory_extraction: true,
    welcome_dm: true,
    pattern_sensing: true,
    epistemic_markers: true,
    operational_history: true,
    first_person_authority: true,
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
