import { randomUUID } from "crypto";
import { appleMusicClient } from "../../../services/appleMusic/appleMusicService.js";
import {
  getAppleMusicDeveloperToken,
  getAppleMusicPublicConfiguration,
} from "../../../services/appleMusic/appleMusicConfig.js";
import { appleMusicConnectionStore } from "../../../services/appleMusic/appleMusicConnectionStore.js";
import { parseAppleMusicResources } from "../../../services/importLists/appleMusicTracks.js";
import { normalizeImportSource } from "../../../services/weeklyFlow/weeklyFlowPlaylistConfig.js";
import { weeklyFlowOperationQueue } from "../../../services/weeklyFlow/weeklyFlowOperationQueue.js";

const sendError = (res, error, fallback, statusCode = 500) =>
  res.status(error?.statusCode || statusCode).json({
    error: fallback,
    message: error?.message || "Unknown error",
  });

async function loadSelection(userId, body = {}) {
  const kind = String(body?.kind || "").trim();
  if (kind === "catalog-playlist") {
    return appleMusicClient.getPublicPlaylist(body?.url);
  }
  if (kind === "library") {
    return appleMusicClient.getLibrarySongs(userId);
  }
  if (kind === "library-playlist") {
    return appleMusicClient.getLibraryPlaylist(userId, body?.playlistId);
  }
  const error = new Error("Select an Apple Music playlist or library");
  error.statusCode = 400;
  throw error;
}

const summarizeSelection = (selection) => {
  const { tracks, stats } = parseAppleMusicResources(selection?.resources);
  return {
    name: selection?.name || "Apple Music",
    artworkUrl: selection?.artworkUrl || null,
    source: selection?.source || null,
    tracks,
    skipped: stats.unsupported + stats.incomplete + stats.duplicate,
  };
};

export function registerAppleMusicImport(router) {
  router.get("/import/apple-music/status", (req, res) => {
    res.json({
      ...getAppleMusicPublicConfiguration(),
      ...appleMusicConnectionStore.getPublicStatus(req.user.id),
    });
  });

  router.get("/import/apple-music/developer-token", (req, res) => {
    try {
      res.json({ developerToken: getAppleMusicDeveloperToken() });
    } catch (error) {
      sendError(res, error, "Apple Music is not configured", 503);
    }
  });

  router.post("/import/apple-music/connect", async (req, res) => {
    try {
      const status = await appleMusicClient.connect(req.user.id, req.body?.musicUserToken);
      res.json(status);
    } catch (error) {
      sendError(res, error, "Failed to connect Apple Music");
    }
  });

  router.delete("/import/apple-music", (req, res) => {
    appleMusicConnectionStore.clearConnection(req.user.id);
    res.json({ connected: false, storefront: null, connectedAt: null });
  });

  router.get("/import/apple-music/playlists", async (req, res) => {
    try {
      res.json(await appleMusicClient.listLibraryPlaylists(req.user.id));
    } catch (error) {
      sendError(res, error, "Failed to fetch Apple Music playlists");
    }
  });

  router.post("/import/apple-music/preview", async (req, res) => {
    try {
      const summary = summarizeSelection(await loadSelection(req.user.id, req.body));
      res.json({
        name: summary.name,
        artworkUrl: summary.artworkUrl,
        source: summary.source,
        trackCount: summary.tracks.length,
        skipped: summary.skipped,
        previewTracks: summary.tracks.slice(0, 3),
      });
    } catch (error) {
      sendError(res, error, "Failed to preview Apple Music import");
    }
  });

  router.post("/import/apple-music", async (req, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      if (!name) {
        return res.status(400).json({ error: "name is required" });
      }
      const selection = summarizeSelection(await loadSelection(req.user.id, req.body));
      if (selection.tracks.length === 0) {
        return res.status(400).json({ error: "Apple Music returned no importable songs" });
      }
      const syncIntervalHours = Number(req.body?.syncIntervalHours ?? 24);
      const syncEnabled = req.body?.syncEnabled === false ? false : syncIntervalHours > 0;
      const playlistId = randomUUID();
      const importSource = normalizeImportSource({
        ...selection.source,
        externalName: selection.name,
        syncEnabled,
        syncIntervalHours: syncEnabled ? syncIntervalHours : 0,
        lastSyncAt: Date.now(),
        lastSyncTrackCount: selection.tracks.length,
      });
      const result = await weeklyFlowOperationQueue.enqueuePayload({
        kind: "shared-playlist-create",
        label: "shared-playlist:create",
        playlistId,
        name,
        sourceName: "Apple Music",
        tracks: selection.tracks,
        ownerUserId: req.user.id,
        importSource,
      });
      res.json({
        success: true,
        playlist: result?.playlist || null,
        tracksQueued: Number(result?.tracksQueued || 0),
        tracksReused: Number(result?.tracksReused || 0),
        queued: result?.queued === true,
      });
    } catch (error) {
      if (error?.code === "SHARED_PLAYLIST_NAME_CONFLICT") {
        return res.status(409).json({
          error: "Playlist name already exists",
          message: error.message,
        });
      }
      sendError(res, error, "Failed to import Apple Music");
    }
  });
}
