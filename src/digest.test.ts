import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ensureCrewDigestTask, ensureDigestTask } from './digest.js';
import type { RegisteredGroup } from './types.js';

vi.mock('./db.js', () => ({
  getTasksForGroup: vi.fn(() => []),
  createTask: vi.fn(),
}));

vi.mock('./feature-config.js', () => ({
  loadFeatureConfig: vi.fn(() => ({
    commands: { today: true, hello: true, connect: true, forget: true, subscribe: false },
    behaviors: {
      daily_digest: true,
      crew_digest: false,
      escalation: false,
      memory_extraction: true,
      welcome_dm: true,
      pattern_sensing: true,
      epistemic_markers: true,
      operational_history: true,
      first_person_authority: true,
    },
  })),
}));

const { createTask, getTasksForGroup } = await import('./db.js');
const { loadFeatureConfig } = await import('./feature-config.js');

const TEST_GROUP: RegisteredGroup = {
  name: 'Test Community',
  folder: 'test-digest',
  trigger: 'Andy',
  added_at: new Date().toISOString(),
  isMain: true,
};

describe('ensureDigestTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const groupDir = path.join(process.cwd(), 'groups', TEST_GROUP.folder);
    fs.mkdirSync(groupDir, { recursive: true });
  });

  afterEach(() => {
    const groupDir = path.join(process.cwd(), 'groups', TEST_GROUP.folder);
    if (fs.existsSync(groupDir)) fs.rmSync(groupDir, { recursive: true });
  });

  it('creates a digest task when daily_digest is enabled', () => {
    ensureDigestTask(TEST_GROUP, 'tg:group1');
    expect(createTask).toHaveBeenCalledTimes(1);
    const call = (createTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.id).toBe('daily-digest-test-digest');
    expect(call.schedule_type).toBe('cron');
    expect(call.schedule_value).toBe('0 8 * * *');
  });

  it('skips when daily_digest is disabled', () => {
    (loadFeatureConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      commands: {},
      behaviors: { daily_digest: false },
    });
    ensureDigestTask(TEST_GROUP, 'tg:group1');
    expect(createTask).not.toHaveBeenCalled();
  });

  it('skips when task already exists', () => {
    (getTasksForGroup as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { id: 'daily-digest-test-digest', status: 'active' },
    ]);
    ensureDigestTask(TEST_GROUP, 'tg:group1');
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('ensureCrewDigestTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const groupDir = path.join(process.cwd(), 'groups', TEST_GROUP.folder);
    fs.mkdirSync(groupDir, { recursive: true });
  });

  afterEach(() => {
    const groupDir = path.join(process.cwd(), 'groups', TEST_GROUP.folder);
    if (fs.existsSync(groupDir)) fs.rmSync(groupDir, { recursive: true });
  });

  it('creates a crew digest task when crew_digest is enabled', () => {
    (loadFeatureConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      commands: {},
      behaviors: { crew_digest: true },
    });
    ensureCrewDigestTask(TEST_GROUP, 'tg:dm-crew1', 'tg:crew1');
    expect(createTask).toHaveBeenCalledTimes(1);
    const call = (createTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.id).toBe('crew-digest-test-digest-tg:crew1');
    expect(call.chat_jid).toBe('tg:dm-crew1');
    expect(call.schedule_type).toBe('cron');
    expect(call.schedule_value).toBe('0 23 * * *');
    expect(call.context_mode).toBe('group');
  });

  it('skips when crew_digest is disabled', () => {
    ensureCrewDigestTask(TEST_GROUP, 'tg:dm-crew1', 'tg:crew1');
    expect(createTask).not.toHaveBeenCalled();
  });

  it('skips when task already exists', () => {
    (loadFeatureConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      commands: {},
      behaviors: { crew_digest: true },
    });
    (getTasksForGroup as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { id: 'crew-digest-test-digest-tg:crew1', status: 'active' },
    ]);
    ensureCrewDigestTask(TEST_GROUP, 'tg:dm-crew1', 'tg:crew1');
    expect(createTask).not.toHaveBeenCalled();
  });
});
