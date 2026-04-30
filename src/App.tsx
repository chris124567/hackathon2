import { useState } from "react";
import { AuthFlow } from "./components/auth/AuthFlow";
import { Broadcast } from "./components/broadcast/Broadcast";
import { Manage } from "./components/manage/Manage";
import { Navbar } from "./components/Navbar";
import { Toasts } from "./components/Toast";
import { Watch } from "./components/watch/Watch";
import { useAuthStore } from "./stores/auth";

type View = "broadcast" | "watch" | "manage";

const VIEWS: Array<{ id: View; label: string }> = [
  { id: "watch", label: "Watch" },
  { id: "broadcast", label: "Broadcast" },
  { id: "manage", label: "Manage VODs" },
];

export default function App() {
  const step = useAuthStore((s) => s.step);
  const [view, setView] = useState<View>("watch");

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <div className="flex-1 flex flex-col">
        {step === "connected" ? (
          <>
            <div className="flex gap-2 px-6 pt-4 max-w-5xl mx-auto w-full">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setView(v.id)}
                  className={`px-3 py-1.5 text-sm rounded-md ${
                    view === v.id
                      ? "bg-neutral-900 text-white"
                      : "text-neutral-600 hover:bg-neutral-100"
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            {view === "broadcast" && <Broadcast />}
            {view === "watch" && <Watch />}
            {view === "manage" && <Manage />}
          </>
        ) : (
          <AuthFlow />
        )}
      </div>
      <Toasts />
    </div>
  );
}
