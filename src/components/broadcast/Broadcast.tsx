import type { Sdk } from "@siafoundation/sia-storage";
import { useEffect, useRef, useState } from "react";
import {
  generateStreamId,
  pickWebmMimeType,
  putManifest,
  uploadSegment,
  type WebmManifest,
} from "../../lib/segments";
import { useAuthStore } from "../../stores/auth";
import { CopyButton } from "../CopyButton";

const SEGMENT_MS = 30_000;

export function Broadcast() {
  const sdk = useAuthStore((s) => s.sdk);
  const previewRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [streamId, setStreamId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [segmentsCount, setSegmentsCount] = useState(0);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stopTracks(streamRef.current);
    };
  }, []);

  function stop() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stopTracks(streamRef.current);
    if (previewRef.current) previewRef.current.srcObject = null;
    recorderRef.current = null;
    streamRef.current = null;
    setRecording(false);
  }

  async function start() {
    setError(null);
    if (!sdk) return;

    const stream = await captureScreen().catch((e) => {
      setError(
        e instanceof Error ? e.message : "Failed to start screen capture",
      );
      return null;
    });
    if (!stream) return;
    streamRef.current = stream;
    if (previewRef.current) previewRef.current.srcObject = stream;

    const mimeType = pickWebmMimeType(stream.getAudioTracks().length > 0);
    if (!mimeType) {
      stopTracks(stream);
      setError("Browser doesn't support a WebM codec compatible with MSE");
      return;
    }

    const id = generateStreamId();
    setStreamId(id);
    setSegmentsCount(0);
    setPendingUploads(0);

    const uploader = new SegmentUploader(sdk, id, mimeType, {
      onProgress: (segments, pending) => {
        setSegmentsCount(segments);
        setPendingUploads(pending);
      },
      onError: (msg) => setError(msg),
    });

    try {
      await uploader.publish(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to publish initial manifest",
      );
      stopTracks(stream);
      return;
    }

    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size > 0) uploader.enqueue(e.data);
    });
    recorder.addEventListener("error", (e) => {
      const ev = e as Event & { error?: Error };
      setError(ev.error?.message ?? "MediaRecorder error");
    });
    recorder.addEventListener("stop", () => uploader.finish());

    // If the user stops sharing via the browser's share-stop UI, stop the
    // recording cleanly.
    stream.getVideoTracks()[0].addEventListener("ended", () => stop());

    recorder.start(SEGMENT_MS);
    recorderRef.current = recorder;
    setRecording(true);
  }

  return (
    <div className="flex-1 max-w-3xl mx-auto w-full px-6 py-6 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        {!recording ? (
          <button
            type="button"
            onClick={start}
            disabled={!sdk}
            className="px-4 py-2 text-sm font-medium bg-neutral-900 text-white rounded-md hover:bg-neutral-800 disabled:opacity-50"
          >
            Start broadcasting
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            className="px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-md hover:bg-red-500"
          >
            Stop
          </button>
        )}
        {recording && (
          <span className="flex items-center gap-2 text-sm text-neutral-600">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-600" />
            </span>
            Recording — {segmentsCount} segments published
            {pendingUploads > 0 && `, ${pendingUploads} uploading`}
          </span>
        )}
      </div>

      {streamId && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-neutral-500">Stream ID:</span>
          <code className="font-mono text-neutral-900 bg-neutral-100 px-2 py-1 rounded">
            {streamId}
          </code>
          <CopyButton value={streamId} label="Stream ID copied" />
        </div>
      )}

      {error && (
        <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded">
          {error}
        </div>
      )}

      <video
        ref={previewRef}
        autoPlay
        muted
        playsInline
        className="w-full bg-black rounded-md aspect-video"
      />
    </div>
  );
}

// Sequential upload pipeline. MediaRecorder fires dataavailable every
// SEGMENT_MS, but each upload can take longer than that; we queue blobs
// and drain them in order so a watcher never sees a hole in the manifest.
class SegmentUploader {
  private readonly queue: Blob[] = [];
  private readonly segments: WebmManifest["segments"] = [];
  private processing = false;
  private finishing = false;

  constructor(
    private readonly sdk: Sdk,
    private readonly streamId: string,
    private readonly mimeType: string,
    private readonly callbacks: {
      onProgress: (segments: number, pending: number) => void;
      onError: (msg: string) => void;
    },
  ) {}

  enqueue(blob: Blob): void {
    this.queue.push(blob);
    void this.drain();
  }

  finish(): void {
    this.finishing = true;
    void this.drain();
  }

  publish(ended: boolean): Promise<void> {
    return putManifest(this.streamId, {
      kind: "webm",
      mimeType: this.mimeType,
      segments: [...this.segments],
      ended,
    });
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const blob = this.queue.shift();
        if (!blob) break;
        this.callbacks.onProgress(this.segments.length, this.queue.length + 1);
        try {
          const url = await uploadSegment(this.sdk, blob, this.streamId);
          this.segments.push({ url, duration: SEGMENT_MS / 1000 });
          this.callbacks.onProgress(this.segments.length, this.queue.length);
          await this.publish(false);
        } catch (e) {
          this.report(e);
        }
      }
      if (this.finishing) {
        try {
          await this.publish(true);
        } catch (e) {
          this.report(e);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private report(e: unknown): void {
    this.callbacks.onError(e instanceof Error ? e.message : String(e));
  }
}

async function captureScreen(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
}

function stopTracks(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}
