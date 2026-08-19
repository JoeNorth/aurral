import { getAppleMusicDeveloperToken } from "./appleMusicConfig.js";

export const APPLE_MUSIC_API_BASE = "https://api.music.apple.com";
const REQUEST_TIMEOUT_MS = 30 * 1000;

const safeJson = (value) => {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
};

function resolveAppleApiUrl(path) {
  const url = new URL(String(path || ""), APPLE_MUSIC_API_BASE);
  if (url.protocol !== "https:" || url.origin !== APPLE_MUSIC_API_BASE) {
    throw new Error("Apple Music returned an invalid pagination URL");
  }
  return url;
}

export function parseAppleMusicPlaylistUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    const error = new Error("Enter a valid Apple Music playlist URL");
    error.statusCode = 400;
    throw error;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "music.apple.com") {
    const error = new Error("Only HTTPS music.apple.com playlist URLs are supported");
    error.statusCode = 400;
    throw error;
  }
  const segments = url.pathname
    .split("/")
    .map((segment) => decodeURIComponent(segment).trim())
    .filter(Boolean);
  const storefront = String(segments[0] || "").toLowerCase();
  const playlistIndex = segments.indexOf("playlist");
  const playlistId = String(segments.at(-1) || "").trim();
  if (!/^[a-z]{2}$/.test(storefront) || playlistIndex < 1 || !playlistId.startsWith("pl.")) {
    const error = new Error("The URL must point to a public Apple Music playlist");
    error.statusCode = 400;
    throw error;
  }
  url.hash = "";
  return {
    storefront,
    playlistId,
    url: url.toString(),
  };
}

const artworkUrlFrom = (artwork) => {
  const template = String(artwork?.url || "").trim();
  return template
    ? template.replace("{w}", "600").replace("{h}", "600").replace("{f}", "jpg")
    : null;
};

export function createAppleMusicClient({
  fetchImpl = globalThis.fetch,
  connectionStore = null,
  getDeveloperToken = getAppleMusicDeveloperToken,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is required");

  async function request(path, { musicUserToken = null, signal = null } = {}) {
    const url = resolveAppleApiUrl(path);
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${getDeveloperToken()}`,
    };
    if (musicUserToken) headers["Music-User-Token"] = musicUserToken;

    let response;
    try {
      response = await fetchImpl(url, {
        headers,
        signal: signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const wrapped = new Error(`Apple Music request failed: ${error.message}`);
      wrapped.statusCode = error?.name === "TimeoutError" ? 504 : 502;
      throw wrapped;
    }
    const raw = await response.text();
    const body = safeJson(raw);
    if (!response.ok) {
      const detail =
        body?.errors?.[0]?.detail ||
        body?.errors?.[0]?.title ||
        body?.error ||
        raw.trim() ||
        `HTTP ${response.status}`;
      const error = new Error(`Apple Music: ${detail}`);
      error.statusCode = response.status;
      throw error;
    }
    return body;
  }

  async function readAllPages(path, options = {}) {
    const resources = [];
    const seen = new Set();
    let next = path;
    while (next) {
      const url = resolveAppleApiUrl(next).toString();
      if (seen.has(url)) throw new Error("Apple Music returned a pagination loop");
      seen.add(url);
      const page = await request(url, options);
      if (Array.isArray(page?.data)) resources.push(...page.data);
      next = page?.next || null;
    }
    return resources;
  }

  async function readRelationship(resource, fallbackPath, options = {}) {
    const relationship = resource?.relationships?.tracks;
    const resources = Array.isArray(relationship?.data) ? [...relationship.data] : [];
    const seen = new Set();
    let next = relationship?.next || (relationship ? null : fallbackPath);
    while (next) {
      const url = resolveAppleApiUrl(next).toString();
      if (seen.has(url)) throw new Error("Apple Music returned a playlist pagination loop");
      seen.add(url);
      const page = await request(url, options);
      if (Array.isArray(page?.data)) resources.push(...page.data);
      next = page?.next || null;
    }
    return resources;
  }

  function requireConnection(userId) {
    const connection = connectionStore.getConnection(userId);
    if (connection?.musicUserToken) return connection;
    const error = new Error("Connect Apple Music before importing your library");
    error.statusCode = 401;
    throw error;
  }

  async function validateUserToken(musicUserToken) {
    const token = String(musicUserToken || "").trim();
    if (!token) {
      const error = new Error("Apple Music user token is required");
      error.statusCode = 400;
      throw error;
    }
    const payload = await request("/v1/me/storefront", { musicUserToken: token });
    const storefront = String(payload?.data?.[0]?.id || "")
      .trim()
      .toLowerCase();
    if (!storefront) {
      const error = new Error("Apple Music returned no storefront for this account");
      error.statusCode = 502;
      throw error;
    }
    return { storefront };
  }

  async function connect(userId, musicUserToken) {
    const { storefront } = await validateUserToken(musicUserToken);
    connectionStore.saveConnection(userId, { musicUserToken, storefront });
    return connectionStore.getPublicStatus(userId);
  }

  async function listLibraryPlaylists(userId) {
    const connection = requireConnection(userId);
    const resources = await readAllPages("/v1/me/library/playlists?limit=100", {
      musicUserToken: connection.musicUserToken,
    });
    return {
      storefront: connection.storefront,
      playlists: resources
        .map((resource) => ({
          id: String(resource?.id || "").trim(),
          name: String(resource?.attributes?.name || "").trim(),
          kind: "library-playlist",
          artworkUrl: artworkUrlFrom(resource?.attributes?.artwork),
        }))
        .filter((playlist) => playlist.id && playlist.name),
    };
  }

  async function getLibrarySongs(userId) {
    const connection = requireConnection(userId);
    const resources = await readAllPages("/v1/me/library/songs?limit=100", {
      musicUserToken: connection.musicUserToken,
    });
    return {
      name: "Apple Music Library",
      resources,
      source: {
        provider: "apple-music-library",
        externalType: "library",
        externalId: "library",
        storefront: connection.storefront,
      },
    };
  }

  async function getLibraryPlaylist(userId, playlistId) {
    const id = String(playlistId || "").trim();
    if (!id) {
      const error = new Error("playlistId is required");
      error.statusCode = 400;
      throw error;
    }
    const connection = requireConnection(userId);
    const options = { musicUserToken: connection.musicUserToken };
    const encodedId = encodeURIComponent(id);
    const payload = await request(`/v1/me/library/playlists/${encodedId}?include=tracks`, options);
    const playlist = payload?.data?.[0];
    if (!playlist) {
      const error = new Error("Apple Music playlist was not found");
      error.statusCode = 404;
      throw error;
    }
    const resources = await readRelationship(
      playlist,
      `/v1/me/library/playlists/${encodedId}/tracks?limit=100`,
      options,
    );
    return {
      name: String(playlist?.attributes?.name || "Apple Music Playlist").trim(),
      artworkUrl: artworkUrlFrom(playlist?.attributes?.artwork),
      resources,
      source: {
        provider: "apple-music-library-playlist",
        externalType: "library-playlist",
        externalId: id,
        storefront: connection.storefront,
      },
    };
  }

  async function getPublicPlaylist(value) {
    const parsed =
      value && typeof value === "object" && value.storefront && value.playlistId
        ? value
        : parseAppleMusicPlaylistUrl(value);
    const storefront = String(parsed.storefront || "")
      .trim()
      .toLowerCase();
    const playlistId = String(parsed.playlistId || "").trim();
    if (!/^[a-z]{2}$/.test(storefront) || !playlistId.startsWith("pl.")) {
      const error = new Error("Invalid Apple Music catalog playlist source");
      error.statusCode = 400;
      throw error;
    }
    const encodedId = encodeURIComponent(playlistId);
    const payload = await request(
      `/v1/catalog/${encodeURIComponent(storefront)}/playlists/${encodedId}?include=tracks`,
    );
    const playlist = payload?.data?.[0];
    if (!playlist) {
      const error = new Error("Apple Music playlist was not found");
      error.statusCode = 404;
      throw error;
    }
    const resources = await readRelationship(
      playlist,
      `/v1/catalog/${encodeURIComponent(storefront)}/playlists/${encodedId}/tracks?limit=100`,
    );
    return {
      name: String(playlist?.attributes?.name || "Apple Music Playlist").trim(),
      artworkUrl: artworkUrlFrom(playlist?.attributes?.artwork),
      resources,
      source: {
        provider: "apple-music-catalog-playlist",
        externalType: "catalog-playlist",
        externalId: playlistId,
        externalName: String(playlist?.attributes?.name || "").trim() || null,
        externalUrl: parsed.url || String(playlist?.attributes?.url || "").trim() || null,
        storefront,
      },
    };
  }

  async function getImportSource(userId, source) {
    const provider = String(source?.provider || "").trim();
    if (provider === "apple-music-library") return getLibrarySongs(userId);
    if (provider === "apple-music-library-playlist") {
      return getLibraryPlaylist(userId, source?.externalId);
    }
    if (provider === "apple-music-catalog-playlist") {
      return getPublicPlaylist({
        storefront: source?.storefront,
        playlistId: source?.externalId,
        url: source?.externalUrl,
      });
    }
    const error = new Error(`Unsupported Apple Music import source: ${provider || "unknown"}`);
    error.statusCode = 400;
    throw error;
  }

  return {
    connect,
    getImportSource,
    getLibraryPlaylist,
    getLibrarySongs,
    getPublicPlaylist,
    listLibraryPlaylists,
    validateUserToken,
  };
}
