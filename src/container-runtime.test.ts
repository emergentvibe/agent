import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  buildMem0SseUrl,
  readonlyMountArgs,
  rewriteUrlForContainer,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('returns stop command using CONTAINER_RUNTIME_BIN', () => {
    expect(stopContainer('nanoclaw-test-123')).toBe(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`,
    );
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group1-111`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group2-222`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});

// --- rewriteUrlForContainer ---

describe('rewriteUrlForContainer', () => {
  it('rewrites localhost to host gateway', () => {
    expect(rewriteUrlForContainer('http://localhost:8765/sse')).toBe(
      `http://${CONTAINER_HOST_GATEWAY}:8765/sse`,
    );
  });

  it('rewrites 127.0.0.1 to host gateway', () => {
    expect(rewriteUrlForContainer('http://127.0.0.1:8765/sse')).toBe(
      `http://${CONTAINER_HOST_GATEWAY}:8765/sse`,
    );
  });

  it('leaves non-localhost URLs unchanged', () => {
    expect(rewriteUrlForContainer('http://mem0.example.com:8765/sse')).toBe(
      'http://mem0.example.com:8765/sse',
    );
  });

  it('leaves host.docker.internal unchanged', () => {
    const url = `http://${CONTAINER_HOST_GATEWAY}:8765/sse`;
    expect(rewriteUrlForContainer(url)).toBe(url);
  });

  it('does not rewrite localhost in path segments', () => {
    // \blocalhost\b should only match the word "localhost", not as a substring
    expect(
      rewriteUrlForContainer('http://myhost:8765/path?host=localhost'),
    ).toBe(`http://myhost:8765/path?host=${CONTAINER_HOST_GATEWAY}`);
  });
});

// --- buildMem0SseUrl ---

describe('buildMem0SseUrl', () => {
  it('constructs OpenMemory MCP SSE URL with encoded user_id', () => {
    const url = buildMem0SseUrl('http://localhost:8765/sse', 'treeweek');
    expect(url).toBe(
      'http://localhost:8765/mcp/nanoclaw/sse/community%3Atreeweek',
    );
  });

  it('strips path from base URL', () => {
    const url = buildMem0SseUrl(
      'http://localhost:8765/some/extra/path',
      'mygroup',
    );
    expect(url).toBe(
      'http://localhost:8765/mcp/nanoclaw/sse/community%3Amygroup',
    );
  });

  it('preserves port and protocol', () => {
    const url = buildMem0SseUrl('https://mem0.example.com:9999', 'treeweek');
    expect(url).toBe(
      'https://mem0.example.com:9999/mcp/nanoclaw/sse/community%3Atreeweek',
    );
  });

  it('handles group folders with special characters', () => {
    const url = buildMem0SseUrl('http://localhost:8765', 'my group/test');
    expect(url).toBe(
      'http://localhost:8765/mcp/nanoclaw/sse/community%3Amy%20group%2Ftest',
    );
  });
});
