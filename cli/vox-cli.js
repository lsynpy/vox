#!/usr/bin/env node
/**
 * vox-cli — macOS CLI music player for Vox music library.
 *
 * No local state caching — everything reads from mpv IPC or Vox API in real time.
 * mpv's own internal playlist IS the queue. No local state.json.
 *
 * Depends on: mpv (brew install mpv)
 * Usage: see cmdHelp()
 */

"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const { PLAYER_DIR, info, warn, error } = require("./vox-cli-logger");

// ─── Configuration ───────────────────────────────────────────
const MUSIC_DIR = path.join(os.homedir(), "Music", "vox");
const SOCKET_DIR = path.join(os.homedir(), ".vox", "player");
const IPC_SOCKET = path.join(SOCKET_DIR, "mpv.sock");
const MPV_LOG = path.join(SOCKET_DIR, "mpv.log");

// Vox server config
const VOX_URL = "http://192.168.100.1:5050";
const VOX_CREDS = { username: "admin", password: "admin" };
const VOX_MOUNT = "Music";

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
  let result = "";
  for (const ch of s) {
    result += SIMP_TO_TRAD[ch] || ch;
  }
  return result;
}

function fuzzyMatch(queryStr, candidate) {
  if (!queryStr) return true;
  if (candidate.includes(queryStr)) return true;
  const tradQuery = normChinese(queryStr);
  if (tradQuery !== queryStr && candidate.includes(tradQuery)) return true;
  let ci = 0;
  for (const qc of queryStr) {
    const found = candidate.indexOf(qc, ci);
    if (found === -1) {
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
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
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
  for (const r of results) {
    let score = 0;
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
  const hasScore = results.some((r) => r.score > 0);
  if (!hasScore) results.forEach((r) => (r.score = 1));
  return results.filter((r) => r.score > 0);
}

// ─── mpv control ─────────────────────────────────────────────

function sendMpvCommand(command) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let collection = "";
    const timeout = setTimeout(() => { client.destroy(); reject(new Error("IPC timeout")); }, 8000);
    client.on("data", (data) => {
      collection += data.toString();
      try {
        const parsed = JSON.parse(collection);
        clearTimeout(timeout);
        client.destroy();
        resolve(parsed);
      } catch { /* partial data */ }
    });
    client.on("error", (err) => { clearTimeout(timeout); client.destroy(); reject(err); });
    client.connect(IPC_SOCKET, () => {
      const msg = JSON.stringify({ command, request_id: Math.floor(Math.random() * 1000000) }) + "\n";
      client.write(msg);
    });
  });
}

// Ensure mpv is running. No local state — just try IPC, restart if needed.
// Also loads the album-art plugin so macOS NowPlaying shows cover art.
async function ensureMpv() {
  // Try existing socket
  try {
    await sendMpvCommand(["get_property", "volume"]);
    // mpv is alive — cover-on-load handled by Lua script
    return;
  } catch { /* mpv not reachable, start it */ }

  // Kill stale mpv
  info("mpv not reachable, starting new instance");
  try { require("child_process").execSync(`pkill -f 'mpv.*${path.basename(IPC_SOCKET)}' 2>/dev/null`, { stdio: "ignore" }); } catch {}
  try { fs.unlinkSync(IPC_SOCKET); } catch {}

  // Ensure socket dir exists
  fs.mkdirSync(SOCKET_DIR, { recursive: true });

  // Start mpv as detached daemon, with cover-on-load hook and cover-art-files support for NowPlaying
  const scriptPath = path.join(__dirname, "cover-hook.lua");
  const cmd = `nohup mpv --no-video --no-terminal --idle --script='${scriptPath}' --input-ipc-server='${IPC_SOCKET}' > '${MPV_LOG}' 2>&1 & echo $!`;
  try {
    const { execSync } = require("child_process");
    execSync(cmd, { shell: "/bin/bash", encoding: "utf-8", timeout: 5000 });
  } catch (err) {
    console.error(`ERROR: Failed to start mpv: ${err.message}`);
    return;
  }

  // Wait for IPC socket
  for (let i = 0; i < 50; i++) {
    try { fs.accessSync(IPC_SOCKET); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }

  }

  // Read mpv's entire playlist as an array of { filename, current }
async function mpvPlaylistEntries() {
  try {
    const resp = await sendMpvCommand(["get_property", "playlist"]);
    return (resp?.data || []).map((e, i) => ({
      index: i,
      filename: e.filename || "",
      current: !!e.current,
    }));
  } catch { return []; }
}

// Decode a playable URL (JDC stream or local path) from a track's relative path
async function resolveTrackUrl(relative) {
  try {
    const token = await voxAuth();
    let p = relative;
    const prefix = `${VOX_MOUNT}/`;
    if (!p.startsWith(prefix)) p = prefix + p;
    const parts = p.split("/").map((s) => encodeURIComponent(s));
    return `${VOX_URL}/api/audio/${parts.join("/")}?auth_token=${encodeURIComponent(token)}`;
  } catch {
    // Vox unreachable, use local file
    return path.join(MUSIC_DIR, relative);
  }
}

// Decode artist/album/title from a filename (JDC URL or local path)
function parseTrackInfo(filename) {
  if (filename.startsWith("http://192.168.100.1:5050")) {
    try {
      const u = new URL(filename);
      const segments = u.pathname.split("/").filter(Boolean);
      const audioIdx = segments.indexOf("audio");
      if (audioIdx >= 0 && segments.length >= audioIdx + 4) {
        const segs = segments.slice(audioIdx + 2).map(s => decodeURIComponent(s));
        const filePart = segs.pop();
        const relPath = segs.join("/");
        const slashIdx = relPath.lastIndexOf("/");
        const artist = slashIdx >= 0 ? relPath.slice(0, slashIdx) : relPath;
        const album = slashIdx >= 0 ? relPath.slice(slashIdx + 1) : "Unknown";
        const title = filePart.replace(/^\d+\.\s*/, "").replace(/\.[^.]+$/, "");
        return { artist, album, title };
      }
    } catch { /* fall through */ }
  } else if (filename && !filename.startsWith("http")) {
    const relative = filename.startsWith(MUSIC_DIR) ? filename.slice(MUSIC_DIR.length + 1) : filename;
    const parts = relative.split("/");
    const artist = parts.length >= 2 ? parts[0] : "Unknown";
    const album = parts.length >= 3 ? parts[1] : "Unknown";
    const file = parts[parts.length - 1];
    const title = file.replace(/^\d+\.\s*/, "").replace(/\.[^.]+$/, "");
    return { artist, album, title };
  }
  return null;
}

// Get currently playing info from mpv directly
async function mpvNowPlaying() {
  try {
    const pathResp = await sendMpvCommand(["get_property", "path"]);
    const titleResp = await sendMpvCommand(["get_property", "media-title"]);
    const url = pathResp?.data || "";
    let mediaTitle = titleResp?.data || "";
    // Strip query string from mediaTitle (may contain auth_token etc.)
    const qIdx = mediaTitle.indexOf("?");
    if (qIdx >= 0) mediaTitle = mediaTitle.substring(0, qIdx);
    // Strip file extension if present (mpv may use the URL filename)
    mediaTitle = mediaTitle.replace(/\.[^.]+$/, "");

    const info = parseTrackInfo(url);
    if (info) {
      // Use media-title if it's more accurate (has ID3 tags), otherwise filename-derived
      if (mediaTitle && mediaTitle !== path.basename(url).replace(/\.[^.]+$/, "")) {
        info.title = mediaTitle;
      }
      return info;
    }
    return { artist: "", album: "", title: mediaTitle || "Unknown" };
  } catch {
    return null;
  }
}

// ─── Cover art → macOS NowPlaying ────────────────────────

// Push album art to mpv's NowPlaying via cover-art-files IPC property.
// Extracts embedded cover art from the current audio file.
// Uses a unique temp path per track so mpv always sees a new path and
// actually re-reads the image (mpv caches cover by path, not by content).
const COVER_CACHE = new Map();

function coverTmpPath(localPath) {
  const base = path.basename(localPath, path.extname(localPath));
  // Keep Chinese chars, strip only truly unsafe filename characters
  const safe = base.replace(/[/\\:*?"<>|]/g, "_").slice(0, 60);
  const hash = require("crypto").createHash("md5").update(localPath).digest("hex").slice(0, 8);
  return path.join(PLAYER_DIR, `cover-${safe}-${hash}.jpg`);
}

async function pushCoverArt() {
  try {
    const pathResp = await sendMpvCommand(["get_property", "path"]);
    let jdcUrl = pathResp?.data || "";
    if (!jdcUrl) {
      warn("No mpv path available, skipping cover");
      return;
    }
    info("mpv path obtained", { path: jdcUrl });

    let voxPath = "";
    if (jdcUrl.startsWith("http://192.168.100.1:5050")) {
      const u = new URL(jdcUrl);
      const segments = u.pathname.split("/").filter(Boolean);
      const audioIdx = segments.indexOf("audio");
      if (audioIdx >= 0) {
        voxPath = segments.slice(audioIdx + 1).map(s => decodeURIComponent(s)).join("/");
      }
    } else if (jdcUrl.startsWith("/")) {
      voxPath = jdcUrl;
    } else {
      voxPath = `Music/${jdcUrl}`;
    }
    if (!voxPath) {
      warn("Could not extract Vox path from URL", { jdcUrl });
      return;
    }
    info("Extracted Vox path", { voxPath });

    const cacheKey = `vox:${voxPath}`;
    if (COVER_CACHE.get(cacheKey)) {
      info("Cover cache hit, skipping download", { voxPath });
      return;
    }

    const coverPath = coverTmpPath(voxPath);
    const thumbPath = `/api/thumbnail/${encodeURIComponent(voxPath)}?size=small&pad=false`;
    info("Downloading cover from Vox API", { thumbPath, dest: coverPath });
    const data = await voxGetBuffer(thumbPath);

    if (data && data.length > 100) {
      info("Cover downloaded from Vox API", { bytes: data.length });
      require("fs").writeFileSync(coverPath, data);
      info("Cover written to disk", { path: coverPath, bytes: data.length });
      await sendMpvCommand(["set", "cover-art-files", coverPath]);
      info("cover-art-files set via IPC", { coverPath });
      COVER_CACHE.set(cacheKey, true);
      if (COVER_CACHE.size > 50) {
        const firstKey = COVER_CACHE.keys().next().value;
        COVER_CACHE.delete(firstKey);
      }
    } else {
      warn("Cover download too small or empty", { bytes: data?.length || 0 });
    }
  } catch (err) {
    error("pushCoverArt failed", { error: err.message });
  }
}

// ─── Cover art functions ─────────────────────────

function getMacosVolume() {
  try {
    const { execSync } = require("child_process");
    return execSync("osascript -e 'output volume of (get volume settings)'", { encoding: "utf-8", timeout: 3000 }).trim();
  } catch { return "?"; }
}

async function cmdPlay(query) {
  info("cmd_play", { query });
  const results = searchScored(query);
  if (results.length === 0) { console.log(`No results for "${query}"`); return; }

  const best = results[0];
  await ensureMpv();

  try {
    const url = await resolveTrackUrl(best.relative);
    await sendMpvCommand(["loadfile", url, "replace"]);
    console.log(`Playing: ${best.artist} — ${best.title}`);
    setTimeout(() => pushCoverArt(), 500);
    if (results.length > 1) {
      console.log(`  (${results.length - 1} more matches, use queue or list to browse)`);
    }
  } catch (err) {
    console.error(`Failed to play: ${err.message}`);
  }
}

async function cmdPause() {
  info("cmd_pause");
  await ensureMpv();
  try {
    await sendMpvCommand(["set", "pause", "yes"]);
    console.log("Paused");
  } catch (err) { console.error(`Failed to pause: ${err.message}`); }
}

async function cmdResume() {
  info("cmd_resume");
  await ensureMpv();
  try {
    await sendMpvCommand(["set", "pause", "no"]);
    console.log("Resumed");
  } catch (err) { console.error(`Failed to resume: ${err.message}`); }
}

async function cmdToggle() {
  info("cmd_toggle");
  await ensureMpv();
  try {
    const resp = await sendMpvCommand(["cycle", "pause"]);
    console.log(resp?.data === "yes" ? "Paused" : "Resumed");
  } catch (err) { console.error(`Failed to toggle: ${err.message}`); }
}

async function cmdStop() {
  info("cmd_stop");
  try {
    await sendMpvCommand(["stop"]);
    await sendMpvCommand(["playlist-clear"]);
    console.log("Stopped");
  } catch (err) { console.error(`Failed to stop: ${err.message}`); }
}

async function cmdNext() {
  info("cmd_next");
  await ensureMpv();
  try {
    await sendMpvCommand(["playlist-next"]);
    // Wait for track to load before querying now-playing + cover
    await new Promise(r => setTimeout(r, 600));
    await pushCoverArt();
    const np = await mpvNowPlaying();
    if (np && np.title) console.log(`Now playing: ${np.artist ? np.artist + " — " : ""}${np.title}`);
  } catch (err) { console.error(`Failed: ${err.message}`); }
}

async function cmdPrev() {
  info("cmd_prev");
  await ensureMpv();
  try {
    const resp = await sendMpvCommand(["playlist-prev"]);
    // Wait for track to load before querying now-playing + cover
    await new Promise(r => setTimeout(r, 600));
    await pushCoverArt();
    const np = await mpvNowPlaying();
    if (np && np.title) console.log(`Now playing: ${np.artist ? np.artist + " — " : ""}${np.title}`);
  } catch (err) { console.error(`Failed: ${err.message}`); }
}

async function cmdQueue(args) {
  if (args.length > 0) info("cmd_queue", { query: args.join(" ") });
  if (args.length === 0) {
    // Show queue from mpv's playlist
    const entries = await mpvPlaylistEntries();
    if (entries.length === 0) { console.log("Queue is empty"); return; }
    const currentIx = entries.findIndex(e => e.current);
    console.log(`\nQueue (${entries.length} tracks):\n`);
    for (const e of entries) {
      const info = parseTrackInfo(e.filename);
      const label = info ? `${info.artist} — ${info.title}` : path.basename(e.filename).replace(/\.[^.]+$/, "");
      const mark = e.current ? " ▶" : "  ";
      console.log(`  ${mark} ${e.index + 1}. ${label}`);
    }
    return;
  }

  // Add to queue
  const query = args.join(" ");
  const results = searchScored(query);
  if (results.length === 0) { console.log(`No results for "${query}"`); return; }

  const best = results[0];
  await ensureMpv();
  try {
    const url = await resolveTrackUrl(best.relative);
    await sendMpvCommand(["loadfile", url, "append"]);
    console.log(`Queued: ${best.artist} — ${best.title}`);
  } catch (err) {
    console.error(`Failed to queue: ${err.message}`);
  }
}

async function cmdList() {
  const entries = await mpvPlaylistEntries();
  if (entries.length === 0) { console.log("\nQueue is empty\n"); return; }
  const currentIx = entries.findIndex(e => e.current);
  console.log(`\nQueue (${entries.length} tracks):\n`);
  for (const e of entries) {
    const info = parseTrackInfo(e.filename);
    const label = info ? `${info.artist} — ${info.title}` : path.basename(e.filename).replace(/\.[^.]+$/, "");
    const mark = e.current ? " ▶" : "  ";
    console.log(`  ${mark} ${e.index + 1}. ${label} [${info ? info.album : ""}]`);
  }
}

async function cmdQueueJump(query) {
  if (!query) { console.log("Usage: vox-cli jump <query>"); return; }

  const entries = await mpvPlaylistEntries();
  if (entries.length === 0) { console.log("Queue is empty"); return; }

  const q = query.toLowerCase();
  const matches = [];
  for (const e of entries) {
    const info = parseTrackInfo(e.filename);
    const label = info ? `${info.artist} — ${info.title} ${info.album}`.toLowerCase() : path.basename(e.filename).toLowerCase();
    if (fuzzyMatch(q, label)) {
      matches.push({ index: e.index, info });
    }
  }

  if (matches.length === 0) { console.log(`No match for "${query}" in current queue`); return; }

  const currentIx = entries.findIndex(e => e.current);
  let match = matches[0];
  if (matches.length > 1 && match.index === currentIx) match = matches[1];

  await ensureMpv();
  try {
    await sendMpvCommand(["set", "playlist-pos", match.index]);
    const np = await mpvNowPlaying();
    const label = match.info ? `${match.info.artist} — ${match.info.title}` : "track";
    console.log(`Jumped to [${match.index + 1}/${entries.length}]: ${label}`);
    if (matches.length > 1) console.log(`  (${matches.length - 1} more matches)`);
  } catch (err) { console.error(`Failed to jump: ${err.message}`); }
}

async function cmdStatus() {
  const { execSync } = require("child_process");
  let sysVol = "?";
  try { sysVol = execSync("osascript -e 'output volume of (get volume settings)'", { encoding: "utf-8", timeout: 3000 }).trim(); } catch {}

  let mpvVol = "?";
  try {
    const resp = await sendMpvCommand(["get_property", "volume"]);
    if (resp && typeof resp.data === "number") mpvVol = Math.round(resp.data);
  } catch {}
  console.log(`Volume: mpv ${mpvVol}%  |  macOS ${sysVol}%`);

  try {
    // If we can IPC, mpv is running
    const pauseResp = await sendMpvCommand(["get_property", "pause"]);
    console.log("mpv: running");
    const paused = pauseResp?.data === true;
    console.log(`State: ${paused ? "⏸ Paused" : "▶ Playing"}`);

    const timeResp = await sendMpvCommand(["get_property", "time-pos"]);
    const durResp = await sendMpvCommand(["get_property", "duration"]);
    const pos = Math.floor(timeResp?.data || 0);
    const dur = Math.floor(durResp?.data || 0);
    if (dur > 0) {
      const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      console.log(`Progress: ${fmt(pos)} / ${fmt(dur)} (${Math.round((pos / dur) * 100)}%)`);
    }
  } catch {
    console.log("mpv: not running");
  }

  const np = await mpvNowPlaying();
  if (np && np.title) {
    if (np.artist) console.log(`Now playing: ${np.artist} — ${np.title}`);
    else console.log(`Now playing: ${np.title}`);
  }
}

async function cmdNow() {
  const np = await mpvNowPlaying();
  if (np && np.title) {
    if (np.artist) {
      console.log(`▶ ${np.artist} — ${np.title}`);
      console.log(`   Album: ${np.album}`);
    } else {
      console.log(`▶ ${np.title}`);
    }
  } else {
    console.log("Nothing playing");
    return;
  }
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
}

async function cmdVolume(args) {
  if (args.length > 0) info("cmd_volume", { level: parseInt(args[0], 10) });
  const level = parseInt(args[0], 10);
  if (isNaN(level) || level < 0 || level > 100) {
    // Show current volume
    let mpvVol = "?";
    try {
      const resp = await sendMpvCommand(["get_property", "volume"]);
      if (resp && typeof resp.data === "number") mpvVol = Math.round(resp.data);
    } catch {}
    const sysVol = getMacosVolume();
    console.log(`mpv: ${mpvVol}%  |  macOS: ${sysVol}%`);
    return;
  }
  try {
    await sendMpvCommand(["set", "volume", String(level)]);
    const sysVol = getMacosVolume();
    console.log(`mpv: ${level}%  |  macOS: ${sysVol}%`);
  } catch { /* mpv not running */ }
}

async function cmdSysvol(level) {
  info("cmd_sysvol", { level });
  if (isNaN(level) || level < 0 || level > 100) {
    console.log("Usage: vox-cli sysvol <0-100>");
    return;
  }
  const { execSync } = require("child_process");
  try {
    execSync(`osascript -e 'set volume output volume ${level}'`, { timeout: 3000 });
    console.log(`macOS system volume: ${level}%`);
  } catch (err) { console.error(`Failed to set system volume: ${err.message}`); }
}

async function cmdSeek(args) {
  const amount = args[0];
  info("cmd_seek", { amount });
  if (!amount) { console.log("Usage: vox-cli seek <+/-seconds>"); return; }
  try {
    await sendMpvCommand(["seek", amount, "relative"]);
    console.log(`Seek ${amount}s`);
  } catch (err) { console.error(`Failed to seek: ${err.message}`); }
}

async function cmdSearch(query) {
  const results = searchScored(query);
  if (results.length === 0) { console.log(`No results for "${query}"`); return; }
  console.log(`\nSearch results for "${query}" (${results.length}):\n`);
  results.slice(0, 20).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.artist} — ${r.title}`);
    console.log(`      ${r.album}  [${r.ext}]`);
  });
  if (results.length > 20) console.log(`  ... and ${results.length - 20} more`);
}

function cmdHelp() {
  console.log(`
vox-cli — macOS CLI music player

Usage: vox-cli <command> [args]

Playback:
  play <query>        Search and play a song
  pause               Pause playback
  resume              Resume playback
  toggle              Toggle play/pause
  stop                Stop and clear queue
  next                Next track
  prev                Previous track

Queue (mpv's playlist):
  queue [<query>]     Show queue, or add track(s) to queue
  list                List queued tracks
  shuffle             Randomize queue order
  jump <query>        Jump to a track matching query in current queue

Playlist (via Vox API):
  playlist [name]     Load a Vox playlist (default: fav)
  playlist -s [name]  Load, shuffle and start from a random track
  pl-add <query>      Add search result to the current playlist
  pl-remove <query>   Remove track from current playlist

Info:
  status              Show playback status
  now                 Show current track info
  search <query>      Search music library
  volume [<0-100>]    Show or set mpv volume
  sysvol <0-100>      Set macOS system volume
  seek <+/-seconds>   Seek forward/backward
  help                Show this help

Examples:
  vox-cli playlist          Load fav playlist and start playing
  vox-cli playlist jazz     Load a playlist named "jazz"
  vox-cli shuffle           Randomize current queue
  vox-cli pl-add 消愁       Add "消愁" to the current playlist
  vox-cli pl-remove 消愁    Remove "消愁" from the playlist
  vox-cli play 漠河舞厅
  vox-cli volume 60
`);
}

// ─── Vox API ────────────────────────────────────────────

const http = require("http");
let _voxToken = null;

function voxFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const { method = "GET", headers = {}, body } = options;
    const req = http.request(
      { hostname: urlObj.hostname, port: urlObj.port || 80, path: urlObj.pathname + urlObj.search, method, headers },
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

async function voxAuth() {
  if (_voxToken) return _voxToken;
  const resp = await voxFetch(`${VOX_URL}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(VOX_CREDS),
  });
  if (resp.status !== 200) throw new Error(`Vox auth failed: ${resp.status}`);
  const data = resp.json();
  _voxToken = data.token;
  return _voxToken;
}

async function voxGet(path) {
  const token = await voxAuth();
  const separator = path.includes("?") ? "&" : "?";
  const resp = await voxFetch(`${VOX_URL}${path}${separator}auth_token=${encodeURIComponent(token)}`, {
    headers: { "Accept-Version": "8" },
  });
  if (resp.status !== 200) throw new Error(`Vox GET ${path} failed: ${resp.status} ${(resp.body || "").substring(0, 200)}`);
  return resp.json();
}

async function voxGetBuffer(path) {
  const token = await voxAuth();
  const separator = path.includes("?") ? "&" : "?";
  const url = `${VOX_URL}${path}${separator}auth_token=${encodeURIComponent(token)}`;
  const urlObj = new URL(url);
  return new Promise((resolve, reject) => {
    const req = require("http").request(
      { hostname: urlObj.hostname, port: urlObj.port || 80, path: urlObj.pathname + urlObj.search, method: "GET",
        headers: { "Accept-Version": "8" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function voxPut(path, body) {
  const token = await voxAuth();
  const separator = path.includes("?") ? "&" : "?";
  const resp = await voxFetch(`${VOX_URL}${path}${separator}auth_token=${encodeURIComponent(token)}`, {
    method: "PUT",
    headers: { "Accept-Version": "8", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (resp.status !== 200 && resp.status !== 204) throw new Error(`Vox PUT ${path} failed: ${resp.status}`);
}

// ─── Playlist commands ───────────────────────────────────────

async function cmdPlaylist(args) {
  // Parse flags: -s or --shuffle for shuffle + random start
  const shuffle = args.includes("-s") || args.includes("--shuffle");
  const name = args.replace(/-s|--shuffle/g, "").trim() || "fav";

  info("cmd_playlist", { name, shuffle });
  try {
    const data = await voxGet(`/api/playlist/${encodeURIComponent(name)}`);
    const plPaths = (data.songs || {}).paths || [];

    if (plPaths.length === 0) { console.log(`Playlist "${name}" is empty`); return; }

    await ensureMpv();
    await sendMpvCommand(["playlist-clear"]);

    // Load all tracks (append mode — don't auto-play)
    let loaded = 0;
    for (let i = 0; i < plPaths.length; i++) {
      try {
        const p = plPaths[i];
        const url = await resolveTrackUrl(p);
        await sendMpvCommand(["loadfile", url, "append"]);
        loaded++;
      } catch { /* skip failed tracks */ }
    }

    if (shuffle) {
      await sendMpvCommand(["playlist-shuffle"]);
      const randomIdx = Math.floor(Math.random() * loaded);
      await sendMpvCommand(["playlist-play-index", randomIdx]);
      console.log(`Loaded & shuffled playlist "${name}" (${loaded}/${plPaths.length} tracks)`);
    } else {
      await sendMpvCommand(["playlist-play-index", 0]);
      console.log(`Loaded playlist "${name}" (${loaded}/${plPaths.length} tracks)`);
    }

    setTimeout(() => pushCoverArt(), 500);

    const np = await mpvNowPlaying();
    if (np && np.title) {
      if (np.artist) console.log(`Playing: ${np.artist} — ${np.title}`);
      else console.log(`Playing: ${np.title}`);
    }
  } catch (err) {
    console.error(`Failed to load playlist: ${err.message}`);
  }
}

async function cmdShuffle() {
  info("cmd_shuffle");
  await ensureMpv();
  try {
    await sendMpvCommand(["playlist-shuffle"]);
    const entries = await mpvPlaylistEntries();
    console.log(`Shuffled ${entries.length} tracks`);
  } catch (err) {
    console.error(`Failed to shuffle: ${err.message}`);
  }
}

async function cmdPlaylistAdd(query) {
  info("cmd_pl-add", { query });
  if (!query) { console.log("Usage: vox-cli pl-add <query>"); return; }
  const results = searchScored(query);
  if (results.length === 0) { console.log(`No results for "${query}"`); return; }

  const best = results[0];
  const voxPath = `${VOX_MOUNT}/${path.relative(MUSIC_DIR, best.filepath)}`;

  try {
    const playlistName = "fav";
    let currentTracks = [];
    try {
      const data = await voxGet(`/api/playlist/${playlistName}`);
      currentTracks = (data.songs || {}).paths || [];
    } catch {}
    if (currentTracks.includes(voxPath)) {
      console.log(`Already in playlist: ${best.artist} — ${best.title}`);
      return;
    }
    await voxPut(`/api/playlist/${playlistName}`, { tracks: [...currentTracks, voxPath] });
    console.log(`Added to playlist: ${best.artist} — ${best.title}`);
  } catch (err) {
    console.error(`Failed to add to playlist: ${err.message}`);
  }
}

async function cmdPlaylistRemove(query) {
  info("cmd_pl-remove", { query });
  if (!query) { console.log("Usage: vox-cli pl-remove <query>"); return; }
  try {
    const playlistName = "fav";
    const data = await voxGet(`/api/playlist/${playlistName}`);
    const plPaths = (data.songs || {}).paths || [];
    const matching = plPaths.filter((p) => p.toLowerCase().includes(query.toLowerCase()));
    if (matching.length === 0) { console.log(`No matching tracks for "${query}" in playlist`); return; }
    const newTracks = plPaths.filter((p) => !matching.includes(p));
    await voxPut(`/api/playlist/${playlistName}`, { tracks: newTracks });
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
  info("dispatch", { cmd, args: rest });

  if (!fs.existsSync(MUSIC_DIR)) {
    console.error(`Music directory not found: ${MUSIC_DIR}`);
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
      case "sysvol": await cmdSysvol(parseInt(rest[0], 10)); break;
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
