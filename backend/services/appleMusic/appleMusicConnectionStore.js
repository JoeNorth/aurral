import { db, dbHelpers } from "../../config/db-sqlite.js";
import { decryptWithKey, encryptWithKey } from "../../config/encryption.js";
import { getSettingsEncryptionKey } from "../../db/helpers/settings.js";

const SETTINGS_KEY = "appleMusicConnections";
const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertSettingStmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");

const readStore = () => {
  const parsed = dbHelpers.parseJSON(getSettingStmt.get(SETTINGS_KEY)?.value);
  return parsed && typeof parsed === "object" ? parsed : {};
};

const writeStore = (store) => {
  upsertSettingStmt.run(SETTINGS_KEY, dbHelpers.stringifyJSON(store));
};

const userKey = (userId) => String(Math.trunc(Number(userId)));

const encryptToken = (value) => encryptWithKey(String(value || ""), getSettingsEncryptionKey());
const decryptToken = (value) => decryptWithKey(value, getSettingsEncryptionKey());

const normalizeConnection = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const musicUserToken = decryptToken(raw.musicUserToken);
  if (!musicUserToken) return null;
  return {
    musicUserToken,
    storefront:
      String(raw.storefront || "")
        .trim()
        .toLowerCase() || null,
    connectedAt:
      raw.connectedAt != null && Number.isFinite(Number(raw.connectedAt))
        ? Number(raw.connectedAt)
        : Date.now(),
  };
};

export const appleMusicConnectionStore = {
  getConnection(userId) {
    const store = readStore();
    return normalizeConnection(store[userKey(userId)] || null);
  },

  getPublicStatus(userId) {
    const connection = this.getConnection(userId);
    return {
      connected: Boolean(connection),
      storefront: connection?.storefront || null,
      connectedAt: connection?.connectedAt || null,
    };
  },

  saveConnection(userId, { musicUserToken, storefront = null } = {}) {
    const safeToken = String(musicUserToken || "").trim();
    if (!safeToken) throw new Error("Apple Music user token is required");
    const store = readStore();
    store[userKey(userId)] = {
      musicUserToken: encryptToken(safeToken),
      storefront:
        String(storefront || "")
          .trim()
          .toLowerCase() || null,
      connectedAt: Date.now(),
    };
    writeStore(store);
    return this.getConnection(userId);
  },

  clearConnection(userId) {
    const store = readStore();
    const key = userKey(userId);
    if (!store[key]) return false;
    delete store[key];
    writeStore(store);
    return true;
  },
};
