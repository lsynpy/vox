#!/usr/bin/env node
/**
 * Shared logger for vox-cli.
 *
 * All temp files, cover images, and logs go to /tmp/vox-player/.
 * Log rotation at 5 MB.
 *
 * Usage:
 *   const { PLAYER_DIR, info, warn, error } = require('./player-logger');
 *   info('Component', 'Something happened', { optional: 'data' });
 */

const fs = require("fs");
const path = require("path");

const PLAYER_DIR = "/tmp/vox-player";
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

// Strip auth_token from URL strings before logging
function stripTokens(s) {
  // Remove auth_token query param entirely, then clean up artifacts
  return s
    .replace(/[?&]auth_token=[^&\s]+/g, "")
    .replace(/^([^?]*)&/, "$1?")
    .replace(/[?&]$/, "");
}

// Recursively decode percent-encoded strings and strip sensitive tokens
function sanitize(o) {
  if (typeof o === "string") {
    try { return stripTokens(decodeURIComponent(o)); } catch { return stripTokens(o); }
  }
  if (Array.isArray(o)) return o.map(sanitize);
  if (o && typeof o === "object") {
    const r = {};
    for (const k of Object.keys(o)) r[k] = sanitize(o[k]);
    return r;
  }
  return o;
}

function write(level, msg, data) {
  ensureDir();
  rotateIfNeeded();
  const d = new Date();
  const ts = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
  const paddedLevel = level.padEnd(6);
  const dataStr = data !== undefined ? "  " + JSON.stringify(sanitize(data)) : "";
  const line = `[${ts}] [${paddedLevel}] ${msg}${dataStr}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

module.exports = {
  PLAYER_DIR,
  info: (msg, data) => write("INFO", msg, data),
  warn: (msg, data) => write("WARN", msg, data),
  error: (msg, data) => write("ERROR", msg, data),
};
