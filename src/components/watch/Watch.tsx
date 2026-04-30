import type { Sdk } from "@siafoundation/sia-storage";
import { useEffect, useRef, useState } from "react";
import {
  fetchSegmentBytes,
  getManifest,
  type WebmManifest,
} from "../../lib/segments";
import { useAuthStore } from "../../stores/auth";

const POLL_MS = 2000;
const MANIFEST_RETRY_MS = 1000;
const PREFETCH_AHEAD_SECONDS = 120;
const MAX_INFLIGHT_FETCHES = 2;

const KEEP_BEFORE_PLAYHEAD = 300;
const KEEP_AFTER_PLAYHEAD = 300;
const MAX_BUFFERED = 900;

type Range = readonly [number, number];

export function Watch() {
  const sdk = useAuthStore((s) => s.sdk);
  const videoRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<WatchSession | null>(null);

  const [streamId, setStreamId] = useState("");
  const [watching, setWatching] = useState<string | null>(null);
  const [segmentsCount, setSegmentsCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, []);

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setWatching(null);
  }

  async function watch() {
    setError(null);
    const id = streamId.trim();
    if (!id || !sdk || !videoRef.current) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setWatching(id);
    setSegmentsCount(0);

    const session = new WatchSession({
      id,
      sdk,
      videoEl: videoRef.current,
      signal: ac.signal,
      onSegmentsChange: setSegmentsCount,
    });
    sessionRef.current = session;

    try {
      await session.run();
    } catch (e) {
      if (ac.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      setWatching(null);
    }
  }

  return (
    <div className="flex-1 max-w-3xl mx-auto w-full px-6 py-6 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={streamId}
          onChange={(e) => setStreamId(e.target.value)}
          placeholder="stream ID"
          disabled={watching !== null}
          className="flex-1 px-3 py-2 text-sm font-mono border border-neutral-300 rounded-md focus:outline-none focus:ring-2 focus:ring-neutral-400 disabled:opacity-50"
        />
        {watching === null ? (
          <button
            type="button"
            onClick={watch}
            disabled={!sdk}
            className="px-4 py-2 text-sm font-medium bg-neutral-900 text-white rounded-md hover:bg-neutral-800 disabled:opacity-50"
          >
            Watch
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            className="px-4 py-2 text-sm font-medium bg-neutral-200 text-neutral-900 rounded-md hover:bg-neutral-300"
          >
            Stop
          </button>
        )}
      </div>

      {watching && (
        <div className="text-sm text-neutral-500">
          Watching <span className="font-mono">{watching}</span> —{" "}
          {segmentsCount} segments buffered
        </div>
      )}
      {error && (
        <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded">
          {error}
        </div>
      )}

      {/* biome-ignore lint/a11y/useMediaCaption: live broadcast has no caption track */}
      <video
        ref={videoRef}
        controls
        autoPlay
        playsInline
        className="w-full bg-black rounded-md aspect-video"
      />
    </div>
  );
}

interface SessionDeps {
  id: string;
  sdk: Sdk;
  videoEl: HTMLVideoElement;
  signal: AbortSignal;
  onSegmentsChange: (n: number) => void;
}

class WatchSession {
  private readonly wakeup = new Wakeup();
  private readonly fetches = new Map<number, Promise<Uint8Array>>();
  private readonly inFlight = new Set<number>();
  private readonly deps: SessionDeps;
  private lastManifestPoll = 0;
  private player: MsePlayer | null = null;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    deps.signal.addEventListener("abort", () => this.wakeup.wake(), {
      once: true,
    });
  }

  async run(): Promise<void> {
    const initial = await this.waitForManifest();
    if (!initial) return;
    if (!MediaSource.isTypeSupported(initial.mimeType)) {
      throw new Error(`browser can't decode ${initial.mimeType}`);
    }

    this.player = new MsePlayer(
      this.deps.videoEl,
      initial.mimeType,
      this.deps.signal,
    );

    try {
      await this.player.setup();
      this.deps.signal.throwIfAborted();
      const detach = this.attachListeners();
      try {
        await this.loop(this.player, initial);
      } finally {
        detach();
      }
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
    this.player?.dispose();
    this.player = null;
  }

  private async waitForManifest(): Promise<WebmManifest | null> {
    while (!this.deps.signal.aborted) {
      const m = await getManifest(this.deps.id);
      this.lastManifestPoll = Date.now();
      if (m) return m;
      await delay(MANIFEST_RETRY_MS);
    }
    return null;
  }

  private async loop(player: MsePlayer, initial: WebmManifest): Promise<void> {
    const { signal } = this.deps;
    let manifest = initial;

    while (!signal.aborted) {
      manifest = await this.refreshManifest(manifest);
      await player.syncDuration(manifest);
      this.prefetch(player, manifest);

      const idx = this.chooseTarget(player, manifest);
      if (idx !== null) {
        const bytes = await this.fetch(idx, manifest.segments[idx].url);
        signal.throwIfAborted();
        this.fetches.delete(idx);
        await this.appendWithRecovery(player, idx, bytes, manifest);
        this.deps.onSegmentsChange(player.bufferedSize);
        await player.evictIfNeeded(manifest.segments);
        continue;
      }

      if (manifest.ended && player.hasAll(manifest.segments.length)) {
        player.end();
        return;
      }

      await Promise.race([this.wakeup.wait(), delay(POLL_MS)]);
    }
  }

  private fetch(idx: number, url: string): Promise<Uint8Array> {
    const cached = this.fetches.get(idx);
    if (cached) return cached;
    this.inFlight.add(idx);
    const p = fetchSegmentBytes(this.deps.sdk, url).finally(() => {
      this.inFlight.delete(idx);
    });
    this.fetches.set(idx, p);
    return p;
  }

  private async appendWithRecovery(
    player: MsePlayer,
    idx: number,
    bytes: Uint8Array,
    manifest: WebmManifest,
  ): Promise<void> {
    if (player.hasError()) {
      await this.recover(player, idx, bytes, manifest);
      return;
    }

    try {
      await player.appendIndex(idx, bytes);
    } catch (e) {
      if (!player.hasError()) throw e;
      await this.recover(player, idx, bytes, manifest);
    }
  }

  private async recover(
    player: MsePlayer,
    idx: number,
    bytes: Uint8Array,
    manifest: WebmManifest,
  ): Promise<void> {
    const savedTime = this.deps.videoEl.currentTime;
    const wasPlaying = !this.deps.videoEl.paused;

    await player.setup();
    await player.syncDuration(manifest);
    this.deps.signal.throwIfAborted();

    if (idx !== 0) {
      const initBytes = await this.fetch(0, manifest.segments[0].url);
      this.deps.signal.throwIfAborted();
      await player.appendIndex(0, initBytes);
    }

    await player.appendIndex(idx, bytes);
    this.deps.videoEl.currentTime = Math.min(
      savedTime,
      Math.max(0, player.duration),
    );

    if (wasPlaying) {
      this.deps.videoEl.play().catch(() => {
        // Autoplay can be blocked after the rebuild; leave it paused.
      });
    }
  }

  private prefetch(player: MsePlayer, manifest: WebmManifest): void {
    if (manifest.segments.length === 0) return;

    const playhead = this.deps.videoEl.currentTime;
    const window: Range = [playhead, playhead + PREFETCH_AHEAD_SECONDS];

    for (const i of [...this.fetches.keys()]) {
      if (this.inFlight.has(i) || i === 0) continue;
      const range = segmentRange(manifest.segments, i);
      if (!range || !overlaps(range, window)) this.fetches.delete(i);
    }

    if (!player.has(0) && !this.fetches.has(0)) {
      this.fetch(0, manifest.segments[0].url);
    }

    for (const { idx, start, end } of segmentRanges(manifest.segments)) {
      if (this.inFlight.size >= MAX_INFLIGHT_FETCHES) return;
      if (end <= window[0]) continue;
      if (start > window[1]) return;
      if (player.has(idx) || this.fetches.has(idx)) continue;
      this.fetch(idx, manifest.segments[idx].url);
    }
  }

  private async refreshManifest(current: WebmManifest): Promise<WebmManifest> {
    if (Date.now() - this.lastManifestPoll < POLL_MS) return current;
    const m = await getManifest(this.deps.id);
    this.lastManifestPoll = Date.now();
    return m ?? current;
  }

  private chooseTarget(
    player: MsePlayer,
    manifest: WebmManifest,
  ): number | null {
    if (manifest.segments.length === 0) return null;
    if (!player.isReady()) return 0;

    const playhead = this.deps.videoEl.currentTime;
    const playheadIdx = segmentIndexAt(playhead, manifest.segments);
    if (playheadIdx < manifest.segments.length && !player.has(playheadIdx)) {
      return playheadIdx;
    }

    for (const { idx, start, end } of segmentRanges(manifest.segments)) {
      if (end <= playhead) continue;
      if (start > playhead + PREFETCH_AHEAD_SECONDS) break;
      if (!player.has(idx)) return idx;
    }

    return null;
  }

  private attachListeners(): () => void {
    const wake = () => this.wakeup.wake();
    const video = this.deps.videoEl;
    video.addEventListener("seeking", wake);
    video.addEventListener("waiting", wake);
    return () => {
      video.removeEventListener("seeking", wake);
      video.removeEventListener("waiting", wake);
    };
  }
}

class MsePlayer {
  private ms!: MediaSource;
  private sb!: SourceBuffer;
  private objectUrl: string | null = null;
  private readonly appended = new Set<number>();
  private readonly videoEl: HTMLVideoElement;
  private readonly mimeType: string;
  private readonly signal: AbortSignal;
  private initAppended = false;
  private disposed = false;

  constructor(
    videoEl: HTMLVideoElement,
    mimeType: string,
    signal: AbortSignal,
  ) {
    this.videoEl = videoEl;
    this.mimeType = mimeType;
    this.signal = signal;
  }

  get bufferedSize(): number {
    return this.appended.size;
  }

  has(idx: number): boolean {
    return this.appended.has(idx);
  }

  hasAll(count: number): boolean {
    for (let i = 0; i < count; i++) {
      if (!this.appended.has(i)) return false;
    }
    return true;
  }

  isReady(): boolean {
    return this.initAppended;
  }

  get duration(): number {
    return this.ms.duration;
  }

  hasError(): boolean {
    return this.videoEl.error !== null;
  }

  async setup(): Promise<void> {
    this.releaseUrl();
    this.videoEl.removeAttribute("src");
    this.videoEl.load();
    this.ms = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.ms);
    this.videoEl.src = this.objectUrl;
    await once(this.ms, "sourceopen");
    this.sb = this.ms.addSourceBuffer(this.mimeType);
    this.appended.clear();
    this.initAppended = false;
    this.ms.duration = Number.POSITIVE_INFINITY;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseUrl();
    this.videoEl.removeAttribute("src");
    this.videoEl.load();
  }

  async syncDuration(manifest: WebmManifest): Promise<void> {
    if (this.ms.readyState !== "open") return;
    if (this.sb.updating) await once(this.sb, "updateend");

    const currentDuration = Number.isFinite(this.ms.duration)
      ? this.ms.duration
      : 0;
    const nextDuration = Math.max(
      currentDuration,
      totalDuration(manifest.segments),
      bufferedEnd(this.sb.buffered),
      this.videoEl.currentTime,
    );
    if (this.ms.duration !== nextDuration) this.ms.duration = nextDuration;
  }

  async appendIndex(idx: number, bytes: Uint8Array): Promise<void> {
    if (this.appended.has(idx)) return;
    await this.appendBytes(bytes);
    this.appended.add(idx);
    if (idx === 0) this.initAppended = true;
  }

  async evictIfNeeded(segments: WebmManifest["segments"]): Promise<void> {
    if (this.ms.readyState !== "open") return;
    if (bufferedTotal(this.sb.buffered) < MAX_BUFFERED) return;

    const playhead = this.videoEl.currentTime;
    const removeEnd = Math.max(0, playhead - KEEP_BEFORE_PLAYHEAD);
    const removeStart = playhead + KEEP_AFTER_PLAYHEAD;

    if (removeEnd > 0) await this.removeRange(0, removeEnd);
    const tail = bufferedEnd(this.sb.buffered);
    if (removeStart < tail) await this.removeRange(removeStart, tail);

    for (const idx of [...this.appended]) {
      const range = segmentRange(segments, idx);
      if (!range) {
        this.appended.delete(idx);
        continue;
      }
      if (range[1] <= removeEnd || range[0] >= removeStart) {
        this.appended.delete(idx);
      }
    }
  }

  end(): void {
    if (this.ms.readyState !== "open") return;
    if (this.sb.updating) {
      this.sb.addEventListener("updateend", () => this.end(), { once: true });
      return;
    }
    try {
      this.ms.endOfStream();
    } catch {
      // The element is already ending or detached.
    }
  }

  private releaseUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  private async removeRange(start: number, end: number): Promise<void> {
    if (this.sb.updating) await once(this.sb, "updateend");
    this.sb.remove(start, end);
    await once(this.sb, "updateend");
  }

  private async appendBytes(bytes: Uint8Array): Promise<void> {
    this.signal.throwIfAborted();
    if (this.sb.updating) await once(this.sb, "updateend");
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    this.sb.appendBuffer(buf);
    await once(this.sb, "updateend");
    this.signal.throwIfAborted();
  }
}

class Wakeup {
  private readonly waiters = new Set<() => void>();

  wait(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        resolve();
      };
      this.waiters.add(done);
    });
  }

  wake(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter();
  }
}

function* segmentRanges(
  segments: WebmManifest["segments"],
): Generator<{ idx: number; start: number; end: number }> {
  let start = 0;
  for (let idx = 0; idx < segments.length; idx++) {
    const end = start + segments[idx].duration;
    yield { idx, start, end };
    start = end;
  }
}

function segmentRange(
  segments: WebmManifest["segments"],
  targetIdx: number,
): Range | null {
  for (const { idx, start, end } of segmentRanges(segments)) {
    if (idx === targetIdx) return [start, end];
  }
  return null;
}

function segmentIndexAt(
  time: number,
  segments: WebmManifest["segments"],
): number {
  for (const { idx, end } of segmentRanges(segments)) {
    if (end > time) return idx;
  }
  return segments.length;
}

function totalDuration(segments: WebmManifest["segments"]): number {
  return segments.reduce((sum, segment) => sum + segment.duration, 0);
}

function overlaps(a: Range, b: Range): boolean {
  return a[0] < b[1] && a[1] > b[0];
}

function bufferedEnd(buffered: TimeRanges): number {
  let end = 0;
  for (let i = 0; i < buffered.length; i++)
    end = Math.max(end, buffered.end(i));
  return end;
}

function bufferedTotal(buffered: TimeRanges): number {
  let total = 0;
  for (let i = 0; i < buffered.length; i++) {
    total += buffered.end(i) - buffered.start(i);
  }
  return total;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function once<T extends EventTarget>(target: T, type: string): Promise<void> {
  return new Promise((resolve) =>
    target.addEventListener(type, () => resolve(), { once: true }),
  );
}
