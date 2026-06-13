-- mpv cover-on-load hook + logger
-- Hooks into on_load to download + set cover-art-files BEFORE the file loads.
-- Also writes player.log so the JS watcher is no longer needed.
--
-- ## Why a Lua script? (not Node.js IPC)
--
-- Bug: mpv reads cover-art-files at file-load time. The Node.js watcher set it
-- in response to property-change "path", which fires AFTER mpv has already read
-- cover-art-files. Result: cover always lagged by 1 track.
--
-- Fix: mpv's on_load hook pauses file loading. This script runs in the hook,
-- downloads the cover (auth -> thumbnail API -> save), sets cover-art-files, then
-- returns (auto ack). mpv reads the correct cover when it continues loading.
--
-- User's manual echo command works because cover-art-files is sticky -- setting it
-- before the skip means mpv reads the OLD cover, then the hook replaces it for the
-- NEW track. The hook guarantees the right cover for every track change.

local PLAYER_DIR = "/tmp/vox-player/"
local LOG_PATH = PLAYER_DIR .. "player.log"
local VOX_URL = "http://192.168.100.1:5050"
local LOG_SEPARATOR = string.rep("─", 40)

-- Helper: append a line to player.log with consistent format
-- Format: [YYYY-MM-DD HH:mm:ss] [LEVEL ] message
function log(level, msg, extra)
    local ts = os.date("%Y-%m-%d %H:%M:%S")
    -- Pad level to 5 chars (e.g. "INFO " / "WARN ")
    local padded = level .. string.rep(" ", 6 - #level)
    local line = "[" .. ts .. "] [" .. padded .. "] " .. msg
    if extra then line = line .. "  " .. tostring(extra) end
    local f = io.open(LOG_PATH, "a")
    if f then f:write(line .. "\n"); f:close() end
end

-- URL decode percent-encoded characters and strip auth tokens from URLs
function url_decode(str)
    if not str then return "" end
    local decoded = str:gsub("%%(%x%x)", function(hex) return string.char(tonumber(hex, 16)) end)
    -- Remove auth_token parameter entirely
    decoded = decoded:gsub("[?&]auth_token=[^&]*", function(m)
        if m:sub(1, 1) == "?" then return "?" else return "" end
    end)
    decoded = decoded:gsub("%?&", "?")
    decoded = decoded:gsub("%?$", "")
    return decoded
end

-- Run a shell command and return stdout
function cmd_output(cmd)
    local handle = io.popen(cmd, "r")
    if not handle then return "" end
    local result = handle:read("*a")
    handle:close()
    return result
end

-- Minimal URL encoding (chars that actually appear in vox paths)
function url_encode(str)
    return str:gsub("([^%w%.%-_~ ])", function(c)
        return string.format("%%%02X", c:byte())
    end):gsub(" ", "%%20")
end

-- Extract vox path from a JDC audio URL
function extract_vox_path(url)
    if not url then return nil end
    local _, _, path = url:find("/audio/(.+)$")
    if path then
        -- Strip query string (auth_token etc.)
        path = path:gsub("%?.*$", "")
        -- URL-decode percent-encoded chars
        path = path:gsub("%%(%x%x)", function(hex) return string.char(tonumber(hex, 16)) end)
        return path
    end
    return nil
end

-- Generate cover filename (matches old format for cache compatibility)
function cover_tmp_path(local_path)
    local base = local_path:match("[^/]+$")
    if not base then return nil end
    local name_no_ext = base:gsub("%.[^%.]+$", "")
    local safe = name_no_ext:gsub("[/\\:*?\"<>|]", "_")
    return PLAYER_DIR .. "cover-" .. safe .. ".jpg"
end

-- Called when on_load hook fires (mpv pauses file loading)
function on_load()
    local url = mp.get_property("path")
    if not url then return end

    local vox_path = extract_vox_path(url)
    if not vox_path then
        log("WARN", "Could not extract vox path, skipping cover", url)
        return
    end

    local cover_path = cover_tmp_path(vox_path)
    if not cover_path then
        log("WARN", "Could not generate cover path for", vox_path)
        return
    end

    -- Log track change
    log("INFO", LOG_SEPARATOR)
    log("INFO", "on_load hook: loading", url_decode(url))

    -- Cache hit: just set cover-art-files
    local f = io.open(cover_path, "r")
    if f then
        f:close()
        mp.set_property("cover-art-files", cover_path)
        log("INFO", "Cover set (cache)", cover_path)
        return
    end

    log("INFO", "Cover download initiated for", vox_path)
    os.execute("mkdir -p " .. PLAYER_DIR)

    -- Step 1: auth with Vox API
    local auth_cmd = 'curl -s -X POST -H "Content-Type: application/json" -d '
        .. "'" .. '{"username":"admin","password":"admin"}' .. "'"
        .. " " .. VOX_URL .. "/api/auth"
    local auth_out = cmd_output(auth_cmd)
    local _, _, token = auth_out:find('"token"%s*:%s*"([^"]+)"')
    if not token then
        log("ERROR", "Auth failed for cover download", vox_path)
        return
    end

    -- Step 2: download thumbnail
    local enc_path = url_encode(vox_path)
    local enc_token = url_encode(token)
    local dl_url = VOX_URL .. "/api/thumbnail/" .. enc_path
        .. "?size=small&pad=false&auth_token=" .. enc_token
    local dl_cmd = 'curl -s -o "' .. cover_path .. '" "' .. dl_url .. '"'
    os.execute(dl_cmd)

    -- Step 3: check file size
    local stat_cmd = "stat -f%z '" .. cover_path:gsub("'", "'\\''") .. "' 2>/dev/null"
    local stat = cmd_output(stat_cmd)
    local size = tonumber(stat)

    if not size or size <= 100 then
        log("WARN", "Cover download too small (" .. (size or 0) .. " bytes), skipped", vox_path)
        os.execute("rm -f '" .. cover_path:gsub("'", "'\\''") .. "'")
        return
    end

    log("INFO", "Cover downloaded", size .. " bytes -> " .. cover_path)

    -- Step 4: set cover-art-files (blocks mpv; hook auto-acks on return)
    mp.set_property("cover-art-files", cover_path)
    log("INFO", "Cover set via on_load hook", cover_path)
end

-- ─── Event listeners ──────────────────────────────

-- on_load hook: blocks file loading until cover is ready
mp.add_hook("on_load", 0, on_load)

-- file-loaded: log music playing
mp.register_event("file-loaded", function()
    log("INFO", "music playing")
end)

-- ─── Media key: Play ──────────────────────────────
-- When mpv is idle: load fav playlist shuffled and play.
-- When a track is loaded: toggle pause (default behavior).

local PLAY_FAV_SCRIPT = "/Users/kt/code/vox/cli/play-fav.sh"

mp.add_key_binding("Play", "play-fav", function()
    local path = mp.get_property("path")
    if not path or path == "" then
        log("INFO", "Play key: no file loaded, starting fav playlist")
        mp.commandv("run", PLAY_FAV_SCRIPT)
    else
        mp.set_property("pause", not mp.get_property_bool("pause"))
    end
end)

-- ─── Startup ──────────────────────────────────────

local ok_f = io.open(PLAYER_DIR .. ".lua-hook-ok", "w")
if ok_f then ok_f:write("loaded\n"); ok_f:close() end
log("INFO", "Cover hook registered (on_load)")
