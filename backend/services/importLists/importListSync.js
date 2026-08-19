import { flowPlaylistConfig } from "../weeklyFlow/weeklyFlowPlaylistConfig.js";
import { spotifyClient } from "../spotify/spotifyClient.js";
import { parseSpotifyPlaylistItems } from "./spotifyTracks.js";
import { appleMusicClient } from "../appleMusic/appleMusicService.js";
import { parseAppleMusicResources } from "./appleMusicTracks.js";
import { appendSharedPlaylistTracks } from "../weeklyFlow/weeklyFlowOperations.js";

const HOUR_MS = 60 * 60 * 1000;

export function isImportSourceDue(importSource, now = Date.now()) {
  if (!importSource?.syncEnabled) return false;
  const intervalHours = Number(importSource.syncIntervalHours);
  const intervalMs =
    Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours * HOUR_MS : 24 * HOUR_MS;
  const lastSyncAt = Number(importSource.lastSyncAt || 0);
  return !lastSyncAt || now - lastSyncAt >= intervalMs;
}
async function loadImportTracks(importSource, ownerUserId) {
  const provider = String(importSource?.provider || "").trim();
  if (provider === "spotify-playlist") {
    const externalPlaylistId = String(importSource?.externalId || "").trim();
    const items = await spotifyClient.listPlaylistTracks(ownerUserId, externalPlaylistId, {
      forceRefresh: true,
    });
    return parseSpotifyPlaylistItems(items).tracks;
  }
  if (provider.startsWith("apple-music-")) {
    const selection = await appleMusicClient.getImportSource(ownerUserId, importSource);
    return parseAppleMusicResources(selection.resources).tracks;
  }
  const error = new Error(`Unsupported playlist import provider: ${provider || "unknown"}`);
  error.statusCode = 400;
  throw error;
}

export async function syncSharedPlaylistImport({ playlistId, user, force = false } = {}) {
  const playlist = flowPlaylistConfig.getSharedPlaylist(playlistId);
  if (!playlist?.importSource) {
    return { skipped: true, reason: "no-import-source" };
  }
  if (!force && !isImportSourceDue(playlist.importSource)) {
    return { skipped: true, reason: "not-due" };
  }
  if (!flowPlaylistConfig.canUserAccessSharedPlaylist(user, playlist)) {
    const error = new Error("Playlist not found");
    error.statusCode = 404;
    throw error;
  }
  const ownerUserId = playlist.ownerUserId ?? user?.id;
  try {
    const tracks = await loadImportTracks(playlist.importSource, ownerUserId);
    const result = await appendSharedPlaylistTracks({ playlistId: playlist.id, tracks });
    const nextImportSource = {
      ...playlist.importSource,
      lastSyncAt: Date.now(),
      lastSyncError: null,
      lastSyncTrackCount: tracks.length,
    };
    flowPlaylistConfig.updateSharedPlaylist(playlist.id, {
      importSource: nextImportSource,
    });
    return {
      skipped: false,
      trackCount: tracks.length,
      tracksQueued: Number(result?.tracksQueued || 0),
      tracksReused: Number(result?.tracksReused || 0),
    };
  } catch (error) {
    flowPlaylistConfig.updateSharedPlaylist(playlist.id, {
      importSource: {
        ...playlist.importSource,
        lastSyncError: String(error?.message || "Playlist sync failed"),
      },
    });
    throw error;
  }
}

export async function runDueImportSourceSyncs() {
  const playlists = flowPlaylistConfig.getSharedPlaylists();
  const results = [];
  for (const playlist of playlists) {
    if (!playlist?.importSource?.syncEnabled) continue;
    if (!isImportSourceDue(playlist.importSource)) continue;
    const ownerUserId = playlist.ownerUserId;
    if (ownerUserId == null) continue;
    try {
      const result = await syncSharedPlaylistImport({
        playlistId: playlist.id,
        user: { id: ownerUserId },
      });
      results.push({ playlistId: playlist.id, ...result });
    } catch (error) {
      results.push({
        playlistId: playlist.id,
        error: String(error?.message || "Playlist sync failed"),
      });
    }
  }
  return results;
}
