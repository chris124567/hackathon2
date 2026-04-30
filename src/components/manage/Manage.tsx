import type { ObjectEvent } from "@siafoundation/sia-storage";
import { useCallback, useEffect, useState } from "react";
import { parseVodSegmentMetadata } from "../../lib/segments";
import { useAuthStore } from "../../stores/auth";

const PAGE_SIZE = 500;

type Clip = {
  id: string;
  streamId: string;
  createdAt: Date;
};

function sortClips(seen: Map<string, Clip>): Clip[] {
  return Array.from(seen.values()).sort((a, b) => {
    if (a.streamId !== b.streamId) return a.streamId.localeCompare(b.streamId);
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

export function Manage() {
  const sdk = useAuthStore((s) => s.sdk);
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!sdk) return;
    setError(null);
    setLoading(true);
    setClips([]);
    const seen = new Map<string, Clip>();
    try {
      let cursor: { id: string; after: Date } | undefined;
      while (true) {
        const events: ObjectEvent[] = await sdk.objectEvents(cursor, PAGE_SIZE);
        if (events.length === 0) break;
        for (const ev of events) {
          if (ev.deleted) {
            seen.delete(ev.id);
            continue;
          }
          const obj = ev.object;
          if (!obj) continue;
          const meta = parseVodSegmentMetadata(obj.metadata());
          if (!meta) continue;
          seen.set(ev.id, {
            id: ev.id,
            streamId: meta.streamId,
            createdAt: obj.createdAt(),
          });
        }
        setClips(sortClips(seen));
        const last = events[events.length - 1];
        cursor = { id: last.id, after: last.updatedAt };
        if (events.length < PAGE_SIZE) break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sdk]);

  useEffect(() => {
    load();
  }, [load]);

  async function unpinStream(streamId: string) {
    if (!sdk) return;
    const ids = clips.filter((c) => c.streamId === streamId).map((c) => c.id);
    if (ids.length === 0) return;
    setDeleting((prev) => new Set(prev).add(streamId));
    const deleted = new Set<string>();
    try {
      for (const id of ids) {
        await sdk.deleteObject(id);
        deleted.add(id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClips((prev) => prev.filter((c) => !deleted.has(c.id)));
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(streamId);
        return next;
      });
    }
  }

  const grouped = groupByStream(clips);

  return (
    <div className="flex-1 max-w-3xl mx-auto w-full px-6 py-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Manage VODs</h2>
        <button
          type="button"
          onClick={load}
          disabled={!sdk || loading}
          className="px-3 py-1.5 text-sm rounded-md text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded">
          {error}
        </div>
      )}

      {clips.length === 0 ? (
        <div className="text-sm text-neutral-500">
          {loading
            ? "Loading…"
            : "No VOD clips found. Broadcast a stream to create some."}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {grouped.map(([streamId, items]) => (
            <div key={streamId} className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-neutral-500">Stream</span>
                <code className="font-mono text-neutral-900 bg-neutral-100 px-2 py-1 rounded">
                  {streamId}
                </code>
                <span className="text-neutral-500">
                  · {items.length} clip{items.length === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  onClick={() => unpinStream(streamId)}
                  disabled={deleting.has(streamId)}
                  className="ml-auto px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
                >
                  {deleting.has(streamId) ? "Unpinning…" : "Unpin stream"}
                </button>
              </div>
              <ul className="flex flex-col divide-y divide-neutral-200 border border-neutral-200 rounded-md">
                {items.map((c) => (
                  <li key={c.id} className="px-3 py-2 text-sm">
                    <span className="font-mono text-neutral-700">
                      {c.createdAt.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function groupByStream(clips: Clip[]): Array<[string, Clip[]]> {
  const map = new Map<string, Clip[]>();
  for (const c of clips) {
    const arr = map.get(c.streamId);
    if (arr) arr.push(c);
    else map.set(c.streamId, [c]);
  }
  return Array.from(map.entries());
}
