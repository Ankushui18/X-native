/**
 * Comments (Figma help 360041068574): C activates comment mode; addComment
 * pins a comment at a canvas location (body field); comments can be
 * resolved/replied/deleted; toggleComments shows/hides the thread panel.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  const engine = new MemoryEngine(false);
  engine.dispatch({ type: "setTool", tool: "comment" });
  t("C-key activates comment tool", engine.snapshot().tool === "comment");
  engine.dispatch({ type: "setTool", tool: "select" });
  t("V-key returns to select", engine.snapshot().tool === "select");
}

{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const frame = node("frame", "F", 0, 0, 400, 300);
  r.children.push(frame);
  engine.dispatch({ type: "addComment", x: 50, y: 50, body: "hello" });
  const pg = engine.snapshot().pages[0];
  t("addComment pins a comment on the page", pg.comments.length === 1);
  t("comment has the pinned x, y and body",
    pg.comments[0].x === 50 && pg.comments[0].y === 50 && pg.comments[0].body === "hello");
  t("comments start unresolved", pg.comments[0].resolved === false);
}

{
  const engine = new MemoryEngine(false);
  // Default showComments is false (from memory.ts:1512).
  t("default showComments is false", engine.snapshot().showComments === false);
  engine.dispatch({ type: "toggleComments" });
  t("toggleComments shows comments", engine.snapshot().showComments === true);
  engine.dispatch({ type: "toggleComments" });
  t("toggleComments hides comments", engine.snapshot().showComments === false);
}

{
  const engine = new MemoryEngine(false);
  engine.dispatch({ type: "addComment", x: 10, y: 10, body: "first" });
  const id = engine.snapshot().pages[0].comments[0].id;
  engine.dispatch({ type: "replyComment", id, body: "reply" });
  t("replyComment adds a reply", engine.snapshot().pages[0].comments[0].replies.length === 1);
  engine.dispatch({ type: "resolveComment", id, resolved: true });
  t("resolveComment marks comment resolved", engine.snapshot().pages[0].comments[0].resolved === true);
  engine.dispatch({ type: "deleteComment", id });
  t("deleteComment removes the comment", engine.snapshot().pages[0].comments.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
