#!/usr/bin/env node
/**
 * polaris-player — macOS CLI music player for Polaris music library.
 *
 * Depends on: mpv (brew install mpv)
 * Usage:
 *   player play <query>     Search and play a song
 *   player pause             Pause playback
 *   player resume            Resume playback
 *   player toggle            Toggle play/pause
 *   player stop              Stop playback
 *   player next              Next track in queue
 *   player prev              Previous track
 *   player queue [<query>]   Show queue or add track(s)
 *   player list              Show queued tracks
 *   player status            Show current playback state
 *   player volume <0-100>    Set volume
 *   player seek <+/-seconds> Seek forward/backward
 *   player search <query>    Search library, show results
 *   player now               Show current track info
 */

"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const readline = require("readline");

// ─── Configuration ───────────────────────────────────────────
const MUSIC_DIR = path.join(os.homedir(), "Music", "polaris");
const STATE_DIR = path.join(os.homedir(), ".polaris", "player");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const IPC_SOCKET = path.join(os.homedir(), ".polaris", "player", "mpv.sock");

// Polaris server config
const POLARIS_URL = "http://192.168.100.1:5050";
const POLARIS_CREDS = { username: "admin", password: "admin" };
const POLARIS_MOUNT = "Music"; // mount point name in Polaris

// ─── State management ────────────────────────────────────────

function loadState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw);
    // Verify mpv is actually alive
    if (state.pid) {
      try {
        process.kill(state.pid, 0);
        // Also verify IPC works
        try { fs.accessSync(IPC_SOCKET); } catch {
          // Socket gone, mpv is dead
          state.pid = null;
        }
      } catch {
        state.pid = null;
      }
    }
    return state;
  } catch {
    return { queue: [], currentIndex: -1, volume: 80, pid: null };
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Music library search ────────────────────────────────────

// Simplified→Traditional mapping for common music-related Chinese characters
const SIMP_TO_TRAD = {
  "陈":"陳","奕":"奕","迅":"迅","无":"無","赖":"賴","郑":"鄭","中":"中","基":"基",
  "李":"李","荣":"榮","浩":"浩","周":"周","杰":"杰","伦":"倫","王":"王","力":"力","宏":"宏",
  "林":"林","俊":"俊","杰":"杰","陶":"陶","喆":"喆","刘":"劉","德":"德","华":"華",
  "张":"張","学":"學","友":"友","郭":"郭","静":"靜","孙":"孫","燕":"燕","姿":"姿",
  "蔡":"蔡","依":"依","琳":"琳","梁":"梁","静":"靜","茹":"茹","范":"范","晓":"曉","萱":"萱",
  "莫":"莫","文":"文","蔚":"蔚","那":"那","英":"英","韩":"韓","红":"紅","朴":"朴","树":"樹",
  "许":"許","巍":"巍","汪":"汪","峰":"峰","郑":"鄭","钧":"鈞","赵":"趙","雷":"雷",
  "毛":"毛","不":"不","易":"易","告":"告","五":"五","人":"人","万":"萬","能":"能","青":"青","年":"年","旅":"旅","店":"店",
  "飞":"飛","儿":"兒","乐":"樂","队":"隊","花":"花","草":"草","蜢":"蜢",
  "纵":"縱","贯":"貫","线":"線","罗":"羅","大":"大","佑":"佑",
  "温":"溫","岚":"嵐","杨":"楊","丞":"丞","琳":"琳","萧":"蕭","亚":"亞","轩":"軒",
  "谢":"謝","安":"安","琪":"琪","江":"江","美":"美","琪":"琪",
  "戴":"戴","佩":"佩","妮":"妮","方":"方","大":"大","同":"同",
  "新":"新","裤":"褲","子":"子","刺":"刺","猬":"猬","回":"回","春":"春","丹":"丹",
  "椅":"椅","子":"子","乐":"樂","团":"團","飛":"飛","兒":"兒","軍":"軍","隊":"隊",
  "刘":"劉","若":"若","英":"英","任":"任","賢":"賢","齊":"齊",
  "古":"古","巨":"巨","基":"基","周":"周","华":"華","健":"健",
  "陈":"陳","慧":"慧","琳":"琳","柏":"柏","宇":"宇","潔":"潔","儀":"儀","绮":"綺","貞":"貞",
  "beyond":"beyond","tank":"tank","oasis":"oasis",
};

function normChinese(s) {
  // Convert simplified characters to traditional for matching
  let result = "";
  for (const ch of s) {
    result += SIMP_TO_TRAD[ch] || ch;
  }
  return result;
}

function fuzzyMatch(queryStr, candidate) {
  if (!queryStr) return true;
  // Try exact match first
  if (candidate.includes(queryStr)) return true;
  // Try with simplified→traditional conversion
  const tradQuery = normChinese(queryStr);
  if (tradQuery !== queryStr && candidate.includes(tradQuery)) return true;
  // Per-character fuzzy: all chars must appear in order
  let ci = 0;
  for (const qc of queryStr) {
    const found = candidate.indexOf(qc, ci);
    if (found === -1) {
      // Try traditional version of this char
      const tc = SIMP_TO_TRAD[qc];
      if (tc && tc !== qc) {
        const found2 = candidate.indexOf(tc, ci);
        if (found2 === -1) return false;
        ci = found2 + 1;
      } else {
        return false;
      }
    } else {
      ci = found + 1;
    }
  }
  return true;
}

function searchLibrary(query) {
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === ".mp3" || ext === ".m4a" || ext === ".flac" || ext === ".wav" || ext === ".ogg") {
          const relative = path.relative(MUSIC_DIR, full);
          if (query === "" || fuzzyMatch(query, relative)) {
            const parts = relative.split(path.sep);
            const artist = parts.length >= 2 ? parts[0] : "Unknown";
            const album = parts.length >= 3 ? parts[1] : "Unknown";
            const file = parts[parts.length - 1];
            const title = file.replace(/^\d+\.\s*/, "").replace(/\.[^.]+$/, "");
            results.push({ filepath: full, relative, artist, album, title, ext });
          }
        }
      }
    }
  }

  walk(MUSIC_DIR);
  return results;
}

function searchScored(query) {
  const results = searchLibrary(query);
  if (query === "" || !query) return results;

  const q = query.toLowerCase();
  const tradQ = normChinese(q);
  // Score: exact match > starts with > contains
  for (const r of results) {
    let score = 0;
    // Use both original and traditional-normalized for matching
    const base = path.basename(r.filepath).replace(/\.[^.]+$/, "");
    const baseLower = base.toLowerCase();
    const baseTrad = normChinese(baseLower);
    const fullTrad = normChinese(r.relative.toLowerCase());
    const artistTrad = normChinese(r.artist.toLowerCase());
    const albumTrad = normChinese(r.album.toLowerCase());

    if (baseLower === q || baseTrad === tradQ) score += 100;
    else if (baseLower.startsWith(q) || baseTrad.startsWith(tradQ)) score += 80;
    else if (baseLower.includes(q) || baseTrad.includes(tradQ)) score += 50;
    if (r.artist.toLowerCase().includes(q) || artistTrad.includes(tradQ)) score += 30;
    if (r.album.toLowerCase().includes(q) || albumTrad.includes(tradQ)) score += 20;
    r.score = score;
  }

  results.sort((a, b) => b.score - a.score);
  // If none of the lib results scored above 0 but we know they matched fuzzy,
  // give them a minimum score of 1 so at least something shows up
  const hasScore = results.some((r) => r.score > 0);
  if (!hasScore) {
    results.forEach((r) => (r.score = 1));
  }
  return results.filter((r) => r.score > 0);
}

// ─── mpv control ─────────────────────────────────────────────

function sendMpvCommand(command) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let collection = "";

    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error("IPC connection timed out"));
    }, 8000);

    client.on("data", (data) => {
      collection += data.toString();
      try {
        const parsed = JSON.parse(collection);
        clearTimeout(timeout);
        client.destroy();
        resolve(parsed);
      } catch {
        // partial data, wait for more
      }
    });

    client.on("error", (err) => {
      clearTimeout(timeout);
      client.destroy();
      reject(err);
    });

    client.connect(IPC_SOCKET, () => {
      const request_id = Math.floor(Math.random() * 1000000);
      const msg = JSON.stringify({ command, request_id }) + "\n";
      client.write(msg);
    });
  });
}

function ensureMpv(state) {
  // Check if mpv is already running and responsive
  if (state.pid) {
    try {
      process.kill(state.pid, 0);
      // Quick IPC check
      if (fs.existsSync(IPC_SOCKET)) {
        return new Promise((resolve) => {
          const client = new net.Socket();
          client.connect(IPC_SOCKET, () => {
            const msg = JSON.stringify({ command: ["get_property", "volume"], request_id: 0 }) + "\n";
            client.write(msg);
            client.on("data", () => { client.destroy(); resolve(state); });
            setTimeout(() => { client.destroy(); resolve(state); }, 300);
          });
          client.on("error", () => {
            client.destroy();
            state.pid = null;
            saveState(state);
            resolve(ensureMpv(state));
          });
        });
      }
    } catch { state.pid = null; }
  }

  // Kill any stale mpv and clean up
  try { require("child_process").execSync("pkill -f 'mpv.*polaris-player' 2>/dev/null", { stdio: "ignore" }); } catch {}
  try { fs.unlinkSync(IPC_SOCKET); } catch {}

  // Start mpv as a properly detached daemon using nohup
  // nohup ensures mpv survives the Node.js process exit
  const logFile = path.join(STATE_DIR, "mpv.log");
  const cmd = `nohup mpv --no-video --no-terminal --idle --input-ipc-server='${IPC_SOCKET}' --volume=${state.volume} > '${logFile}' 2>&1 & echo $!`;
  try {
    const { execSync } = require("child_process");
    const pidStr = execSync(cmd, { shell: "/bin/bash", encoding: "utf-8", timeout: 5000 }).toString().trim();
    state.pid = parseInt(pidStr, 10);
    saveState(state);
  } catch (err) {
    console.error(`ERROR: Failed to start mpv: ${err.message}`);
    return state;
  }

  // Wait for IPC socket to be ready (up to 5s)
  return new Promise((resolve) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      try {
        fs.accessSync(IPC_SOCKET, fs.constants.F_OK);
        setTimeout(() => resolve(state), 500);
      } catch {
        if (attempts > 50) {
          console.error("ERROR: mpv IPC socket not ready after 5s");
          console.error(`  Check log: ${path.join(STATE_DIR, "mpv.log")}`);
          resolve(state);
        } else {
          setTimeout(check, 100);
        }
      }
    };
    check();
  });
}

// ─── Commands ────────────────────────────────────────────────

async function cmdPlay(query) {
  const results = searchScored(query);
  if (results.length === 0) {
    console.log(`No results for "${query}"`);
    return;
  }

  const best = results[0];
  let state = loadState();

  state = await ensureMpv(state);

  // Insert into queue
  state.queue = [best, ...state.queue.filter((t) => t.filepath !== best.filepath)];
  state.currentIndex = 0;
  saveState(state);

  try {
    await sendMpvCommand(["loadfile", best.filepath, "replace"]);
    console.log(`Playing: ${best.artist} — ${best.title}`);
    if (results.length > 1) {
      console.log(`  (${results.length - 1} more matches, use queue or list to browse)`);
    }
  } catch (err) {
    console.error(`Failed to play: ${err.message}`);
  }
}

async function cmdPause() {
  try {
    const state = loadState();
    if (!state.pid) { console.log("Nothing playing"); return; }
    await ensureMpv(state);
    await sendMpvCommand(["set", "pause", true]);
    console.log("Paused");
  } catch (err) {
    console.error(`Failed to pause: ${err.message}`);
  }
}

async function cmdResume() {
  try {
    const state = loadState();
    if (!state.pid) { console.log("Nothing playing"); return; }
    await ensureMpv(state);
    await sendMpvCommand(["set", "pause", false]);
    console.log("Resumed");
  } catch (err) {
    console.error(`Failed to resume: ${err.message}`);
  }
}

async function cmdToggle() {
  try {
    const state = loadState();
    if (!state.pid) { console.log("Nothing playing"); return; }
    await ensureMpv(state);
    const resp = await sendMpvCommand(["cycle", "pause"]);
    const paused = resp?.data === "yes";
    console.log(paused ? "Paused" : "Resumed");
  } catch (err) {
    console.error(`Failed to toggle: ${err.message}`);
  }
}

async function cmdStop() {
  try {
    const state = loadState();
    if (state.pid) {
      try {
        await sendMpvCommand(["stop"]);
      } catch {}
      try { process.kill(state.pid); } catch {}
    }
    state.queue = [];
    state.currentIndex = -1;
    state.pid = null;
    saveState(state);
    console.log("Stopped");
  } catch (err) {
    console.error(`Failed to stop: ${err.message}`);
  }
}

async function cmdNext() {
  let state = loadState();
  if (state.currentIndex < state.queue.length - 1) {
    state.currentIndex++;
    saveState(state);
    const track = state.queue[state.currentIndex];
    try {
      state = await ensureMpv(state);
      await sendMpvCommand(["loadfile", track.filepath, "replace"]);
      console.log(`Playing: ${track.artist} — ${track.title}`);
    } catch (err) {
      console.error(`Failed to play next: ${err.message}`);
    }
  } else {
    console.log("No more tracks in queue");
  }
}

async function cmdPrev() {
  let state = loadState();
  if (state.currentIndex > 0) {
    state.currentIndex--;
    saveState(state);
    const track = state.queue[state.currentIndex];
    try {
      state = await ensureMpv(state);
      await sendMpvCommand(["loadfile", track.filepath, "replace"]);
      console.log(`Playing: ${track.artist} — ${track.title}`);
    } catch (err) {
      console.error(`Failed to play previous: ${err.message}`);
    }
  } else {
    console.log("No previous track");
  }
}

async function cmdQueueJump(query) {
  if (!query) { console.log("Usage: player jump <query>"); return; }
  let state = loadState();
  if (state.queue.length === 0) { console.log("Queue is empty"); return; }

  // Search queue for matching tracks
  const q = query.toLowerCase();
  const matches = [];
  state.queue.forEach((t, i) => {
    const label = `${t.artist} — ${t.title} ${t.album}`.toLowerCase();
    if (fuzzyMatch(q, label)) {
      matches.push({ index: i, track: t });
    }
  });

  if (matches.length === 0) {
    console.log(`No match for "${query}" in current queue`);
    return;
  }

  // Pick the first match (skip current playing if possible)
  const currentIx = state.currentIndex;
  let match = matches[0];
  if (matches.length > 1 && match.index === currentIx) {
    match = matches[1]; // skip to next if current matches too
  }

  state.currentIndex = match.index;
  saveState(state);

  state = await ensureMpv(state);
  try {
    await sendMpvCommand(["loadfile", match.track.filepath, "replace"]);
    console.log(`Jumped to [${match.index + 1}/${state.queue.length}]: ${match.track.artist} — ${match.track.title}`);
    if (matches.length > 1) {
      console.log(`  (${matches.length - 1} more matches in queue)`);
    }
  } catch (err) {
    console.error(`Failed to jump: ${err.message}`);
  }
}

async function cmdQueue(args) {
  const state = loadState();

  if (args.length === 0) {
    // Show queue
    console.log(`\nQueue (${state.queue.length} tracks):\n`);
    state.queue.forEach((t, i) => {
      const playing = i === state.currentIndex ? " ▶" : "  ";
      console.log(`  ${playing} ${i + 1}. ${t.artist} — ${t.title}`);
    });
    if (state.currentIndex < 0) console.log("  (empty)");
    return;
  }

  // Add to queue
  const query = args.join(" ");
  const results = searchScored(query);
  if (results.length === 0) {
    console.log(`No results for "${query}"`);
    return;
  }
  const best = results[0];

  // Avoid duplicates in queue
  if (!state.queue.some((t) => t.filepath === best.filepath)) {
    state.queue.push(best);
  }
  saveState(state);
  if (state.currentIndex === -1) {
    // Nothing currently playing, start this
    await cmdPlay(query);
  } else {
    console.log(`Queued: ${best.artist} — ${best.title}`);
  }
}

async function cmdList() {
  const state = loadState();
  console.log(`\nQueue (${state.queue.length} tracks):\n`);
  state.queue.forEach((t, i) => {
    const playing = i === state.currentIndex ? " ▶" : "  ";
    console.log(`  ${playing} ${i + 1}. ${t.artist} — ${t.title} [${t.album}]`);
  });
  if (state.queue.length === 0) console.log("  (empty)");
}

async function cmdStatus() {
  const state = loadState();
  console.log(`Volume: ${state.volume}%`);
  if (state.pid) {
    console.log("mpv: running");
    try {
      const resp = await sendMpvCommand(["get_property", "pause"]);
      const paused = resp?.data === true;
      console.log(`State: ${paused ? "⏸ Paused" : "▶ Playing"}`);
      const timeResp = await sendMpvCommand(["get_property", "time-pos"]);
      const durResp = await sendMpvCommand(["get_property", "duration"]);
      const pos = Math.floor(timeResp?.data || 0);
      const dur = Math.floor(durResp?.data || 0);
      if (dur > 0) {
        const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
        const pct = Math.round((pos / dur) * 100);
        console.log(`Progress: ${fmt(pos)} / ${fmt(dur)} (${pct}%)`);
      }
    } catch {
      console.log("(unable to query mpv)");
    }
  } else {
    console.log("mpv: not running");
  }
  if (state.currentIndex >= 0 && state.queue[state.currentIndex]) {
    const t = state.queue[state.currentIndex];
    console.log(`Now playing: ${t.artist} — ${t.title}`);
  }
}

async function cmdNow() {
  const state = loadState();
  if (state.currentIndex >= 0 && state.queue[state.currentIndex]) {
    const t = state.queue[state.currentIndex];
    console.log(`▶ ${t.artist} — ${t.title}`);
    console.log(`   Album: ${t.album}`);
    console.log(`   File:  ${t.relative}`);
    try {
      const resp = await sendMpvCommand(["get_property", "time-pos"]);
      const durResp = await sendMpvCommand(["get_property", "duration"]);
      const pos = Math.floor(resp?.data || 0);
      const dur = Math.floor(durResp?.data || 0);
      if (dur > 0) {
        const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
        console.log(`   ${fmt(pos)} / ${fmt(dur)}`);
      }
    } catch {}
  } else {
    console.log("Nothing playing");
  }
}

async function cmdVolume(args) {
  const level = parseInt(args[0], 10);
  if (isNaN(level) || level < 0 || level > 100) {
    console.log("Usage: player volume <0-100>");
    return;
  }
  const state = loadState();
  state.volume = level;
  saveState(state);
  try {
    const running = state.pid && await ensureMpv(state);
    await sendMpvCommand(["set", "volume", level]);
  } catch {}
  console.log(`Volume: ${level}%`);
}

async function cmdSeek(args) {
  const amount = args[0];
  if (!amount) { console.log("Usage: player seek <+/-seconds>"); return; }
  try {
    const state = loadState();
    if (!state.pid) { console.log("Nothing playing"); return; }
    await ensureMpv(state);
    const resp = await sendMpvCommand(["seek", amount, "relative"]);
    console.log(`Seek ${amount}s`);
  } catch (err) {
    console.error(`Failed to seek: ${err.message}`);
  }
}

async function cmdSearch(query) {
  const results = searchScored(query);
  if (results.length === 0) {
    console.log(`No results for "${query}"`);
    return;
  }
  console.log(`\nSearch results for "${query}" (${results.length}):\n`);
  results.slice(0, 20).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.artist} — ${r.title}`);
    console.log(`      ${r.album}  [${r.ext}]`);
  });
  if (results.length > 20) {
    console.log(`  ... and ${results.length - 20} more`);
  }
}

function cmdHelp() {
  console.log(`
polaris-player — macOS CLI music player

Usage: player <command> [args]

Playback:
  play <query>        Search and play a song
  pause               Pause playback
  resume              Resume playback
  toggle              Toggle play/pause
  stop                Stop and clear queue
  next                Next track
  prev                Previous track

Queue:
  queue [<query>]     Show queue, or add track(s) to queue
  list                List queued tracks
  shuffle             Randomize queue order
  jump <query>        Jump to a track matching query in current queue

Playlist (via Polaris API):
  playlist [name]     Load a Polaris playlist (default: fav)
  pl-add <query>      Add search result to the current playlist
  pl-remove <query>   Remove track from current playlist

Info:
  status              Show playback status
  now                 Show current track info
  search <query>      Search music library
  volume <0-100>      Set volume
  seek <+/-seconds>   Seek forward/backward
  help                Show this help

Examples:
  player playlist          Load fav playlist and start playing
  player playlist jazz     Load a playlist named \"jazz\"
  player shuffle           Randomize current queue order
  player pl-add 消愁       Add \"消愁\" to the current playlist
  player pl-remove 消愁    Remove \"消愁\" from the playlist
  player play 漠河舞厅
  player volume 60
`);
}

// ─── Polaris API ────────────────────────────────────────────

const http = require("http");

let _polarisToken = null;

function polarisFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const { method = "GET", headers = {}, body } = options;
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || 80,
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function polarisAuth() {
  if (_polarisToken) return _polarisToken;
  const resp = await polarisFetch(`${POLARIS_URL}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(POLARIS_CREDS),
  });
  if (resp.status !== 200) throw new Error(`Polaris auth failed: ${resp.status}`);
  const data = resp.json();
  _polarisToken = data.token;
  return _polarisToken;
}

async function polarisGet(path) {
  const token = await polarisAuth();
  const separator = path.includes("?") ? "&" : "?";
  const resp = await polarisFetch(`${POLARIS_URL}${path}${separator}auth_token=${encodeURIComponent(token)}`, {
    headers: { "Accept-Version": "8" },
  });
  if (resp.status !== 200) {
    const txt = resp.body?.substring(0, 200);
    throw new Error(`Polaris GET ${path} failed: ${resp.status} ${txt}`);
  }
  return resp.json();
}

async function polarisPut(path, body) {
  const token = await polarisAuth();
  const separator = path.includes("?") ? "&" : "?";
  const resp = await polarisFetch(`${POLARIS_URL}${path}${separator}auth_token=${encodeURIComponent(token)}`, {
    method: "PUT",
    headers: {
      "Accept-Version": "8",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (resp.status !== 200 && resp.status !== 204) {
    throw new Error(`Polaris PUT ${path} failed: ${resp.status}`);
  }
}

function polarisPathToLocal(polarisPath) {
  const prefix = `${POLARIS_MOUNT}/`;
  if (polarisPath.startsWith(prefix)) {
    return path.join(MUSIC_DIR, polarisPath.slice(prefix.length));
  }
  return path.join(MUSIC_DIR, polarisPath);
}

// ─── Playlist commands ───────────────────────────────────────

async function cmdPlaylist(name) {
  const playlistName = name || "fav";
  try {
    const data = await polarisGet(`/api/playlist/${encodeURIComponent(playlistName)}`);
    const songs = data.songs || {};
    const plPaths = songs.paths || [];

    if (plPaths.length === 0) {
      console.log(`Playlist "${playlistName}" is empty`);
      return;
    }

    const localTracks = [];
    const missing = [];
    for (const p of plPaths) {
      const localPath = polarisPathToLocal(p);
      if (fs.existsSync(localPath)) {
        const parts = p.split(path.sep);
        const artist = parts.length >= 2 ? parts[1] : "Unknown";
        const album = parts.length >= 3 ? parts[2] : "Unknown";
        const file = parts[parts.length - 1];
        const title = file.replace(/^\d+\.\s*/, "").replace(/\.[^.]+$/, "");
        localTracks.push({ filepath: localPath, relative: p, artist, album, title, ext: path.extname(localPath) });
      } else {
        missing.push(p);
      }
    }

    if (localTracks.length === 0) {
      console.log(`No playable files found from playlist "${playlistName}"`);
      return;
    }

    let state = loadState();
    state.queue = localTracks;
    state.currentIndex = 0;
    saveState(state);

    console.log(`Loaded playlist "${playlistName}" (${localTracks.length} tracks)`);
    if (missing.length > 0) console.log(`  (${missing.length} files missing locally, skipped)`);

    state = await ensureMpv(state);
    try {
      await sendMpvCommand(["loadfile", localTracks[0].filepath, "replace"]);
      console.log(`Playing: ${localTracks[0].artist} — ${localTracks[0].title}`);
    } catch (err) {
      console.error(`Failed to play: ${err.message}`);
    }
  } catch (err) {
    console.error(`Failed to load playlist: ${err.message}`);
  }
}

async function cmdShuffle() {
  const state = loadState();
  if (state.queue.length === 0) {
    console.log("Queue is empty");
    return;
  }

  const current = state.currentIndex >= 0 ? state.queue[state.currentIndex] : null;
  const rest = state.queue.filter((_, i) => i !== state.currentIndex);

  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }

  if (current) {
    state.queue = [current, ...rest];
    state.currentIndex = 0;
  } else {
    state.queue = rest;
    state.currentIndex = -1;
  }
  saveState(state);
  console.log(`Shuffled ${state.queue.length} tracks`);
}

async function cmdPlaylistAdd(query) {
  if (!query) { console.log("Usage: player pl-add <query>"); return; }

  const results = searchScored(query);
  if (results.length === 0) {
    console.log(`No results for "${query}"`);
    return;
  }
  const best = results[0];
  const polarisPath = `${POLARIS_MOUNT}/${path.relative(MUSIC_DIR, best.filepath)}`;

  try {
    const playlistName = "fav";
    let currentTracks = [];
    try {
      const data = await polarisGet(`/api/playlist/${playlistName}`);
      currentTracks = (data.songs || {}).paths || [];
    } catch {}

    if (currentTracks.includes(polarisPath)) {
      console.log(`Already in playlist: ${best.artist} — ${best.title}`);
      return;
    }

    const newTracks = [...currentTracks, polarisPath];
    await polarisPut(`/api/playlist/${playlistName}`, { tracks: newTracks });
    console.log(`Added to playlist: ${best.artist} — ${best.title}`);
  } catch (err) {
    console.error(`Failed to add to playlist: ${err.message}`);
  }
}

async function cmdPlaylistRemove(query) {
  if (!query) { console.log("Usage: player pl-remove <query>"); return; }

  try {
    const playlistName = "fav";
    const data = await polarisGet(`/api/playlist/${playlistName}`);
    const plPaths = (data.songs || {}).paths || [];

    const matching = plPaths.filter((p) => p.toLowerCase().includes(query.toLowerCase()));

    if (matching.length === 0) {
      console.log(`No matching tracks for "${query}" in playlist`);
      return;
    }

    const newTracks = plPaths.filter((p) => !matching.includes(p));
    await polarisPut(`/api/playlist/${playlistName}`, { tracks: newTracks });

    matching.forEach((p) => {
      const filename = path.basename(p).replace(/\.[^.]+$/, "");
      console.log(`Removed: ${filename}`);
    });
    console.log(`\nRemoved ${matching.length} track(s) from "${playlistName}"`);
  } catch (err) {
    console.error(`Failed to remove from playlist: ${err.message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "help";
  const rest = args.slice(1);

  if (!fs.existsSync(MUSIC_DIR)) {
    console.error(`Music directory not found: ${MUSIC_DIR}`);
    console.error("Set MUSIC_DIR in the script or symlink your music.");
    process.exit(1);
  }

  try {
    switch (cmd) {
      case "play": await cmdPlay(rest.join(" ")); break;
      case "pause": await cmdPause(); break;
      case "resume": await cmdResume(); break;
      case "toggle": await cmdToggle(); break;
      case "stop": await cmdStop(); break;
      case "next": await cmdNext(); break;
      case "prev": await cmdPrev(); break;
      case "queue": await cmdQueue(rest); break;
      case "jump": await cmdQueueJump(rest.join(" ")); break;
      case "list": await cmdList(); break;
      case "status": await cmdStatus(); break;
      case "now": await cmdNow(); break;
      case "volume": await cmdVolume(rest); break;
      case "seek": await cmdSeek(rest); break;
      case "search": await cmdSearch(rest.join(" ")); break;
      case "playlist": await cmdPlaylist(rest.join(" ")); break;
      case "shuffle": await cmdShuffle(); break;
      case "pl-add": await cmdPlaylistAdd(rest.join(" ")); break;
      case "pl-remove": await cmdPlaylistRemove(rest.join(" ")); break;
      case "help":
      default: cmdHelp(); break;
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
