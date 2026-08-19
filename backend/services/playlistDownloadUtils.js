import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { parseFile } from "music-metadata";

const execFileAsync = promisify(execFile);

export function sanitizePathPart(value, fallback = "Unknown") {
  const text = String(value || "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  return text || fallback;
}

export function normalizePositiveInteger(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const normalized = Math.floor(Number(value));
  return normalized > 0 ? normalized : null;
}

export function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

export function parseStringListJson(value) {
  if (!value) return [];
  try {
    return normalizeStringList(JSON.parse(value));
  } catch {
    return [];
  }
}

export function stringifyStringListJson(value) {
  const normalized = normalizeStringList(value);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

export function buildResolvedPlaylistTrack(job, payloadTrack = {}) {
  const track = payloadTrack && typeof payloadTrack === "object" ? payloadTrack : {};
  return {
    artistName: job.artistName || track.artistName,
    trackName: job.trackName || track.trackName,
    albumName: job.albumName || track.albumName,
    artistMbid: job.artistMbid || track.artistMbid,
    albumMbid: job.albumMbid || track.albumMbid,
    trackMbid: job.trackMbid || track.trackMbid,
    releaseYear: job.releaseYear || track.releaseYear,
    durationMs: job.durationMs ?? track.durationMs ?? null,
    sourceProvider: job.sourceProvider || track.sourceProvider || null,
    sourceId: job.sourceId || track.sourceId || null,
    sourceUrl: job.sourceUrl || track.sourceUrl || null,
    trackNumber: normalizePositiveInteger(job.trackNumber ?? track.trackNumber),
    albumTrackCount: normalizePositiveInteger(job.albumTrackCount ?? track.albumTrackCount),
    albumTrackTitles: normalizeStringList(
      (job.albumTrackTitles?.length ? job.albumTrackTitles : null) || track.albumTrackTitles,
    ),
    artistAliases:
      Array.isArray(job.artistAliases) && job.artistAliases.length
        ? job.artistAliases
        : normalizeStringList(track.artistAliases),
  };
}

export function resolveBlockedJobSourceFilename(job) {
  const remote = String(job?.remoteFilename || "").trim();
  if (remote) return remote;
  const staging = String(job?.stagingPath || "").trim();
  if (!staging) return null;
  return path.basename(staging) || null;
}

export function joinUnderRoot(root, relativePath, fileName = null) {
  const parts = String(relativePath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (fileName) {
    parts.push(fileName);
  }
  return path.join(root, ...parts);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveAvailableTargetPath(targetPath) {
  if (!(await fileExists(targetPath))) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base} (${index})${ext}`);
    if (!(await fileExists(candidate))) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

export async function commitImportToPlaylistLibrary(sourcePath, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return targetPath;
  }
  const resolvedTarget = await resolveAvailableTargetPath(targetPath);
  try {
    await fs.rename(sourcePath, resolvedTarget);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    const tempTarget = path.join(
      path.dirname(resolvedTarget),
      `.aurral-import-${process.pid}-${Date.now()}-${path.basename(resolvedTarget)}.tmp`,
    );
    await fs.copyFile(sourcePath, tempTarget);
    const [sourceStat, tempStat] = await Promise.all([fs.stat(sourcePath), fs.stat(tempTarget)]);
    if (sourceStat.size !== tempStat.size) {
      await fs.rm(tempTarget, { force: true }).catch(() => {});
      throw new Error("Imported file copy did not match source size");
    }
    await fs.rename(tempTarget, resolvedTarget);
    await fs.rm(sourcePath, { force: true });
  }
  return resolvedTarget;
}

export async function writeAudioMetadata(filePath, metadata = {}) {
  const sourcePath = path.resolve(filePath);
  const ext = path.extname(sourcePath) || ".m4a";
  const taggedPath = path.join(
    path.dirname(sourcePath),
    `.${path.basename(sourcePath, ext)}.${process.pid}-${Date.now()}.tagged${ext}`,
  );
  const tags = [
    ["title", metadata.trackName],
    ["artist", metadata.artistName],
    ["album_artist", metadata.artistName],
    ["album", metadata.albumName],
    ["date", metadata.releaseYear],
    ["track", normalizePositiveInteger(metadata.trackNumber)],
  ].filter(([, value]) => value != null && String(value).trim());
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0",
    "-c",
    "copy",
  ];
  for (const [key, value] of tags) {
    args.push("-metadata", `${key}=${String(value).trim()}`);
  }
  args.push(taggedPath);
  try {
    await execFileAsync("ffmpeg", args, { timeout: 120000 });
    await fs.rename(taggedPath, sourcePath);
    return sourcePath;
  } catch (error) {
    await fs.rm(taggedPath, { force: true }).catch(() => {});
    const detail = String(error?.stderr || error?.message || error)
      .trim()
      .slice(-500);
    throw new Error(`Failed to write audio metadata: ${detail}`);
  }
}

export async function repairYtdlpMetadata(jobs = []) {
  const result = { scanned: 0, repaired: 0, failed: 0 };
  const seen = new Set();
  for (const job of jobs) {
    if (
      job?.status !== "done" ||
      job?.downloadClient !== "ytdlp" ||
      path.extname(job?.finalPath || "").toLowerCase() !== ".m4a"
    ) {
      continue;
    }
    const filePath = path.resolve(job.finalPath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    result.scanned += 1;
    try {
      const { common } = await parseFile(filePath, { skipCovers: true });
      const expected = [
        [common.title, job.trackName],
        [common.artist, job.artistName],
        [common.albumartist, job.artistName],
        [common.album, job.albumName],
      ].filter(([, value]) => String(value || "").trim());
      if (
        expected.every(([actual, value]) => String(actual || "").trim() === String(value).trim())
      ) {
        continue;
      }
      await writeAudioMetadata(filePath, job);
      result.repaired += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
