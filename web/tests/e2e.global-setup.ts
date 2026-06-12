import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullConfig } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const E2E_PORT = 5051;

async function waitForServer(
  port: number,
  stderrLogPath?: string,
  timeoutMs = 120_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (stderrLogPath && fs.existsSync(stderrLogPath)) {
      const stderr = fs.readFileSync(stderrLogPath, 'utf-8');
      if (stderr.includes('[ERROR]')) {
        throw new Error(readLogTail(stderrLogPath));
      }
    }

    try {
      await new Promise<void>((resolve, reject) => {
        http
          .get(`http://localhost:${port}/api/version`, (res) => {
            res.resume();
            res.on('end', resolve);
            res.on('error', reject);
          })
          .on('error', reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Server did not start on port ${port} within ${timeoutMs}ms`);
}

function readLogTail(filePath: string, maxChars = 4_000): string {
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.slice(-maxChars).trim();
}

export default async function globalSetup(_config: FullConfig) {
  void _config;
  const projectRoot = path.resolve(__dirname, '../..');

  try {
    execSync(`lsof -ti:${E2E_PORT} | xargs kill -9`, { stdio: 'ignore' });
  } catch {
    // Ignore if no process is running on the port
  }
  const tmpDir = path.join(
    projectRoot,
    '.tmp',
    `.vox-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  // Create isolated data directory
  fs.mkdirSync(tmpDir, { recursive: true });

  // Create empty config file so server starts with no users (triggers setup wizard)
  fs.writeFileSync(path.join(tmpDir, 'vox.toml'), '');
  const stdoutLog = path.join(tmpDir, 'server.stdout.log');
  const stderrLog = path.join(tmpDir, 'server.stderr.log');

  // Start Vox server on port 5051 with its own isolated data and config
  const serverDir = path.join(projectRoot, 'server');
  const server = spawn(
    'cargo',
    [
      'run',
      '--',
      '-f',
      '--port',
      String(E2E_PORT),
      '--data',
      tmpDir,
      '--config',
      path.join(tmpDir, 'vox.toml'),
      '-w',
      '../web/dist',
    ],
    {
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env },
    }
  );

  server.stdout?.pipe(fs.createWriteStream(stdoutLog));
  server.stderr?.pipe(fs.createWriteStream(stderrLog));

  // Write PID inside the temp dir so teardown can find it
  fs.writeFileSync(path.join(tmpDir, 'pid'), String(server.pid));

  let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  server.once('exit', (code, signal) => {
    earlyExit = { code, signal };
  });

  try {
    await waitForServer(E2E_PORT, stderrLog);
  } catch (error) {
    const exitInfo = earlyExit as { code: number | null; signal: NodeJS.Signals | null } | null;
    if (exitInfo) {
      const stdoutTail = readLogTail(stdoutLog);
      const stderrTail = readLogTail(stderrLog);
      const details = [stdoutTail, stderrTail].filter(Boolean).join('\n\n');
      throw new Error(
        `Vox exited before becoming ready on port ${E2E_PORT} ` +
          `(code=${exitInfo.code}, signal=${exitInfo.signal}).` +
          (details ? `\n\n${details}` : '')
      );
    }
    throw error;
  }
}
