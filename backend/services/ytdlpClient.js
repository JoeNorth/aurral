import { spawn } from "child_process";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { dbOps } from "../db/helpers/index.js";
import { resolveYtdlpStagingRoot } from "./downloadFolderConfig.js";

const DEFAULT_BINARY = "yt-dlp";
const SEARCH_LIMIT = 5;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const AUDIO_FORMAT = "m4a";
const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "snd.sc"]);

function createInputError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function normalizeSoundcloudUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw createInputError("SoundCloud track URL is required");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw createInputError("Enter a valid SoundCloud track URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  const soundcloudHost = SOUNDCLOUD_HOSTS.has(hostname) || hostname.endsWith(".soundcloud.com");
  if (parsed.protocol !== "https:" || !soundcloudHost) {
    throw createInputError("Only HTTPS SoundCloud URLs are supported");
  }
  parsed.hash = "";
  return parsed.toString();
}

function readReleaseYear(metadata) {
  const date = String(metadata?.release_date || metadata?.upload_date || "").trim();
  const match = /^(\d{4})/.exec(date);
  return match?.[1] || null;
}

export function parseSoundcloudTrackMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw createInputError("SoundCloud returned invalid track metadata", 422);
  }
  if (Array.isArray(metadata.entries) || metadata._type === "playlist") {
    throw createInputError("Enter a SoundCloud track URL, not a playlist or profile", 422);
  }
  const extractor = String(metadata.extractor_key || metadata.extractor || "").toLowerCase();
  if (!extractor.startsWith("soundcloud")) {
    throw createInputError("The URL did not resolve to a SoundCloud track", 422);
  }
  const sourceUrl = normalizeSoundcloudUrl(metadata.webpage_url || metadata.original_url);
  const sourceId = String(metadata.id || "").trim();
  const trackName = String(metadata.title || "").trim();
  const artistName = String(
    metadata.artist || metadata.creator || metadata.uploader || metadata.channel || "",
  ).trim();
  if (!sourceId || !trackName || !artistName) {
    throw createInputError("SoundCloud track metadata is incomplete", 422);
  }
  const durationSec = Number(metadata.duration);
  return {
    artistName,
    trackName,
    albumName: String(metadata.album || "").trim() || null,
    releaseYear: readReleaseYear(metadata),
    durationMs:
      Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec * 1000) : null,
    artworkUrl: String(metadata.thumbnail || "").trim() || null,
    sourceProvider: "soundcloud",
    sourceId,
    sourceUrl,
  };
}

function getSettings() {
  return dbOps.getSettings()?.integrations?.ytdlp || {};
}

function getBinaryPath() {
  return DEFAULT_BINARY;
}

export function isYtdlpEnabled() {
  return getSettings().enabled !== false;
}

function resolveBinaryExists(binary) {
  const candidates = path.isAbsolute(binary)
    ? [binary]
    : String(process.env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, binary));
  return candidates.some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function isConfigured() {
  return isYtdlpEnabled() && resolveBinaryExists(getBinaryPath());
}

function runYtdlp(args, { timeoutMs = 120000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(getBinaryPath(), args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = String(stderr || stdout || "")
          .trim()
          .slice(-500);
        reject(new Error(detail || `yt-dlp exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function testConnection({ force: _force = false } = {}) {
  if (!isYtdlpEnabled()) {
    return { configured: false, ok: false, message: "yt-dlp is disabled" };
  }
  const binary = getBinaryPath();
  if (!resolveBinaryExists(binary)) {
    return {
      configured: false,
      ok: false,
      message: `yt-dlp binary not found (${binary}). Install yt-dlp and ffmpeg.`,
    };
  }
  try {
    const { stdout } = await runYtdlp(["--version"], { timeoutMs: 15000 });
    const version =
      String(stdout || "")
        .trim()
        .split(/\s+/)[0] || "ok";
    return { configured: true, ok: true, version, message: `yt-dlp ${version}` };
  } catch (error) {
    return { configured: true, ok: false, message: error?.message || String(error) };
  }
}

export async function search(query, { limit = SEARCH_LIMIT } = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];
  const capped = Math.min(Math.max(Number(limit) || SEARCH_LIMIT, 1), 10);
  const { stdout } = await runYtdlp(
    [
      "--flat-playlist",
      "--dump-json",
      "--no-download",
      "--no-warnings",
      `ytsearch${capped}:${trimmed}`,
    ],
    { timeoutMs: 60000 },
  );
  const results = [];
  for (const line of String(stdout || "").split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    try {
      const entry = JSON.parse(raw);
      const id = String(entry.id || entry.url || "").trim();
      if (!id) continue;
      results.push({
        id,
        title: String(entry.title || "").trim(),
        url:
          String(entry.webpage_url || entry.url || "").trim() ||
          `https://www.youtube.com/watch?v=${id}`,
        channel: String(entry.channel || entry.uploader || "").trim(),
        durationSec:
          Number.isFinite(Number(entry.duration)) && Number(entry.duration) > 0
            ? Number(entry.duration)
            : null,
        liveStatus: String(entry.live_status || "")
          .trim()
          .toLowerCase(),
      });
    } catch {}
  }
  return results;
}

export async function inspectSoundcloudUrl(value) {
  if (!isConfigured()) {
    throw createInputError("yt-dlp is not configured", 503);
  }
  const url = normalizeSoundcloudUrl(value);
  let stdout;
  try {
    ({ stdout } = await runYtdlp(
      ["--dump-single-json", "--no-download", "--no-playlist", "--no-warnings", "--", url],
      { timeoutMs: 60000 },
    ));
  } catch (error) {
    const wrapped = createInputError(error?.message || "Failed to inspect SoundCloud track", 422);
    wrapped.cause = error;
    throw wrapped;
  }
  try {
    return parseSoundcloudTrackMetadata(JSON.parse(String(stdout || "").trim()));
  } catch (error) {
    if (error?.statusCode) throw error;
    throw createInputError("SoundCloud returned invalid track metadata", 422);
  }
}

function resolveStagingDir(jobId) {
  return path.join(
    resolveYtdlpStagingRoot(getSettings().stagingPath),
    "ytdlp",
    String(jobId || "unknown"),
  );
}

async function findDownloadedAudio(dir) {
  const entries = await fsPromises.readdir(dir).catch(() => []);
  const audioExt = new Set([".m4a", ".mp3", ".opus", ".flac", ".ogg", ".webm", ".wav"]);
  for (const name of entries) {
    const full = path.join(dir, name);
    if (!audioExt.has(path.extname(name).toLowerCase())) continue;
    const stat = await fsPromises.stat(full).catch(() => null);
    if (stat?.isFile() && stat.size > 0) return full;
  }
  return null;
}

export async function downloadAudio(videoUrl, { jobId } = {}) {
  const url = String(videoUrl || "").trim();
  if (!url) throw new Error("Missing yt-dlp download URL");
  const stagingDir = resolveStagingDir(jobId);
  await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  await fsPromises.mkdir(stagingDir, { recursive: true });
  const outTemplate = path.join(stagingDir, "%(id)s.%(ext)s");
  try {
    await runYtdlp(
      [
        "--no-playlist",
        "--no-warnings",
        "-x",
        "--audio-format",
        AUDIO_FORMAT,
        "--audio-quality",
        "0",
        "-o",
        outTemplate,
        "--",
        url,
      ],
      { timeoutMs: DOWNLOAD_TIMEOUT_MS, cwd: stagingDir },
    );
  } catch (error) {
    await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const filePath = await findDownloadedAudio(stagingDir);
  if (!filePath) {
    await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw new Error("yt-dlp finished without an audio file");
  }
  return { filePath, stagingDir };
}

export async function cleanupStaging(jobId) {
  await fsPromises.rm(resolveStagingDir(jobId), { recursive: true, force: true }).catch(() => {});
}

export const ytdlpClient = {
  isConfigured,
  isEnabled: isYtdlpEnabled,
  testConnection,
  search,
  inspectSoundcloudUrl,
  downloadAudio,
  cleanupStaging,
};
