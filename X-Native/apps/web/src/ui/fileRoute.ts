/** Only an explicit hash parameter opts a stored file into the Rust-owned
 * rectangle preview. Ordinary links, selection links and unsupported values
 * retain the production MemoryEngine route. */
export type FileRoute = { view: "home" } | { view: "file"; id: string; rust: boolean };

export function decideRouteChange(
  previous: FileRoute,
  next: FileRoute,
  hasRustEdits: boolean,
  confirmDiscard: () => boolean,
): "same-owner" | "cancel" | "switch" {
  if (previous.view === "file" && previous.rust && next.view === "file" &&
      next.rust && previous.id === next.id) return "same-owner";
  if (hasRustEdits && !confirmDiscard()) return "cancel";
  return "switch";
}

export function readRoute(hash = typeof window !== "undefined" ? window.location.hash : ""): FileRoute {
  const match = /^#\/file\/([^/?#]+)(?:\?([^#]*))?$/.exec(hash);
  if (!match) return { view: "home" };
  try {
    return {
      view: "file",
      id: decodeURIComponent(match[1]),
      rust: new URLSearchParams(match[2] ?? "").get("engine") === "rust",
    };
  } catch {
    return { view: "home" }; // malformed shared link, not a half-open file
  }
}
