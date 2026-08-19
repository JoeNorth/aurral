const MUSICKIT_SCRIPT_URL = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
const MUSICKIT_SCRIPT_ID = "aurral-musickit-js";
const LOAD_TIMEOUT_MS = 30 * 1000;

let loadPromise = null;
let configuredInstance = null;

function loadMusicKit() {
  if (window.MusicKit) return Promise.resolve(window.MusicKit);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      document.removeEventListener("musickitloaded", handleLoaded);
      callback(value);
    };
    const handleLoaded = () => {
      if (window.MusicKit) finish(resolve, window.MusicKit);
    };
    const timeout = window.setTimeout(
      () => finish(reject, new Error("Apple Music sign-in failed to load")),
      LOAD_TIMEOUT_MS,
    );

    document.addEventListener("musickitloaded", handleLoaded);
    let script = document.getElementById(MUSICKIT_SCRIPT_ID);
    if (!script) {
      script = document.createElement("script");
      script.id = MUSICKIT_SCRIPT_ID;
      script.src = MUSICKIT_SCRIPT_URL;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", handleLoaded, { once: true });
    script.addEventListener(
      "error",
      () => finish(reject, new Error("Apple Music sign-in failed to load")),
      { once: true },
    );
  }).catch((error) => {
    loadPromise = null;
    throw error;
  });

  return loadPromise;
}

async function getConfiguredInstance(developerToken) {
  if (configuredInstance) return configuredInstance;
  const token = String(developerToken || "").trim();
  if (!token) throw new Error("Apple Music developer token is missing");
  const MusicKit = await loadMusicKit();
  await MusicKit.configure({
    developerToken: token,
    app: {
      name: "Aurral",
      build: "2.0.0",
    },
  });
  configuredInstance = MusicKit.getInstance();
  if (!configuredInstance) throw new Error("Apple Music sign-in is unavailable");
  return configuredInstance;
}

export async function authorizeAppleMusic(developerToken) {
  const instance = await getConfiguredInstance(developerToken);
  const result = await instance.authorize();
  const musicUserToken = String(result || instance.musicUserToken || "").trim();
  if (!musicUserToken) throw new Error("Apple Music returned no user authorization token");
  return musicUserToken;
}

export async function unauthorizeAppleMusic(developerToken = null) {
  const instance =
    configuredInstance || (developerToken ? await getConfiguredInstance(developerToken) : null);
  if (!instance) return;
  await instance.unauthorize();
}
