import { createAppleMusicClient } from "./appleMusicClient.js";
import { getAppleMusicDeveloperToken } from "./appleMusicConfig.js";
import { appleMusicConnectionStore } from "./appleMusicConnectionStore.js";

export const appleMusicClient = createAppleMusicClient({
  connectionStore: appleMusicConnectionStore,
  getDeveloperToken: getAppleMusicDeveloperToken,
});
