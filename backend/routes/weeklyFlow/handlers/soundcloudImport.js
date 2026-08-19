import { randomUUID } from "crypto";
import { ytdlpClient } from "../../../services/ytdlpClient.js";
import { weeklyFlowOperationQueue } from "../../../services/weeklyFlow/weeklyFlowOperationQueue.js";
import { getAccessibleSharedPlaylist } from "./utils.js";

function sendImportError(res, error, fallback) {
  if (error?.code === "SHARED_PLAYLIST_NAME_CONFLICT") {
    return res.status(409).json({
      error: "Playlist name already exists",
      message: error.message,
    });
  }
  const statusCode = Number(error?.statusCode);
  return res.status(Number.isInteger(statusCode) ? statusCode : 500).json({
    error: fallback,
    message: error?.message || fallback,
  });
}

export function registerSoundcloudImport(router) {
  router.post("/import/soundcloud/preview", async (req, res) => {
    try {
      const track = await ytdlpClient.inspectSoundcloudUrl(req.body?.url);
      return res.json({ track });
    } catch (error) {
      return sendImportError(res, error, "Failed to inspect SoundCloud track");
    }
  });

  router.post("/import/soundcloud", async (req, res) => {
    try {
      const track = await ytdlpClient.inspectSoundcloudUrl(req.body?.url);
      const destinationPlaylistId = String(req.body?.destinationPlaylistId || "").trim();
      let playlistId = destinationPlaylistId;
      let operation;

      if (destinationPlaylistId) {
        const playlist = getAccessibleSharedPlaylist(req.user, destinationPlaylistId);
        if (!playlist) {
          return res.status(404).json({ error: "Shared playlist not found" });
        }
        operation = await weeklyFlowOperationQueue.enqueuePayload({
          kind: "shared-playlist-append-tracks",
          label: `shared-playlist:${destinationPlaylistId}:tracks:add`,
          playlistId: destinationPlaylistId,
          tracks: [track],
        });
      } else {
        const name = String(req.body?.name || "").trim();
        if (!name) {
          return res.status(400).json({ error: "name is required" });
        }
        playlistId = randomUUID();
        operation = await weeklyFlowOperationQueue.enqueuePayload({
          kind: "shared-playlist-create",
          label: "shared-playlist:create",
          playlistId,
          name,
          sourceName: "SoundCloud",
          tracks: [track],
          ownerUserId: req.user.id,
        });
      }

      return res.json({
        success: true,
        queued: true,
        playlistId,
        operationId: operation.operationId,
        track,
      });
    } catch (error) {
      return sendImportError(res, error, "Failed to import SoundCloud track");
    }
  });
}
