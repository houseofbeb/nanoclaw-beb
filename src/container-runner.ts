/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env with an empty file so agents cannot read API keys.
    // This mount is applied after the project root, so Docker overlays it.
    const emptyEnvFile = path.join(projectRoot, 'store', '.env.empty');
    fs.mkdirSync(path.dirname(emptyEnvFile), { recursive: true });
    if (!fs.existsSync(emptyEnvFile)) fs.writeFileSync(emptyEnvFile, '');
    mounts.push({
      hostPath: emptyEnvFile,
      containerPath: '/workspace/project/.env',
      readonly: true,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const settingsContent = {
    env: {
      // Enable agent swarms (subagent orchestration)
      // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      // Load CLAUDE.md from additional mounted directories
      // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      // Enable Claude's memory feature (persists user preferences between sessions)
      // https://code.claude.com/docs/en/memory#manage-auto-memory
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    },
    mcpServers: {
      ...(fs.existsSync(
        path.join(
          process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
          'google-calendar-mcp',
          'tokens.json',
        ),
      )
        ? {
            'google-calendar': {
              command: 'npx',
              args: ['google-calendar-mcp'],
            },
          }
        : {}),
    },
  };
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(settingsContent, null, 2) + '\n',
  );

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Gmail MCP credentials (read-write so the MCP server can refresh OAuth tokens)
  const gmailDir = path.join(os.homedir(), '.gmail-mcp');
  if (fs.existsSync(gmailDir)) {
    mounts.push({
      hostPath: gmailDir,
      containerPath: '/home/node/.gmail-mcp',
      readonly: false,
    });
  }

  // Google Calendar MCP tokens (read-write for token refresh)
  const calendarConfigDir = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'google-calendar-mcp',
  );
  if (fs.existsSync(calendarConfigDir)) {
    mounts.push({
      hostPath: calendarConfigDir,
      containerPath: '/home/node/.config/google-calendar-mcp',
      readonly: false,
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Write credentials into the container's .claude/ dir so Agent SDK bridge
 * subprocesses (which clear CLAUDE_CODE_OAUTH_TOKEN from their env) can
 * still authenticate by reading ~/.claude/.credentials.json.
 *
 * Priority: CLAUDE_CODE_OAUTH_TOKEN from .env (setup-token) → host credentials.json
 */
function syncCredentialsToContainer(groupSessionsDir: string, token?: string): void {
  const dstCredsFile = path.join(groupSessionsDir, '.credentials.json');

  if (token) {
    // Write a synthetic credentials file from the long-lived setup-token.
    // expiresAt is set far in the future; Claude Code will use the token as-is.
    const creds = {
      claudeAiOauth: {
        accessToken: token,
        refreshToken: '',
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      },
    };
    fs.writeFileSync(dstCredsFile, JSON.stringify(creds, null, 2));
    return;
  }

  // Fallback: copy host credentials.json (used when no .env token is set)
  const srcCredsFile = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const raw = fs.readFileSync(srcCredsFile, 'utf-8');
    const creds = JSON.parse(raw);
    if (!creds?.claudeAiOauth?.accessToken) return;
    fs.writeFileSync(dstCredsFile, raw);
  } catch {
    // No host credentials file — container falls back to ANTHROPIC_API_KEY
  }
}

const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers';
const REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const REFRESH_AHEAD_MS = 10 * 60 * 1000; // refresh when <10 min remain
const FORCE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // proactive refresh every 6 hours

async function refreshOAuthToken(credsFile: string, force = false): Promise<void> {
  const raw = fs.readFileSync(credsFile, 'utf-8');
  const creds = JSON.parse(raw);
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.refreshToken || !oauth?.expiresAt) return;

  // Only refresh if expiring soon (unless forced)
  if (!force && oauth.expiresAt - Date.now() > REFRESH_AHEAD_MS) return;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPES,
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    logger.error({ status: res.status }, 'OAuth token refresh failed');
    return;
  }

  const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
  creds.claudeAiOauth.accessToken = data.access_token;
  if (data.refresh_token) creds.claudeAiOauth.refreshToken = data.refresh_token;
  creds.claudeAiOauth.expiresAt = Date.now() + data.expires_in * 1000;
  fs.writeFileSync(credsFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
  logger.info({ force }, 'OAuth token refreshed successfully');
}

const GOOGLE_CALENDAR_TOKEN_REFRESH_INTERVAL_MS = 45 * 60 * 1000; // refresh every 45 minutes

async function refreshGoogleCalendarToken(): Promise<void> {
  const configDir = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'google-calendar-mcp',
  );
  const keysFile = path.join(configDir, 'gcp-oauth.keys.json');
  const tokensFile = path.join(configDir, 'tokens.json');

  if (!fs.existsSync(keysFile) || !fs.existsSync(tokensFile)) return;

  const keys = JSON.parse(fs.readFileSync(keysFile, 'utf-8'));
  const tokens = JSON.parse(fs.readFileSync(tokensFile, 'utf-8'));

  // tokens.json has a top-level key per account (e.g. "normal")
  for (const account of Object.keys(tokens)) {
    const t = tokens[account];
    if (!t?.refresh_token) continue;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: keys.client_id,
      client_secret: keys.client_secret,
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      logger.error({ account, status: res.status }, 'Google Calendar token refresh failed');
      continue;
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    tokens[account].access_token = data.access_token;
    tokens[account].expiry_date = Date.now() + data.expires_in * 1000;
    logger.info({ account }, 'Google Calendar token refreshed');
  }

  fs.writeFileSync(tokensFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export function startGoogleCalendarTokenRefreshLoop(): void {
  const configDir = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'google-calendar-mcp',
  );
  if (!fs.existsSync(path.join(configDir, 'tokens.json'))) return;

  const run = () =>
    refreshGoogleCalendarToken().catch(err =>
      logger.error({ err }, 'Google Calendar token refresh error'),
    );

  run();
  setInterval(run, GOOGLE_CALENDAR_TOKEN_REFRESH_INTERVAL_MS);
}

export function startTokenRefreshLoop(): void {
  // Only run when using host credentials (not a setup-token from .env)
  const envSecrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']);
  if (envSecrets['CLAUDE_CODE_OAUTH_TOKEN']) return;

  const credsFile = path.join(os.homedir(), '.claude', '.credentials.json');
  if (!fs.existsSync(credsFile)) return;

  const run = () =>
    refreshOAuthToken(credsFile).catch(err => logger.error({ err }, 'OAuth token refresh error'));

  const forceRun = () =>
    refreshOAuthToken(credsFile, true).catch(err => logger.error({ err }, 'OAuth token scheduled refresh error'));

  // Check immediately at startup, then on interval
  run();
  setInterval(run, REFRESH_CHECK_INTERVAL_MS);

  // Proactively refresh every 6 hours regardless of expiry
  setInterval(forceRun, FORCE_REFRESH_INTERVAL_MS);
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 *
 * CLAUDE_CODE_OAUTH_TOKEN is read from credentials.json so the first-turn
 * Claude Code subprocess gets it as an env var. Bridge subprocesses (which
 * clear this var) fall back to the credentials file written by
 * syncCredentialsToContainer. Claude Code inside the container refreshes
 * the token itself if needed — NanoClaw never calls the refresh endpoint.
 */
function readSecrets(): Record<string, string> {
  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GOOGLE_OAUTH_CREDENTIALS_JSON', 'HA_URL', 'HA_TOKEN']);

  if (!secrets['CLAUDE_CODE_OAUTH_TOKEN']) {
    const credsFile = path.join(os.homedir(), '.claude', '.credentials.json');
    try {
      const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
      const token = creds?.claudeAiOauth?.accessToken;
      if (token) {
        secrets['CLAUDE_CODE_OAUTH_TOKEN'] = token;
        delete secrets['ANTHROPIC_API_KEY'];
      }
    } catch {
      // No credentials file — fall back to .env values
    }
  }

  return secrets;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Allow containers to reach the host (e.g. Home Assistant on --network host)
  // via the host.docker.internal hostname, which resolves to the bridge gateway.
  args.push('--add-host=host.docker.internal:host-gateway');

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Sync refreshed credentials into the container's .claude/ dir so that
  // Agent SDK bridge subprocesses (which clear CLAUDE_CODE_OAUTH_TOKEN) can
  // authenticate by reading ~/.claude/.credentials.json normally.
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  const secrets = readSecrets();
  syncCredentialsToContainer(groupSessionsDir, secrets['CLAUDE_CODE_OAUTH_TOKEN']);

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    // CLAUDE_CODE_OAUTH_TOKEN is only used as a last-resort fallback here;
    // credentials are primarily delivered via the .credentials.json file
    // written by syncCredentialsToContainer above.
    input.secrets = secrets;
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

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
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
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
