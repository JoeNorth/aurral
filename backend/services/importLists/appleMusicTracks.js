import {
  buildSharedTrackIdentity,
  normalizeSharedTrack,
} from "../weeklyFlow/weeklyFlowPlaylistConfig.js";

const SONG_TYPES = new Set(["songs", "library-songs"]);

const releaseYearFrom = (value) => {
  const match = String(value || "").match(/^(\d{4})/);
  return match?.[1] || null;
};

export function parseAppleMusicResources(resources = []) {
  const stats = {
    unsupported: 0,
    incomplete: 0,
    duplicate: 0,
  };
  const tracks = [];
  const seen = new Set();

  for (const resource of Array.isArray(resources) ? resources : []) {
    if (!SONG_TYPES.has(String(resource?.type || ""))) {
      stats.unsupported += 1;
      continue;
    }
    const attributes = resource?.attributes || {};
    const artistName = String(attributes.artistName || "").trim();
    const trackName = String(attributes.name || "").trim();
    if (!artistName || !trackName) {
      stats.incomplete += 1;
      continue;
    }
    const sourceId = String(attributes?.playParams?.catalogId || resource?.id || "").trim();
    const track = normalizeSharedTrack({
      artistName,
      trackName,
      albumName: String(attributes.albumName || "").trim() || null,
      releaseYear: releaseYearFrom(attributes.releaseDate),
      durationMs: attributes.durationInMillis,
      sourceProvider: "apple-music",
      sourceId: sourceId || null,
      sourceUrl: String(attributes.url || "").trim() || null,
    });
    if (!track) {
      stats.incomplete += 1;
      continue;
    }
    const identity = buildSharedTrackIdentity(track);
    if (seen.has(identity)) {
      stats.duplicate += 1;
      continue;
    }
    seen.add(identity);
    tracks.push(track);
  }

  return { tracks, stats };
}
