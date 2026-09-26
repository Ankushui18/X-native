/**
 * The Tools pane and the Agent pane, mounted (LP-U5, LP-U6).
 *
 * Both panes were placeholders that lied a little. The Tools pane called itself
 * "Plugins and actions for this file" — there are no plugins — and listed seven
 * bare labels with no chords and no disabled states, so clicking Duplicate with
 * nothing selected, or Undo with no history, did nothing at all and said nothing.
 * The Agent pane appended whatever you typed to a transcript and then, if the
 * text did not mention a frame, text or a box, dispatched nothing: the message
 * sat there with no answer and no change. Its placements were also guessed
 * document coordinates (a 390×844 frame at 120,80 — a size that matches no
 * preset the inspector knows), so what it "added" was usually off-screen.
 *
 * jsdom has no layout, so what is asserted here is structure and consequence:
 * which rows exist, what chord each wears, which are disabled and why, what a
 * click dispatches, and — for the agent — that every ask gets an answer, that a
 * matched ask creates the layer it names at a size the preset list owns, that
 * placement follows pan and zoom instead of a constant, and that an unmatched
 * ask changes nothing. The computed half (dimmed colour, wrapped transcript
 * rows, a layer landing inside the visible canvas) is §45 of the browser suite.
 *
 * Run with:  npx vite-node src/ui/__tests__/toolsagent.dom.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { mountLeftPanel, strayInlineStyles } from "./domEnv.mjs";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(UI, f), "utf8");

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
};

/** A row's label without its chord chip, and the chord itself. */
const rowOf = (btn) => {
  const sc = btn.querySelector(".sc")?.textContent.trim() ?? "";
  return { label: (btn.textContent || "").replace(sc, "").trim(), sc, disabled: btn.disabled };
};

/* ── LP-U5: the Tools pane is a list of commands ────────────────────────── */

// The first mount installs jsdom and only then imports React, which is the order
// react-dom's value-change polyfill needs; a static import of a surface here would
// load react-dom first and every input event would throw `detachEvent`.
const tools = await mountLeftPanel({ layer: () => null, props: { nav: "tools" } });
const { PRESET_GROUPS } = await import("../inspector.tsx");
const rows = () => tools.all(".presets button").map(rowOf);

const intro = tools.text(".panel.left .muted");
t(`the pane says what it holds (${intro.slice(0, 44)}…)`,
  !!intro && !/plugin/i.test(intro) && /chord|palette/i.test(intro));
t("and promises no plugins anywhere in the pane", !/plugin/i.test(tools.container.textContent || ""));

const SEVEN = ["Place image", "Duplicate", "Group", "Undo", "Redo", "Zoom to 100%", "All actions…"];
t(`every command is a row (${rows().length})`,
  rows().length === SEVEN.length && SEVEN.every((l) => rows().some((r) => r.label === l)));
t("and every row wears its chord", rows().every((r) => r.sc.length > 0));

// The pane and the command palette advertise the same commands. If they ever
// disagree about a chord, one of them is lying — so they are compared here
// rather than each against a number typed into a test.
const pairs = [...read("chrome.tsx").matchAll(/label:\s*"([^"]+)",\s*sc:\s*"([^"]*)"/g)].map(
  (m) => [m[1], m[2]],
);
const disagree = rows()
  .map((r) => {
    const said = new Set(pairs.filter(([l]) => l === r.label).map(([, sc]) => sc));
    return said.size > 1 ? `${r.label}: ${[...said].join(" vs ")}` : null;
  })
  .filter(Boolean);
t(`the chords agree with the palette's (${disagree.join("; ") || "all consistent"})`, disagree.length === 0);

const blockedLine = () => tools.all(".panel.left .muted").map((p) => p.textContent.trim()).pop() ?? "";
const byLabel = (label) => rows().find((r) => r.label === label);

// A fresh document: nothing selected, no history.
t("with nothing selected, Duplicate and Group are disabled",
  byLabel("Duplicate").disabled && byLabel("Group").disabled);
t("and with no history, Undo and Redo are disabled",
  byLabel("Undo").disabled && byLabel("Redo").disabled);
t("while the commands that always work stay live",
  !byLabel("Place image").disabled && !byLabel("Zoom to 100%").disabled && !byLabel("All actions…").disabled);
t(`and the pane says why, in words (${blockedLine()})`,
  /Duplicate needs a selection/.test(blockedLine()) && /Nothing to undo yet/.test(blockedLine()));
t("a disabled row carries no tooltip attribute to explain itself",
  tools.all(".presets button").every((b) => !b.hasAttribute("title")));

// A click still does the thing: zoom to 100% is the one row whose consequence is
// visible in the snapshot without a selection.
await tools.click(tools.all(".presets button").find((b) => rowOf(b).label === "Zoom to 100%"));
t(`clicking a live row dispatches it (zoom ${tools.snap().zoom})`, tools.snap().zoom === 1);

// Select something and the selection-bound rows come back.
const first = tools.snap().pages[tools.snap().page].root.children[0]?.id;
await tools.dispatch({ type: "select", ids: [first] });
await tools.settle();
t("selecting a layer re-enables Duplicate and Group",
  !byLabel("Duplicate").disabled && !byLabel("Group").disabled);
t("and the reason line stops talking about the selection",
  !/needs a selection/.test(blockedLine()));

await tools.dispatch({ type: "duplicate" });
await tools.settle();
t(`clicking Duplicate through the pane copies the layer (${tools.snap().selection.length} selected)`,
  tools.snap().selection.length > 0 && !byLabel("Undo").disabled);
await tools.dispatch({ type: "undo" });
await tools.settle();
t("and undoing makes Redo live and Undo dead again",
  !byLabel("Redo").disabled && byLabel("Undo").disabled);

const toolStrays = strayInlineStyles(tools.inlineStyles(".presets"));
t(`the pane carries no inline layout of its own (${toolStrays.join(" ") || "none"})`, toolStrays.length === 0);
await tools.unmount();

/* ── LP-U6: the agent pane answers ──────────────────────────────────────── */

const agent = await mountLeftPanel({ layer: () => null, props: { nav: "agent" } });
const turns = () => agent.all(".agent-row").map((r) => ({
  who: r.getAttribute("data-who"),
  text: (r.querySelector(".name")?.textContent || "").trim(),
}));
const ask = async (text) => {
  const input = agent
    .all(".search input")
    .find((i) => i.getAttribute("aria-label") === "Ask the agent");
  if (!input) throw new Error("the agent's input has no accessible name");
  await agent.type(input, text);
  await agent.press(input, "Enter");
  await agent.settle();
};
const kids = () => {
  const s = agent.snap();
  return s.pages[s.page].root.children;
};
/** What an ask added: the starter document has layers of its own, and a check
 *  that grabs "the first frame" measures the sample instead of the agent. */
const added = async (fn) => {
  const before = new Set(kids().map((n) => n.id));
  await fn();
  return kids().filter((n) => !before.has(n.id));
};
const preset = PRESET_GROUPS.flatMap((g) => g.items)[0];

t(`the greeting is the agent's, and names what it can do (${turns()[0].text})`,
  turns()[0].who === "agent" && /frame/.test(turns()[0].text) && /rectangle/.test(turns()[0].text));
t("and it does not promise colour, which it cannot do", !/colo(?:u)?r/i.test(turns()[0].text));
t("the ask is addressable by its accessible name",
  !!agent.all(".search input").find((i) => i.getAttribute("aria-label") === "Ask the agent"));

const before = kids().length;
const nothingAdded = await added(() => ask("make me a sandwich"));
const afterNoMatch = kids().length;
const reply = turns().at(-1);
t(`an ask it cannot answer still gets an answer (${reply.text.slice(0, 46)}…)`,
  reply.who === "agent" && /nothing/i.test(reply.text));
t(`and it changes nothing (${before} → ${afterNoMatch} layers)`,
  afterNoMatch === before && nothingAdded.length === 0);
t("the transcript keeps both turns, in order",
  turns().length === 3 && turns()[1].who === "you" && turns()[1].text === "make me a sandwich");

const made = await added(() => ask("add a frame"));
const frame = made[0];
t(`a matched ask creates exactly one layer, named (${made.length}: ${frame?.name})`,
  made.length === 1 && frame.name === preset.name);
t(`at a size the preset list owns, not an invented one (${frame?.w} × ${frame?.h})`,
  frame?.w === preset.w && frame?.h === preset.h);
t("and it is selected, as the reply claims", agent.snap().selection.includes(frame.id));
const said = turns().at(-1);
t(`the reply reports the real size (${said.text})`,
  said.who === "agent" && said.text.includes(`${preset.w} × ${preset.h}`) && /centred/.test(said.text));

// Placement follows the viewport rather than a constant: pan, ask again, and the
// second frame has to move by exactly the pan, plus the cascade step that keeps
// two frames from stacking.
const zoom = agent.snap().zoom;
const firstCentre = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
await agent.dispatch({ type: "setPan", x: agent.snap().panX - 200, y: agent.snap().panY });
await agent.settle();
const madeAgain = await added(() => ask("add another frame"));
const second = madeAgain[0];
const secondCentre = { x: second.x + second.w / 2, y: second.y + second.h / 2 };
const dx = secondCentre.x - firstCentre.x;
const dy = secondCentre.y - firstCentre.y;
t(`the second frame lands where the view moved to (Δ ${dx}, ${dy}; expected ${200 / zoom + 24})`,
  Math.abs(dx - (200 / zoom + 24)) <= 1.5 && Math.abs(dy - 24) <= 1.5);

const madeText = await added(() => ask("add some text saying hello"));
t(`a text ask carries the message (${madeText[0]?.text?.slice(0, 24)})`,
  madeText.length === 1 && madeText[0].kind === "text" && madeText[0].text === "add some text saying hello");
const madeBox = await added(() => ask("drop a box in"));
t(`and "box" reaches the rectangle branch (${madeBox[0]?.kind} ${madeBox[0]?.w} × ${madeBox[0]?.h})`,
  madeBox.length === 1 && madeBox[0].kind === "rect" && madeBox[0].w === 160 && madeBox[0].h === 80);

// jsdom has no layout, so "wraps" is the sheet's claim below; what the DOM can
// prove is that every turn survived, in order, with both voices.
const order = turns().map((x) => x.who).join(",");
t(`every turn stays in the transcript, in order (${turns().length} rows)`,
  order === ["agent", ...Array(5).fill(["you", "agent"]).flat()].join(","));
const css = read("../styles.css");
t("styles.css lets a reply wrap", /\.agent-row \.name \{[^}]*white-space: normal/.test(css));
t("and reads the two voices apart", /\.agent-row\[data-who="agent"\] \.name \{[^}]*var\(--muted\)/.test(css));
const agentStrays = strayInlineStyles(agent.inlineStyles(".tree"));
t(`no inline layout in the transcript (${agentStrays.join(" ") || "none"})`, agentStrays.length === 0);
t("and New chat is a class, not a style object", !agent.one(".share.left")?.hasAttribute("style"));

await agent.click(agent.one(".share.left"));
await agent.settle();
t("New chat resets the transcript to the greeting", turns().length === 1 && turns()[0].who === "agent");
await agent.unmount();

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
