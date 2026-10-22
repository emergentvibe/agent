import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  validateMount,
  validateAdditionalMounts,
  loadMountAllowlist,
} from './mount-security.js';

const FAKE_ALLOWLIST_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);

function resetAllowlistCache() {
  // The module caches the allowlist; we need to reset it between tests.
  // validateMount calls loadMountAllowlist which reads cachedAllowlist.
  // We re-import the module to reset the cache.
}

describe('mount-security', () => {
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;
  let readFileSyncSpy: ReturnType<typeof vi.spyOn>;
  let realpathSyncSpy: ReturnType<typeof vi.spyOn>;

  function setAllowlist(allowlist: object) {
    existsSyncSpy.mockImplementation((p: fs.PathLike) => {
      if (String(p) === FAKE_ALLOWLIST_PATH) return true;
      // For host paths in the test, return true
      return true;
    });
    readFileSyncSpy.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (String(p) === FAKE_ALLOWLIST_PATH) return JSON.stringify(allowlist);
      throw new Error(`Unexpected read: ${p}`);
    });
    realpathSyncSpy.mockImplementation((p: fs.PathLike) => String(p));
  }

  beforeEach(async () => {
    // Reset module cache so allowlist reloads
    vi.resetModules();
    existsSyncSpy = vi.spyOn(fs, 'existsSync');
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
    realpathSyncSpy = vi.spyOn(fs, 'realpathSync');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('blocked patterns', () => {
    it('rejects .ssh paths', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/home/user', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount({ hostPath: '/home/user/.ssh/keys' }, true);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/blocked pattern.*\.ssh/);
    });

    it('rejects .env paths', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/home/user/project', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: '/home/user/project/.env' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/blocked pattern.*\.env/);
    });

    it('rejects .aws credentials', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/home/user', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: '/home/user/.aws/credentials' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/blocked pattern/);
    });

    it('rejects custom blocked patterns from allowlist', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/data', allowReadWrite: true }],
        blockedPatterns: ['my_secret_dir'],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: '/data/my_secret_dir/file.txt' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/blocked pattern.*my_secret_dir/);
    });
  });

  describe('path traversal', () => {
    it('rejects container path with ..', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        {
          hostPath: '/home/user/projects/safe',
          containerPath: '../../etc/passwd',
        },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Invalid container path/);
    });

    it('rejects absolute container path', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: '/home/user/projects/safe', containerPath: '/etc/passwd' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Invalid container path/);
    });

    it('falls back to basename when container path is empty', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: '/home/user/projects/safe', containerPath: '' },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.resolvedContainerPath).toBe('safe');
    });

    it('rejects whitespace-only container path', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: '/home/user/projects/safe', containerPath: '   ' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Invalid container path/);
    });
  });

  describe('allowlist happy path', () => {
    it('allows mount under an allowed root', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [
          {
            path: '/home/user/projects',
            allowReadWrite: true,
            description: 'dev',
          },
        ],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: '/home/user/projects/myrepo', readonly: false },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(false);
      expect(result.reason).toMatch(/Allowed under root/);
    });

    it('defaults container path to basename of host path', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: '/home/user/projects/myrepo' },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.resolvedContainerPath).toBe('myrepo');
    });
  });

  describe('missing allowlist', () => {
    it('blocks all mounts when allowlist file missing', async () => {
      const { validateMount } = await import('./mount-security.js');
      existsSyncSpy.mockReturnValue(false);
      const result = validateMount(
        { hostPath: '/home/user/projects/safe' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/No mount allowlist/);
    });
  });

  describe('path not under allowed root', () => {
    it('rejects paths outside all allowed roots', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount({ hostPath: '/var/secrets/data' }, true);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/not under any allowed root/);
    });
  });

  describe('readonly enforcement', () => {
    it('forces read-only for non-main groups when nonMainReadOnly is true', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: true,
      });
      const result = validateMount(
        { hostPath: '/home/user/projects/repo', readonly: false },
        false, // non-main
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });

    it('allows read-write for main group even when nonMainReadOnly is true', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: true,
      });
      const result = validateMount(
        { hostPath: '/home/user/projects/repo', readonly: false },
        true, // main
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(false);
    });

    it('forces read-only when root does not allow read-write', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/home/user/docs', allowReadWrite: false }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: '/home/user/docs/readme.md', readonly: false },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });

    it('defaults to read-only when readonly not specified', async () => {
      const { validateMount } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const result = validateMount(
        { hostPath: '/home/user/projects/repo' },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });
  });

  describe('validateAdditionalMounts batch', () => {
    it('filters out rejected mounts and returns only valid ones', async () => {
      const { validateAdditionalMounts } = await import('./mount-security.js');
      setAllowlist({
        allowedRoots: [{ path: '/home/user/projects', allowReadWrite: true }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      });
      const results = validateAdditionalMounts(
        [
          { hostPath: '/home/user/projects/good', readonly: false },
          { hostPath: '/var/bad/path' },
          { hostPath: '/home/user/projects/.ssh/key' },
        ],
        'test-group',
        true,
      );
      expect(results).toHaveLength(1);
      expect(results[0].hostPath).toBe('/home/user/projects/good');
      expect(results[0].containerPath).toBe('/workspace/extra/good');
      expect(results[0].readonly).toBe(false);
    });
  });

  describe('host path does not exist', () => {
    it('rejects when host path cannot be resolved', async () => {
      const { validateMount } = await import('./mount-security.js');
      existsSyncSpy.mockImplementation((p: fs.PathLike) => {
        if (String(p) === FAKE_ALLOWLIST_PATH) return true;
        return true;
      });
      readFileSyncSpy.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === FAKE_ALLOWLIST_PATH) {
          return JSON.stringify({
            allowedRoots: [
              { path: '/home/user/projects', allowReadWrite: true },
            ],
            blockedPatterns: [],
            nonMainReadOnly: false,
          });
        }
        throw new Error(`Unexpected read: ${p}`);
      });
      realpathSyncSpy.mockImplementation((p: fs.PathLike) => {
        if (String(p) === '/home/user/projects/nonexistent')
          throw new Error('ENOENT');
        return String(p);
      });

      const result = validateMount(
        { hostPath: '/home/user/projects/nonexistent' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/does not exist/);
    });
  });
});
