import { PinnedObject, type Sdk } from "@siafoundation/sia-storage";
import { DATA_SHARDS, PARITY_SHARDS } from "./constants";

// Manifest written by the broadcast tab and consumed by the watch tab. Stored
// in-memory by the Vite dev plugin at /api/manifest/<id>. Each segment URL is
// a Sia share URL produced by sdk.shareObject(...).
//
// Stored on the server as an EncryptedManifest envelope: the random per-stream
// key lives in the fragment of the stream ID (`<id>#<key-hex>`), so the server
// only ever sees ciphertext and an IV.
export type WebmManifest = {
  kind: "webm";
  mimeType: string;
  segments: Array<{ url: string; duration: number }>;
  ended: boolean;
};

type EncryptedManifest = {
  v: 1;
  iv: string;
  ct: string;
};

const SHARE_TTL_MS = 365 * 86400 * 1000;
const KEY_BYTES = 16;
const IV_BYTES = 12;

export function manifestUrl(id: string): string {
  return `${window.location.origin}/api/manifest/${encodeURIComponent(id)}`;
}

export async function putManifest(
  streamId: string,
  manifest: WebmManifest,
): Promise<void> {
  const { id, key } = await parseStreamId(streamId);
  const envelope = await encryptManifest(key, manifest);
  const resp = await fetch(manifestUrl(id), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (!resp.ok)
    throw new Error(`PUT manifest: ${resp.status} ${resp.statusText}`);
}

export async function getManifest(
  streamId: string,
): Promise<WebmManifest | null> {
  const { id, key } = await parseStreamId(streamId);
  const resp = await fetch(manifestUrl(id), { cache: "no-store" });
  if (resp.status === 404) return null;
  if (!resp.ok)
    throw new Error(`GET manifest: ${resp.status} ${resp.statusText}`);
  const envelope = (await resp.json()) as EncryptedManifest;
  return decryptManifest(key, envelope);
}

async function parseStreamId(
  streamId: string,
): Promise<{ id: string; key: CryptoKey }> {
  const [id, keyHex] = streamId.split("#");
  if (!id || !keyHex) throw new Error("stream ID missing encryption key");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.fromHex(keyHex),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  return { id, key };
}

async function encryptManifest(
  key: CryptoKey,
  manifest: WebmManifest,
): Promise<EncryptedManifest> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(manifest));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  return { v: 1, iv: iv.toHex(), ct: new Uint8Array(ct).toHex() };
}

async function decryptManifest(
  key: CryptoKey,
  envelope: EncryptedManifest,
): Promise<WebmManifest> {
  if (envelope.v !== 1)
    throw new Error(`unknown manifest version: ${envelope.v}`);
  const iv = Uint8Array.fromHex(envelope.iv);
  const ct = Uint8Array.fromHex(envelope.ct);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  } catch {
    // AES-GCM authentication failure — usually a wrong key (truncated or
    // mistyped fragment) or a tampered ciphertext.
    throw new Error("failed to decrypt manifest — wrong encryption key?");
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as WebmManifest;
}

// Metadata stamped on every uploaded clip. Holds the public stream ID only —
// never the per-stream key in the stream-ID fragment, which is what
// authorizes a watcher to decrypt the manifest. The public ID on the indexer
// lets the owner group their clips by stream in the Manage VODs view without
// leaking the ability to decrypt anyone else's manifests.
export const VOD_SEGMENT_KIND = "vod-segment";

export type VodSegmentMetadata = {
  kind: typeof VOD_SEGMENT_KIND;
  streamId: string;
};

export function streamPublicId(streamId: string): string {
  return streamId.split("#")[0];
}

export function parseVodSegmentMetadata(
  bytes: Uint8Array,
): VodSegmentMetadata | null {
  if (bytes.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { kind, streamId } = parsed as Partial<VodSegmentMetadata>;
  if (kind !== VOD_SEGMENT_KIND || typeof streamId !== "string") return null;
  return { kind, streamId };
}

export async function uploadSegment(
  sdk: Sdk,
  blob: Blob,
  streamId: string,
): Promise<string> {
  const object = new PinnedObject();
  const pinned = await sdk.upload(object, blob.stream(), {
    maxInflight: 10,
    dataShards: DATA_SHARDS,
    parityShards: PARITY_SHARDS,
  });
  const meta: VodSegmentMetadata = {
    kind: VOD_SEGMENT_KIND,
    streamId: streamPublicId(streamId),
  };
  pinned.updateMetadata(new TextEncoder().encode(JSON.stringify(meta)));
  await sdk.pinObject(pinned);
  await sdk.updateObjectMetadata(pinned);
  const validUntil = new Date(Date.now() + SHARE_TTL_MS);
  return sdk.shareObject(pinned, validUntil);
}

export async function fetchSegmentBytes(
  sdk: Sdk,
  url: string,
): Promise<Uint8Array> {
  const obj = await sdk.sharedObject(url);
  const buf = await new Response(sdk.download(obj)).arrayBuffer();
  return new Uint8Array(buf);
}

// Stream ID format: `<id>#<key-hex>`. The fragment after `#` is the AES-GCM
// key used to encrypt every manifest written under this ID; it never leaves
// the client. The server only stores ciphertext keyed by `<id>`.
export function generateStreamId(): string {
  const id = crypto.getRandomValues(new Uint8Array(8));
  const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  return `${id.toHex()}#${key.toHex()}`;
}

const VIDEO_AUDIO_CANDIDATES = [
  'video/webm;codecs="vp9,opus"',
  'video/webm;codecs="vp8,opus"',
  "video/webm",
];
const VIDEO_ONLY_CANDIDATES = [
  'video/webm;codecs="vp9"',
  'video/webm;codecs="vp8"',
  "video/webm",
];

export function pickWebmMimeType(hasAudio: boolean): string | null {
  const candidates = hasAudio ? VIDEO_AUDIO_CANDIDATES : VIDEO_ONLY_CANDIDATES;
  return (
    candidates.find(
      (c) => MediaRecorder.isTypeSupported(c) && MediaSource.isTypeSupported(c),
    ) ?? null
  );
}
