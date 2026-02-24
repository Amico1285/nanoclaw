/**
 * CLI Agent Runner for NanoClaw
 * Replaces container-runner.ts — spawns `claude -p` as a child process on the host.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  GROUPS_DIR,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || 'claude';
export const AGENT_TIMEOUT = parseInt(process.env.AGENT_TIMEOUT || '300000', 10);

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Prepare the per-group session directory structure.
 * Returns the session HOME directory for claude.
 */
function prepareSessionDir(group: RegisteredGroup): string {
  const sessionHome = path.join(DATA_DIR, 'sessions', group.folder);
  const claudeDir = path.join(sessionHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  // Write settings.json if it doesn't exist
  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Sync skills from skills/ (project root) into session dir's .claude/skills/
  // Skip agent-browser (replaced by Playwright MCP later)
  const skillsSrc = path.join(process.cwd(), 'skills');
  const skillsDst = path.join(claudeDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      if (skillDir === 'agent-browser') continue;
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  return sessionHome;
}

/**
 * Ensure per-group IPC directories exist.
 */
function prepareIpcDir(groupFolder: string): string {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  return groupIpcDir;
}

/**
 * Write the MCP config file that points claude to our nanoclaw MCP server.
 * Returns the path to the temporary config file.
 */
function writeMcpConfig(
  groupIpcDir: string,
  chatJid: string,
  groupFolder: string,
  isMain: boolean,
): string {
  const mcpServerPath = path.resolve(process.cwd(), 'dist', 'mcp-server.js');
  const configDir = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(configDir, { recursive: true });

  const configPath = path.join(
    configDir,
    `mcp-${groupFolder}-${Date.now()}.json`,
  );

  const config = {
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: chatJid,
          NANOCLAW_GROUP_FOLDER: groupFolder,
          NANOCLAW_IS_MAIN: isMain ? '1' : '0',
          NANOCLAW_IPC_DIR: groupIpcDir,
        },
      },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/**
 * Build the CLI arguments for `claude -p`.
 */
function buildCliArgs(
  group: RegisteredGroup,
  input: AgentInput,
  mcpConfigPath: string,
): string[] {
  const args: string[] = [
    '-p',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--mcp-config', mcpConfigPath,
  ];

  // Resume existing session
  if (input.sessionId) {
    args.push('--resume', input.sessionId);
  }

  // For non-main groups, append global CLAUDE.md as system prompt
  if (!input.isMain) {
    const globalClaudeMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
    if (fs.existsSync(globalClaudeMd)) {
      const content = fs.readFileSync(globalClaudeMd, 'utf-8');
      if (content.trim()) {
        args.push('--append-system-prompt', content);
      }
    }
  }

  // For main group, add project root as additional directory
  if (input.isMain) {
    args.push('--add-dir', process.cwd());
  }

  // Additional mounts from containerConfig become --add-dir arguments
  if (group.containerConfig?.additionalMounts) {
    for (const mount of group.containerConfig.additionalMounts) {
      const hostPath = mount.hostPath.replace(/^~/, process.env.HOME || '');
      if (fs.existsSync(hostPath)) {
        args.push('--add-dir', hostPath);
      }
    }
  }

  // Allow standard tools plus MCP tools
  args.push(
    '--allowedTools',
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task',
    'mcp__nanoclaw__send_message',
    'mcp__nanoclaw__schedule_task',
    'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__pause_task',
    'mcp__nanoclaw__resume_task',
    'mcp__nanoclaw__cancel_task',
    'mcp__nanoclaw__register_group',
  );

  return args;
}

/**
 * Parse the JSON output from `claude -p --output-format json`.
 * Claude outputs JSON with `session_id` and `result` fields.
 */
function parseClaudeOutput(raw: string): { sessionId?: string; result?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  // Try parsing the last JSON line (claude may output other lines before)
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      return {
        sessionId: parsed.session_id,
        result: parsed.result,
      };
    } catch {
      continue;
    }
  }

  // Try the whole output
  try {
    const parsed = JSON.parse(trimmed);
    return {
      sessionId: parsed.session_id,
      result: parsed.result,
    };
  } catch {
    return {};
  }
}

export async function runCliAgent(
  group: RegisteredGroup,
  input: AgentInput,
  onProcess: (proc: ChildProcess) => void,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<AgentOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const sessionHome = prepareSessionDir(group);
  const groupIpcDir = prepareIpcDir(input.groupFolder);
  const mcpConfigPath = writeMcpConfig(groupIpcDir, input.chatJid, input.groupFolder, input.isMain);

  const cliArgs = buildCliArgs(group, input, mcpConfigPath);

  logger.info(
    {
      group: group.name,
      isMain: input.isMain,
      hasSession: !!input.sessionId,
      argCount: cliArgs.length,
    },
    'Spawning CLI agent',
  );

  logger.debug(
    {
      group: group.name,
      cliArgs: cliArgs.join(' '),
      cwd: groupDir,
      sessionHome,
    },
    'CLI agent configuration',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_CLI_PATH, cliArgs, {
      cwd: groupDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: sessionHome,
        TZ: TIMEZONE,
      },
    });

    onProcess(proc);

    let stdout = '';
    let stderr = '';

    // Send prompt via stdin
    proc.stdin.write(input.prompt);
    proc.stdin.end();

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      // Log stderr lines for debugging
      for (const line of chunk.trim().split('\n')) {
        if (line) logger.debug({ agent: group.folder }, line);
      }
    });

    let timedOut = false;
    const configTimeout = group.containerConfig?.timeout || AGENT_TIMEOUT;

    const timeout = setTimeout(() => {
      timedOut = true;
      logger.error({ group: group.name }, 'CLI agent timeout, sending SIGTERM');
      proc.kill('SIGTERM');
      // Force kill after 10s if SIGTERM doesn't work
      setTimeout(() => {
        if (!proc.killed) {
          logger.warn({ group: group.name }, 'SIGTERM failed, sending SIGKILL');
          proc.kill('SIGKILL');
        }
      }, 10_000);
    }, configTimeout);

    proc.on('close', async (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Clean up temp MCP config
      try {
        fs.unlinkSync(mcpConfigPath);
      } catch {
        // ignore — file may already be cleaned up
      }

      // Write log file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== CLI Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Timed Out: ${timedOut}`,
        `Session ID: ${input.sessionId || 'new'}`,
        ``,
      ];

      if (isVerbose || code !== 0) {
        logLines.push(
          `=== CLI Args ===`,
          cliArgs.join(' '),
          ``,
          `=== Prompt ===`,
          input.prompt,
          ``,
          `=== Stderr ===`,
          stderr,
          ``,
          `=== Stdout ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile }, 'Agent log written');

      if (timedOut) {
        logger.error(
          { group: group.name, duration, code },
          'CLI agent timed out',
        );

        const output: AgentOutput = {
          status: 'error',
          result: null,
          error: `Agent timed out after ${configTimeout}ms`,
        };

        if (onOutput) await onOutput(output);
        resolve(output);
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, logFile },
          'CLI agent exited with error',
        );

        // If --resume failed (corrupted session), retry without it
        if (input.sessionId && stderr.includes('session')) {
          logger.warn(
            { group: group.name, sessionId: input.sessionId },
            'Session may be corrupted, retrying without --resume',
          );
          const retryInput = { ...input, sessionId: undefined };
          const retryResult = await runCliAgent(group, retryInput, onProcess, onOutput);
          resolve(retryResult);
          return;
        }

        const output: AgentOutput = {
          status: 'error',
          result: null,
          error: `Agent exited with code ${code}: ${stderr.slice(-200)}`,
        };

        if (onOutput) await onOutput(output);
        resolve(output);
        return;
      }

      // Parse JSON output
      const parsed = parseClaudeOutput(stdout);

      logger.info(
        {
          group: group.name,
          duration,
          hasResult: !!parsed.result,
          newSessionId: parsed.sessionId,
        },
        'CLI agent completed',
      );

      const output: AgentOutput = {
        status: 'success',
        result: parsed.result || null,
        newSessionId: parsed.sessionId,
      };

      if (onOutput) await onOutput(output);
      resolve(output);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);

      // Clean up temp MCP config
      try {
        fs.unlinkSync(mcpConfigPath);
      } catch {
        // ignore
      }

      logger.error({ group: group.name, error: err }, 'CLI agent spawn error');

      const output: AgentOutput = {
        status: 'error',
        result: null,
        error: `Agent spawn error: ${err.message}`,
      };

      resolve(output);
    });
  });
}

/**
 * Write tasks snapshot for the agent to read (filtered by group).
 * Transferred as-is from container-runner.ts.
 */
export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

/**
 * Write available groups snapshot for the agent to read.
 * Only main group can see all available groups (for activation).
 * Transferred as-is from container-runner.ts.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * Verify that the Claude CLI is available and working.
 * Throws if the CLI is not found or returns an error.
 */
export function ensureClaudeCliAvailable(): void {
  try {
    const version = execSync(`${CLAUDE_CLI_PATH} --version`, {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    logger.info({ version, path: CLAUDE_CLI_PATH }, 'Claude CLI available');
  } catch (err) {
    throw new Error(
      `Claude CLI not found at "${CLAUDE_CLI_PATH}". ` +
      `Install it or set CLAUDE_CLI_PATH. Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
