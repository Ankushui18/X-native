/**
 * Headless checks for the PM-U1 dialog bus.
 *
 * The host is a React component and is covered by the behaviour suite; what
 * is worth testing without a DOM is the contract every call site depends on:
 * which value each cancel path produces, that nested questions resolve in the
 * order they were asked, and that a missing host fails loudly instead of
 * hanging the caller forever.
 *
 * Run with:  npx vite-node src/ui/__tests__/dialog.test.mjs
 */
import {
  askChoice,
  askConfirm,
  askPrompt,
  currentDialog,
  resetDialogs,
  resolveDialog,
  subscribeDialog,
} from "../dialog.ts";

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
};

// Pretend to be DialogHost: a subscriber is what makes requests queue up
// rather than resolve immediately.
const off = subscribeDialog(() => {});
resetDialogs();

// ── what each dialog asks for ───────────────────────────────────────────────
{
  const p = askConfirm({
    title: "Delete mode",
    body: 'Delete mode "Mobile" and its overrides?',
    confirmLabel: "Delete",
    danger: true,
  });
  const req = currentDialog();
  t("confirm becomes the current request", req?.kind === "confirm");
  t("confirm carries its labels", req?.confirmLabel === "Delete" && req?.cancelLabel === "Cancel");
  t("confirm carries the danger flag", req?.danger === true);
  t("confirm carries its body", req?.body === 'Delete mode "Mobile" and its overrides?');
  resolveDialog(req, true);
  t("confirm resolves true on OK", (await p) === true);

  const p2 = askConfirm({ title: "New file", cancelLabel: "Keep" });
  resolveDialog(currentDialog(), null);
  t("confirm resolves false on cancel", (await p2) === false);
}

{
  const p = askPrompt({
    title: "Rename variable",
    label: "Name",
    value: "spacing-md",
    hint: "@name makes it an alias",
    confirmLabel: "Rename",
    validate: (v) => (v.trim() ? null : "Enter a name"),
  });
  const req = currentDialog();
  t("prompt keeps the initial value selected for overwrite", req?.value === "spacing-md");
  t("prompt carries label + hint", req?.label === "Name" && req?.hint === "@name makes it an alias");
  t("prompt carries its validator", typeof req?.validate === "function");
  t("prompt default cancel label is Cancel", req?.cancelLabel === "Cancel");
  resolveDialog(req, "  spacing-lg  ");
  t("prompt resolves the raw typed string", (await p) === "  spacing-lg  ");

  const p2 = askPrompt({ title: "Collection name", placeholder: "Collection 2" });
  t("prompt default confirm label is Save", currentDialog()?.confirmLabel === "Save");
  t("prompt carries a placeholder", currentDialog()?.placeholder === "Collection 2");
  t("prompt defaults to an empty value", currentDialog()?.value === "");
  resolveDialog(currentDialog(), null);
  t("prompt resolves null on cancel", (await p2) === null);

  const p3 = askPrompt({ title: "Offset path", value: "8" });
  resolveDialog(currentDialog(), "");
  t("an empty string is a real answer, not a cancel", (await p3) === "");
}

{
  const p = askChoice({
    title: "Create style from…",
    options: [
      { label: "Use the stroke", value: "stroke" },
      { label: "Use the fill", value: "fill" },
    ],
  });
  const req = currentDialog();
  t("choice becomes the current request", req?.kind === "choice");
  t("choice carries every option", req?.options?.length === 2);
  resolveDialog(req, "fill");
  t("choice resolves the picked value", (await p) === "fill");

  const p2 = askChoice({ title: "Property type", options: [{ label: "Boolean", value: "boolean" }] });
  resolveDialog(currentDialog(), null);
  t("choice resolves null when dismissed", (await p2) === null);
}

// ── queueing: the component-property flow asks twice in a row ───────────────
{
  const first = askPrompt({ title: "Property name" });
  const second = askPrompt({ title: "Child layer" });
  t("the first question is on screen", currentDialog()?.title === "Property name");
  t("the second waits its turn", currentDialog()?.title !== "Child layer");
  resolveDialog(currentDialog(), "Show icon");
  t("answering promotes the queued question", currentDialog()?.title === "Child layer");
  t("the first answer is not overwritten", (await first) === "Show icon");
  resolveDialog(currentDialog(), "");
  t("the queued question resolves on its own answer", (await second) === "");
  t("queue is empty afterwards", currentDialog() === null);
}

// ── settling twice (Escape and a click in the same tick) ────────────────────
{
  const p = askConfirm({ title: "Discard document" });
  const req = currentDialog();
  resolveDialog(req, true);
  resolveDialog(req, false);
  t("a double settle keeps the first answer", (await p) === true);
  t("a double settle does not touch the queue", currentDialog() === null);
  t("a stale request is ignored", (resolveDialog(req, true), currentDialog() === null));
}

// ── a missing host must not hang the caller ─────────────────────────────────
{
  off(); // nothing is listening: what a tree without <DialogHost /> looks like
  resetDialogs();
  const warn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  const confirmed = await askConfirm({ title: "Orphan confirm" });
  const typed = await askPrompt({ title: "Orphan prompt" });
  console.warn = warn;
  t("confirm without a host resolves false", confirmed === false);
  t("prompt without a host resolves null", typed === null);
  t("both warnings name the dialog that was dropped",
    warnings.length === 2 && warnings[0].includes("Orphan confirm") && warnings[1].includes("Orphan prompt"));
}

resetDialogs();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
