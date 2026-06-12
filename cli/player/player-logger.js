#!/usr/bin/env node
/**
 * Shared logger for polaris-player.
 *
 * All temp files, cover images, and logs go to /tmp/polaris-player/.
 * Log rotation at 5 MB.
 *
 * Usage:
 *   const { PLAYER_DIR, info, action, warn, error } = require('./player-logger');
 *   info('Component', 'Something happened', { optional: 'data' });
 */

const fs = require("fs");
const path = require("path");

const PLAYER_DIR = "/tmp/polaris-player";
const LOG_FILE = path.join(PLAYER_DIR, "player.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

// Lazily ensure the dir exists (also done on each write for safety)
function ensureDir() {
  try {
    fs.mkdirSync(PLAYER_DIR, { recursive: true });
  } catch {}
}

// Rotate the log if it exceeds MAX_LOG_SIZE
function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      const old = LOG_FILE + ".old";
      try {
        fs.unlinkSync(old);
      } catch {}
      fs.renameSync(LOG_FILE, old);
    }
  } catch {
    // First write or non-existent — not an error
  }
}

function write(level, component, msg, data) {
  ensureDir();
  rotateIfNeeded();
  const d = new Date();
  const ts = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
  const paddedLevel = level.padEnd(6);
  const paddedComp = component.padEnd(20);
  const dataStr = data !== undefined ? "  " + JSON.stringify(data) : "";
  const line = `[${ts}] [${paddedLevel}] [${paddedComp}] ${msg}${dataStr}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

module.exports = {
  PLAYER_DIR,
  info: (component, msg, data) => write("INFO", component, msg, data),
  action: (component, msg, data) => write("ACTION", component, msg, data),
  warn: (component, msg, data) => write("WARN", component, msg, data),
  error: (component, msg, data) => write("ERROR", component, msg, data),
};
