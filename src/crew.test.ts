import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isCrewMember, loadCrewList } from './crew.js';

const TEST_GROUP = 'test-crew';
const TEST_DIR = path.join(process.cwd(), 'groups', TEST_GROUP);

describe('crew', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('returns empty list when no crew.json', () => {
    expect(loadCrewList(TEST_GROUP)).toEqual([]);
  });

  it('loads crew from array format', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'crew.json'),
      JSON.stringify([
        { id: 'tg:123', name: 'Jordan' },
        { id: 'tg:456', name: 'Alex' },
      ]),
    );
    const crew = loadCrewList(TEST_GROUP);
    expect(crew).toHaveLength(2);
    expect(crew[0].name).toBe('Jordan');
  });

  it('loads crew from {members} format', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'crew.json'),
      JSON.stringify({
        members: [{ id: 'tg:123', name: 'Jordan' }],
      }),
    );
    expect(loadCrewList(TEST_GROUP)).toHaveLength(1);
  });

  it('identifies crew members', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'crew.json'),
      JSON.stringify([{ id: 'tg:123', name: 'Jordan' }]),
    );
    expect(isCrewMember(TEST_GROUP, 'tg:123')).toBe(true);
    expect(isCrewMember(TEST_GROUP, 'tg:999')).toBe(false);
  });
});
