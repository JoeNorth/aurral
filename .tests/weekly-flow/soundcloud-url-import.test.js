import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  playlistConfigModule,
  trackerModule,
  ytdlpModule,
  ytdlpOrchestratorModule,
  playlistDownloadUtilsModule,
] = await setupIsolatedBackend(
  "soundcloud-url-import",
  "backend/config/db-sqlite.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/ytdlpClient.js",
  "backend/services/ytdlpOrchestrator.js",
  "backend/services/playlistDownloadUtils.js",
);

const SOUNDCLOUD_URL =
  "https://soundcloud.com/wearecc/open-minds-ep-21-dr-beth-harris-and-dr-steven-zucker-of-smarthistory";

const metadata = {
  id: "1356023209",
  title: "Open Minds, Ep 21",
  uploader: "Creative Commons",
  webpage_url: SOUNDCLOUD_URL,
  duration: 1500.336,
  upload_date: "20221003",
  thumbnail: "https://i1.sndcdn.com/example.jpg",
  extractor: "soundcloud",
  extractor_key: "Soundcloud",
};

test.beforeEach(async () => {
  await resetDatabase(db);
  trackerModule.downloadTracker.clearAll();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("SoundCloud metadata becomes an exact Aurral track", () => {
  const track = ytdlpModule.parseSoundcloudTrackMetadata(metadata);

  assert.deepEqual(track, {
    artistName: "Creative Commons",
    trackName: "Open Minds, Ep 21",
    albumName: null,
    releaseYear: "2022",
    durationMs: 1500336,
    artworkUrl: "https://i1.sndcdn.com/example.jpg",
    sourceProvider: "soundcloud",
    sourceId: "1356023209",
    sourceUrl: SOUNDCLOUD_URL,
  });
});

test("SoundCloud inspection rejects non-track and non-SoundCloud metadata", () => {
  assert.throws(
    () => ytdlpModule.normalizeSoundcloudUrl("https://example.com/track"),
    /Only HTTPS SoundCloud URLs/,
  );
  assert.throws(
    () =>
      ytdlpModule.parseSoundcloudTrackMetadata({
        ...metadata,
        _type: "playlist",
        entries: [],
      }),
    /not a playlist or profile/,
  );
  assert.throws(
    () =>
      ytdlpModule.parseSoundcloudTrackMetadata({
        ...metadata,
        extractor: "youtube",
        extractor_key: "Youtube",
      }),
    /did not resolve to a SoundCloud track/,
  );
});

test("exact source metadata persists and restricts the job to yt-dlp", () => {
  const track = playlistConfigModule.normalizeSharedTrack(
    ytdlpModule.parseSoundcloudTrackMetadata(metadata),
  );
  const tracker = new trackerModule.WeeklyFlowDownloadTracker();
  const jobId = tracker.addJob(track, "soundcloud-downloads");
  const reloaded = new trackerModule.WeeklyFlowDownloadTracker();
  const job = reloaded.getJob(jobId);

  assert.equal(job.sourceProvider, "soundcloud");
  assert.equal(job.sourceId, "1356023209");
  assert.equal(job.sourceUrl, SOUNDCLOUD_URL);

  const payload = trackerModule.buildPipelinePayload(job);
  assert.deepEqual(payload.allowedSources, ["ytdlp"]);
  assert.deepEqual(payload.exactSource, {
    provider: "soundcloud",
    id: "1356023209",
    url: SOUNDCLOUD_URL,
  });
  assert.equal(payload.track.sourceUrl, SOUNDCLOUD_URL);
  const resolvedTrack = playlistDownloadUtilsModule.buildResolvedPlaylistTrack(job, payload.track);
  assert.equal(resolvedTrack.sourceProvider, "soundcloud");
  assert.equal(resolvedTrack.sourceId, "1356023209");
  assert.equal(resolvedTrack.sourceUrl, SOUNDCLOUD_URL);
});

test("exact SoundCloud jobs build one direct yt-dlp candidate", () => {
  const candidate = ytdlpOrchestratorModule.buildExactYtdlpCandidate(
    {
      provider: "soundcloud",
      id: "1356023209",
      url: SOUNDCLOUD_URL,
    },
    {
      artistName: "Creative Commons",
      trackName: "Open Minds, Ep 21",
      albumName: null,
      durationMs: 1500336,
    },
  );

  assert.equal(candidate.exactSource, true);
  assert.equal(candidate.raw.id, "1356023209");
  assert.equal(candidate.raw.url, SOUNDCLOUD_URL);
  assert.equal(candidate.raw.channel, "Creative Commons");
  assert.equal(candidate.raw.durationSec, 1500.336);
});
