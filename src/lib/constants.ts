import type { AppMetadata } from "@siafoundation/sia-storage";

// biome-ignore format: long hex literal
export const APP_KEY =
  "b003259da82e23e4a21c4ee2ed0768d55d9b9d57ec3381e2da5054f05bdc81b8";
export const APP_NAME = "rebroadcast";
export const DEFAULT_INDEXER_URL = "https://sia.storage";
export const APP_META: AppMetadata = {
  appId: APP_KEY,
  name: APP_NAME,
  description: "My decentralized storage app",
  serviceUrl: "https://sia.storage",
  logoUrl: undefined,
  callbackUrl: undefined,
};

// Erasure coding parameters — passed to sdk.upload() and encodedSize().
export const DATA_SHARDS = 10;
export const PARITY_SHARDS = 15;
