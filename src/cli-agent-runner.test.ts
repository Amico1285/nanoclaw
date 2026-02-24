import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => `/tmp/nanoclaw-test-groups/${folder}`,
  resolveGroupIpcPath: (folder: string) => `/tmp/nanoclaw-test-data/ipc/${folder}`,
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      unlinkSync: vi.fn(),
      cpSync: vi.fn(),
    },
  };
});

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    killed: boolean;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  proc.killed = false;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    execSync: vi.fn(() => '1.0.0'),
  };
});

import { runCliAgent, AgentOutput } from './cli-agent-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello, what is 2+2?',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

describe('cli-agent-runner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('successful run parses JSON output and extracts session ID', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runCliAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Simulate claude outputting JSON
    const jsonOutput = JSON.stringify({
      session_id: 'sess-abc-123',
      result: 'The answer is 4.',
    });
    fakeProc.stdout.push(jsonOutput + '\n');
    fakeProc.stdout.push(null); // EOF

    // Emit normal exit
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.result).toBe('The answer is 4.');
    expect(result.newSessionId).toBe('sess-abc-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        result: 'The answer is 4.',
        newSessionId: 'sess-abc-123',
      }),
    );
  });

  it('non-zero exit code returns error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runCliAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit some stderr
    fakeProc.stderr.push('Something went wrong\n');

    // Emit error exit
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Agent exited with code 1');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('timeout kills process and returns error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runCliAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Let timeout fire (default AGENT_TIMEOUT = 300000ms)
    await vi.advanceTimersByTimeAsync(300000);

    // Process was killed, emit close with signal code
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('calls onProcess callback with the spawned process', async () => {
    const onProcess = vi.fn();
    const resultPromise = runCliAgent(
      testGroup,
      testInput,
      onProcess,
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;
    expect(onProcess).toHaveBeenCalledWith(fakeProc);
  });

  it('sends prompt via stdin', async () => {
    const chunks: string[] = [];
    fakeProc.stdin.on('data', (data) => chunks.push(data.toString()));

    const resultPromise = runCliAgent(
      testGroup,
      testInput,
      () => {},
    );

    // Let stdin writes settle
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;
    expect(chunks.join('')).toBe('Hello, what is 2+2?');
  });

  it('handles spawn error gracefully', async () => {
    const resultPromise = runCliAgent(
      testGroup,
      testInput,
      () => {},
    );

    // Emit spawn error
    fakeProc.emit('error', new Error('ENOENT: claude not found'));
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Agent spawn error');
    expect(result.error).toContain('claude not found');
  });

  it('parses JSON with extra output lines before it', async () => {
    const resultPromise = runCliAgent(
      testGroup,
      testInput,
      () => {},
    );

    // Claude sometimes outputs non-JSON before the final JSON
    fakeProc.stdout.push('Loading configuration...\n');
    fakeProc.stdout.push('Connecting to server...\n');
    fakeProc.stdout.push(JSON.stringify({
      session_id: 'sess-xyz',
      result: 'Done!',
    }) + '\n');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.result).toBe('Done!');
    expect(result.newSessionId).toBe('sess-xyz');
  });

  it('returns null result when claude outputs empty', async () => {
    const resultPromise = runCliAgent(
      testGroup,
      testInput,
      () => {},
    );

    // Empty output
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.result).toBeNull();
  });

  it('passes --resume when sessionId is provided', async () => {
    const { spawn } = await import('child_process');
    const mockSpawn = vi.mocked(spawn);
    mockSpawn.mockClear();

    const inputWithSession = {
      ...testInput,
      sessionId: 'existing-session-id',
    };

    const resultPromise = runCliAgent(
      testGroup,
      inputWithSession,
      () => {},
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    // Check that spawn was called with args containing --resume
    const callArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(callArgs).toContain('--resume');
    expect(callArgs).toContain('existing-session-id');
  });
});
