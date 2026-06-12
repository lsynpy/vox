import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullConfig } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function globalTeardown(_config: FullConfig) {
  void _config;
  const projectRoot = path.resolve(__dirname, '../..');
  const tmpRoot = path.join(projectRoot, '.tmp');

  if (!fs.existsSync(tmpRoot)) return;

  // Find the e2e temp directory
  const entries = fs.readdirSync(tmpRoot);
  const e2eDir = entries.find((e) => e.startsWith('.vox-e2e-'));
  if (!e2eDir) return;

  const tmpDir = path.join(tmpRoot, e2eDir);

  // Kill the server
  const pidFile = path.join(tmpDir, 'pid');
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
    try {
      process.kill(-pid, 'SIGTERM'); // kill process group (cargo + vox)
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
  }

  // Clean up entire temp directory
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
