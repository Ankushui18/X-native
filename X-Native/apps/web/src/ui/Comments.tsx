import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CommentThread, Engine } from "../engine/types";

/** Screen position of a page-space point. */
function toScreen(x: number, y: number, zoom: number, panX: number, panY: number) {
  return { left: panX + x * zoom, top: panY + y * zoom };
}

function initials(body: string) {
  const t = body.trim();
  return t ? t[0].toUpperCase() : "?";
}

function ago(at: number) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The composer shown while placing a brand new comment. */
function Draft({
  at,
  zoom,
  panX,
  panY,
  onCancel,
  onSubmit,
}: {
  at: { x: number; y: number };
  zoom: number;
  panX: number;
  panY: number;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  // autoFocus alone is not enough: React applies it after paint, so the first
  // keystrokes of a fast typist land on <body> and are lost. Focus synchronously.
  useLayoutEffect(() => {
    // The click that creates the draft is still in flight: the canvas receives
    // mouseup after this mounts and the default action blurs us again. Focus on
    // the next frame, once that gesture has completed.
    const id = requestAnimationFrame(() => box.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  const pos = toScreen(at.x, at.y, zoom, panX, panY);
  return (
    <div className="cm-pop" style={{ left: pos.left + 14, top: pos.top - 6 }}>
      <textarea
        ref={box}
        className="cm-input"
        placeholder="Add a comment"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (body.trim()) onSubmit(body.trim());
          }
        }}
      />
      <div className="cm-actions">
        <span className="cm-hint">⏎ to post</span>
        <button className="cm-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="cm-btn primary" disabled={!body.trim()} onClick={() => onSubmit(body.trim())}>
          Post
        </button>
      </div>
    </div>
  );
}

/** An open thread: original message, replies, and a reply box. */
function Thread({
  t,
  engine,
  zoom,
  panX,
  panY,
  onClose,
}: {
  t: CommentThread;
  engine: Engine;
  zoom: number;
  panX: number;
  panY: number;
  onClose: () => void;
}) {
  const [reply, setReply] = useState("");
  const pos = toScreen(t.x, t.y, zoom, panX, panY);
  return (
    <div className="cm-pop" style={{ left: pos.left + 14, top: pos.top - 6 }}>
      <div className="cm-head">
        <span className="cm-av">{initials(t.body)}</span>
        <span className="cm-when">{ago(t.at)}</span>
        <button
          className="cm-icon"
          title={t.resolved ? "Mark unresolved" : "Mark resolved"}
          aria-label={t.resolved ? "Mark unresolved" : "Mark resolved"}
          onClick={() => engine.dispatch({ type: "resolveComment", id: t.id, resolved: !t.resolved })}
        >
          ✓
        </button>
        <button
          className="cm-icon"
          title="Delete thread"
          aria-label="Delete thread"
          onClick={() => engine.dispatch({ type: "deleteComment", id: t.id })}
        >
          ×
        </button>
      </div>
      <div className="cm-body">{t.body}</div>
      {t.replies.map((r) => (
        <div key={r.id} className="cm-reply">
          <span className="cm-av sm">{initials(r.body)}</span>
          <div>
            <div className="cm-body">{r.body}</div>
            <div className="cm-when">{ago(r.at)}</div>
          </div>
        </div>
      ))}
      <textarea
        className="cm-input"
        placeholder="Reply"
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (reply.trim()) {
              engine.dispatch({ type: "replyComment", id: t.id, body: reply.trim() });
              setReply("");
            }
          }
        }}
      />
    </div>
  );
}

/** Comment pin layer drawn above the canvas. */
export function Comments({
  threads,
  engine,
  zoom,
  panX,
  panY,
  openId,
  draft,
  onDraftDone,
}: {
  threads: CommentThread[];
  engine: Engine;
  zoom: number;
  panX: number;
  panY: number;
  openId: string;
  draft: { x: number; y: number } | null;
  onDraftDone: () => void;
}) {
  const open = threads.find((t) => t.id === openId) ?? null;
  const host = useRef<HTMLDivElement>(null);

    // Clicking anywhere outside a popover closes it.
  useEffect(() => {
    if (!open && !draft) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest(".cm-pop") || el.closest(".cm-pin")) return;
      if (draft) onDraftDone();
      else engine.dispatch({ type: "openComment", id: "" });
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [open, draft, engine, onDraftDone]);

  return (
    <div className="cm-layer" ref={host}>
      {threads.map((t) => {
        const pos = toScreen(t.x, t.y, zoom, panX, panY);
        return (
          <button
            key={t.id}
            className={`cm-pin${t.resolved ? " done" : ""}${t.id === openId ? " on" : ""}`}
            style={{ left: pos.left, top: pos.top }}
            title={t.body}
            aria-label={`Comment: ${t.body}`}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              // Drag to re-anchor the pin. A press that never moves is treated
              // as a click, so opening a thread still works — hence the 3px
              // threshold rather than dragging from the first pixel.
              const startX = e.clientX;
              const startY = e.clientY;
              const box = host.current?.getBoundingClientRect();
              let moved = false;
              const move = (ev: MouseEvent) => {
                if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
                moved = true;
                engine.dispatch({
                  type: "moveComment",
                  id: t.id,
                  x: (ev.clientX - (box?.left ?? 0) - panX) / zoom,
                  y: (ev.clientY - (box?.top ?? 0) - panY) / zoom,
                });
              };
              const up = () => {
                window.removeEventListener("mousemove", move);
                window.removeEventListener("mouseup", up);
                if (!moved) {
                  engine.dispatch({ type: "openComment", id: t.id === openId ? "" : t.id });
                }
              };
              window.addEventListener("mousemove", move);
              window.addEventListener("mouseup", up);
            }}
          >
            {initials(t.body)}
          </button>
        );
      })}
      {open && (
        <Thread
          t={open}
          engine={engine}
          zoom={zoom}
          panX={panX}
          panY={panY}
          onClose={() => engine.dispatch({ type: "openComment", id: "" })}
        />
      )}
      {draft && (
        <Draft
          at={draft}
          zoom={zoom}
          panX={panX}
          panY={panY}
          onCancel={onDraftDone}
          onSubmit={(body) => {
            engine.dispatch({ type: "addComment", x: draft.x, y: draft.y, body });
            onDraftDone();
          }}
        />
      )}
    </div>
  );
}
