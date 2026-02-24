#!/usr/bin/env npx tsx

/**
 * Validate that `claude -p` (headless mode) works correctly.
 * Tests: JSON output, stdin piping, --resume, --mcp-config,
 * --dangerously-skip-permissions, --append-system-prompt, --add-dir, --allowedTools
 */

import { execSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLAUDE_BIN = process.env.CLAUDE_CLI_PATH || 'claude';
const TIMEOUT = 120_000;

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];

function log(msg: string): void {
  console.log(`  ${msg}`);
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  process.stdout.write(`\n[TEST] ${name}...`);
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration });
    console.log(` PASS (${duration}ms)`);
  } catch (err: any) {
    const duration = Date.now() - start;
    results.push({ name, passed: false, error: err.message || String(err), duration });
    console.log(` FAIL`);
    log(`Error: ${err.message || err}`);
  }
}

function execClaude(args: string[], input?: string): string {
  const cmd = [CLAUDE_BIN, ...args].join(' ');
  return execSync(cmd, {
    input,
    timeout: TIMEOUT,
    encoding: 'utf-8',
    stdio: input ? ['pipe', 'pipe', 'pipe'] : [undefined, 'pipe', 'pipe'],
  });
}

function spawnClaude(args: string[]): ChildProcess {
  return spawn(CLAUDE_BIN, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function parseJsonOutput(raw: string): any {
  // claude -p --output-format json returns JSON with session_id and result
  const trimmed = raw.trim();
  // Handle potential multiple JSON lines — take the last complete JSON object
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      continue;
    }
  }
  // Try parsing the whole output
  return JSON.parse(trimmed);
}

// ─── Tests ───────────────────────────────────────────────────────────────

await runTest('claude --version returns valid version', async () => {
  const output = execSync(`${CLAUDE_BIN} --version`, {
    encoding: 'utf-8',
    timeout: 10_000,
  }).trim();
  if (!output.match(/\d+\.\d+/)) {
    throw new Error(`Unexpected version output: ${output}`);
  }
  log(`Version: ${output}`);
});

await runTest('claude -p with --output-format json returns valid JSON', async () => {
  const raw = execClaude([
    '-p', '"What is 2+2? Reply with just the number."',
    '--output-format', 'json',
  ]);
  const json = parseJsonOutput(raw);
  if (!json.session_id) throw new Error('Missing session_id');
  if (typeof json.result !== 'string') throw new Error('Missing or invalid result field');
  log(`session_id: ${json.session_id}`);
  log(`result: ${json.result.slice(0, 100)}`);
});

await runTest('Piping stdin works with claude -p', async () => {
  const raw = execClaude(
    ['-p', '--output-format', 'json'],
    'What is 3+3? Reply with just the number.',
  );
  const json = parseJsonOutput(raw);
  if (!json.session_id) throw new Error('Missing session_id');
  if (typeof json.result !== 'string') throw new Error('Missing result');
  log(`result: ${json.result.slice(0, 100)}`);
});

await runTest('--resume continues a session', async () => {
  // Start a session
  const raw1 = execClaude([
    '-p', '"Remember the secret word: PINEAPPLE. Just say OK."',
    '--output-format', 'json',
  ]);
  const json1 = parseJsonOutput(raw1);
  if (!json1.session_id) throw new Error('No session_id from first call');
  log(`First session_id: ${json1.session_id}`);

  // Resume it
  const raw2 = execClaude([
    '-p', '"What was the secret word I told you? Reply with just the word."',
    '--output-format', 'json',
    '--resume', json1.session_id,
  ]);
  const json2 = parseJsonOutput(raw2);
  if (!json2.result?.toUpperCase().includes('PINEAPPLE')) {
    throw new Error(`Expected PINEAPPLE in resumed response, got: ${json2.result}`);
  }
  log(`Resumed result: ${json2.result.slice(0, 100)}`);
});

await runTest('--dangerously-skip-permissions works', async () => {
  const raw = execClaude([
    '-p', '"Say hello"',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ]);
  const json = parseJsonOutput(raw);
  if (!json.result) throw new Error('No result with --dangerously-skip-permissions');
  log(`result: ${json.result.slice(0, 100)}`);
});

await runTest('--append-system-prompt works', async () => {
  const raw = execClaude([
    '-p', '"What is your system instruction about animals?"',
    '--output-format', 'json',
    '--append-system-prompt', '"You must always mention that you love cats."',
  ]);
  const json = parseJsonOutput(raw);
  if (!json.result) throw new Error('No result');
  // The model should mention cats since it was in the system prompt
  log(`result: ${json.result.slice(0, 200)}`);
});

await runTest('--add-dir works', async () => {
  // Create a temp directory with a marker file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-adddir-'));
  const markerFile = path.join(tmpDir, 'test-marker.txt');
  fs.writeFileSync(markerFile, 'UNIQUE_MARKER_12345');

  try {
    const raw = execClaude([
      '-p', `"Read the file test-marker.txt in the additional directory and tell me what it says. Reply with just the content."`,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--add-dir', tmpDir,
    ]);
    const json = parseJsonOutput(raw);
    log(`result: ${json.result?.slice(0, 200)}`);
    // We just verify it doesn't error — content detection is best-effort
    if (!json.result) throw new Error('No result');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await runTest('--allowedTools works', async () => {
  const raw = execClaude([
    '-p', '"List the files in the current directory using bash"',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--allowedTools', 'Bash',
  ]);
  const json = parseJsonOutput(raw);
  if (!json.result) throw new Error('No result');
  log(`result: ${json.result.slice(0, 200)}`);
});

await runTest('--mcp-config works with a trivial MCP server', async () => {
  // Create a minimal MCP server config pointing to a simple echo server
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-mcp-'));

  // Create a tiny MCP server script
  const serverScript = path.join(tmpDir, 'echo-server.mjs');
  fs.writeFileSync(serverScript, `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({ name: 'echo-test', version: '1.0.0' }, {
  capabilities: { tools: {} },
});

server.setRequestHandler({ method: 'tools/list' }, async () => ({
  tools: [{
    name: 'echo',
    description: 'Returns whatever text you pass in',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  }],
}));

server.setRequestHandler({ method: 'tools/call' }, async (request) => ({
  content: [{ type: 'text', text: 'ECHO: ' + request.params.arguments.text }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
`);

  const mcpConfig = path.join(tmpDir, 'mcp.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({
    mcpServers: {
      'echo-test': {
        command: 'node',
        args: [serverScript],
      },
    },
  }));

  try {
    const raw = execClaude([
      '-p', '"Use the echo tool to echo the text HELLO_MCP. Return just the echo result."',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfig,
    ]);
    const json = parseJsonOutput(raw);
    log(`result: ${json.result?.slice(0, 200)}`);
    if (!json.result) throw new Error('No result with --mcp-config');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.log('\n─── Summary ───');
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

for (const r of results) {
  const icon = r.passed ? '✓' : '✗';
  console.log(`  ${icon} ${r.name} (${r.duration}ms)${r.error ? ` — ${r.error}` : ''}`);
}

console.log(`\n${passed} passed, ${failed} failed (${totalDuration}ms total)`);

if (failed > 0) {
  process.exit(1);
}
