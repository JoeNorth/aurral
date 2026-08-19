import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  clearAppleMusicDeveloperTokenCache,
  getAppleMusicDeveloperToken,
  getAppleMusicPublicConfiguration,
} from "../../backend/services/appleMusic/appleMusicConfig.js";
import {
  createAppleMusicClient,
  parseAppleMusicPlaylistUrl,
} from "../../backend/services/appleMusic/appleMusicClient.js";
import { parseAppleMusicResources } from "../../backend/services/importLists/appleMusicTracks.js";
import { normalizeImportSource } from "../../backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js";

const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const song = (id, name, artistName = "Artist") => ({
  id,
  type: "songs",
  attributes: {
    name,
    artistName,
    albumName: "Album",
    releaseDate: "2024-06-14",
    durationInMillis: 183000,
    playParams: { catalogId: id },
    url: `https://music.apple.com/us/song/${id}`,
  },
});

test("generates a verifiable origin-bound Apple Music developer token", () => {
  clearAppleMusicDeveloperTokenCache();
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const env = {
    APPLE_MUSIC_TEAM_ID: "TEAM123456",
    APPLE_MUSIC_KEY_ID: "KEY1234567",
    APPLE_MUSIC_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
    APPLE_MUSIC_ORIGIN: "https://music.example.test/path-is-ignored",
  };
  const now = Date.UTC(2026, 7, 19, 12, 0, 0);
  const token = getAppleMusicDeveloperToken({ env, now });
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));

  assert.deepEqual(header, { alg: "ES256", kid: "KEY1234567", typ: "JWT" });
  assert.equal(payload.iss, "TEAM123456");
  assert.equal(payload.origin, "https://music.example.test");
  assert.ok(payload.exp > payload.iat);
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(encodedSignature, "base64url"),
    ),
    true,
  );
  assert.equal(getAppleMusicDeveloperToken({ env, now: now + 1000 }), token);
  clearAppleMusicDeveloperTokenCache();
});

test("reports missing or invalid Apple Music configuration without exposing secrets", () => {
  assert.deepEqual(getAppleMusicPublicConfiguration({}), {
    configured: false,
    mode: null,
    origin: null,
    message: "Configure APPLE_MUSIC_TEAM_ID, APPLE_MUSIC_KEY_ID, APPLE_MUSIC_PRIVATE_KEY_PATH",
  });
  assert.equal(
    getAppleMusicPublicConfiguration({
      APPLE_MUSIC_DEVELOPER_TOKEN: "secret-token",
      APPLE_MUSIC_ORIGIN: "file:///tmp/aurral",
    }).configured,
    false,
  );
  assert.equal(
    "developerToken" in
      getAppleMusicPublicConfiguration({ APPLE_MUSIC_DEVELOPER_TOKEN: "secret-token" }),
    false,
  );
});

test("parses only public Apple Music playlist URLs", () => {
  assert.deepEqual(
    parseAppleMusicPlaylistUrl(
      "https://music.apple.com/us/playlist/my-list/pl.u-abc123?l=en-US#fragment",
    ),
    {
      storefront: "us",
      playlistId: "pl.u-abc123",
      url: "https://music.apple.com/us/playlist/my-list/pl.u-abc123?l=en-US",
    },
  );
  assert.throws(
    () => parseAppleMusicPlaylistUrl("https://music.apple.com/us/album/not-a-playlist/123"),
    /public Apple Music playlist/,
  );
  assert.throws(
    () => parseAppleMusicPlaylistUrl("https://example.com/us/playlist/list/pl.u-abc123"),
    /music\.apple\.com/,
  );
});

test("loads every page of a public Apple Music playlist with a developer token", async () => {
  const requests = [];
  const client = createAppleMusicClient({
    getDeveloperToken: () => "developer-token",
    connectionStore: {},
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), headers: options.headers });
      if (url.searchParams.get("offset") === "1") {
        return response({ data: [song("song-2", "Second")] });
      }
      return response({
        data: [
          {
            id: "pl.u-abc123",
            type: "playlists",
            attributes: {
              name: "Public List",
              artwork: { url: "https://img.test/{w}x{h}.{f}" },
            },
            relationships: {
              tracks: {
                data: [song("song-1", "First")],
                next: "/v1/catalog/us/playlists/pl.u-abc123/tracks?offset=1",
              },
            },
          },
        ],
      });
    },
  });

  const result = await client.getPublicPlaylist(
    "https://music.apple.com/us/playlist/public-list/pl.u-abc123",
  );

  assert.equal(result.name, "Public List");
  assert.equal(result.artworkUrl, "https://img.test/600x600.jpg");
  assert.deepEqual(
    result.resources.map((resource) => resource.id),
    ["song-1", "song-2"],
  );
  assert.deepEqual(result.source, {
    provider: "apple-music-catalog-playlist",
    externalType: "catalog-playlist",
    externalId: "pl.u-abc123",
    externalName: "Public List",
    externalUrl: "https://music.apple.com/us/playlist/public-list/pl.u-abc123",
    storefront: "us",
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.Authorization, "Bearer developer-token");
  assert.equal(requests[0].headers["Music-User-Token"], undefined);
});

test("validates and uses the encrypted per-user authorization contract for library imports", async () => {
  const requests = [];
  let savedConnection = null;
  const connectionStore = {
    getConnection: () => savedConnection,
    saveConnection: (_userId, connection) => {
      savedConnection = { ...connection, storefront: connection.storefront || null };
    },
    getPublicStatus: () => ({
      connected: Boolean(savedConnection),
      storefront: savedConnection?.storefront || null,
      connectedAt: 1,
    }),
  };
  const client = createAppleMusicClient({
    getDeveloperToken: () => "developer-token",
    connectionStore,
    fetchImpl: async (url, options) => {
      requests.push({ path: `${url.pathname}${url.search}`, headers: options.headers });
      if (url.pathname === "/v1/me/storefront") {
        return response({ data: [{ id: "ca", type: "storefronts" }] });
      }
      if (url.pathname === "/v1/me/library/playlists") {
        return response({
          data: [
            {
              id: "p.library-list",
              type: "library-playlists",
              attributes: { name: "Library List" },
            },
          ],
        });
      }
      if (url.searchParams.get("offset") === "1") {
        return response({ data: [{ ...song("library-2", "Second"), type: "library-songs" }] });
      }
      return response({
        data: [{ ...song("library-1", "First"), type: "library-songs" }],
        next: "/v1/me/library/songs?offset=1",
      });
    },
  });

  assert.deepEqual(await client.connect(7, "music-user-token"), {
    connected: true,
    storefront: "ca",
    connectedAt: 1,
  });
  assert.deepEqual(await client.listLibraryPlaylists(7), {
    storefront: "ca",
    playlists: [
      {
        id: "p.library-list",
        name: "Library List",
        kind: "library-playlist",
        artworkUrl: null,
      },
    ],
  });
  const library = await client.getLibrarySongs(7);
  assert.deepEqual(
    library.resources.map((resource) => resource.id),
    ["library-1", "library-2"],
  );
  assert.ok(
    requests.every((request) => request.headers.Authorization === "Bearer developer-token"),
  );
  assert.ok(
    requests.every((request) => request.headers["Music-User-Token"] === "music-user-token"),
  );
});

test("normalizes songs and rejects unsupported, incomplete, and duplicate Apple resources", () => {
  const resources = [
    song("song-1", "Track"),
    song("song-1-copy", "Track"),
    { id: "video-1", type: "music-videos", attributes: { name: "Video" } },
    { id: "broken", type: "songs", attributes: { name: "No Artist" } },
  ];
  const { tracks, stats } = parseAppleMusicResources(resources);

  assert.deepEqual(stats, { unsupported: 1, incomplete: 1, duplicate: 1 });
  assert.deepEqual(tracks, [
    {
      artistName: "Artist",
      trackName: "Track",
      albumName: "Album",
      artistMbid: null,
      albumMbid: null,
      trackMbid: null,
      releaseYear: "2024",
      durationMs: 183000,
      artistAliases: [],
      reason: null,
      sourceProvider: "apple-music",
      sourceId: "song-1",
      sourceUrl: "https://music.apple.com/us/song/song-1",
    },
  ]);
});

test("preserves the Apple catalog fields needed for scheduled synchronization", () => {
  assert.deepEqual(
    normalizeImportSource({
      provider: "apple-music-catalog-playlist",
      externalType: "catalog-playlist",
      externalId: "pl.u-abc123",
      externalName: "Public List",
      externalUrl: "https://music.apple.com/ca/playlist/public-list/pl.u-abc123",
      storefront: "CA",
      syncEnabled: true,
      syncIntervalHours: 24,
    }),
    {
      provider: "apple-music-catalog-playlist",
      externalId: "pl.u-abc123",
      externalName: "Public List",
      externalType: "catalog-playlist",
      externalUrl: "https://music.apple.com/ca/playlist/public-list/pl.u-abc123",
      storefront: "ca",
      syncEnabled: true,
      syncIntervalHours: 24,
      lastSyncAt: null,
      lastSyncError: null,
      lastSyncTrackCount: null,
    },
  );
});
