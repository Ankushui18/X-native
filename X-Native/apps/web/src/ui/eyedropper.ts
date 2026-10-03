import type { Engine, Snapshot, XNode } from "../engine/types";
import { uid } from "../engine/memory";
import { resolveVariable } from "../engine/variables";
import { askChoice, askPrompt } from "./dialog";
import { toast } from "./toast";
import { parseHex, type EyedropSource } from "./color";

export type EyedropTargetProperty = "fill" | "strokePaint";

/** Resolve semantic paint data from the topmost layer under the sampled pixel. */
export function eyedropSourceForNode(node: XNode | null, snap: Snapshot, hex: string): EyedropSource | undefined {
  if (!node) return undefined;
  const candidates: EyedropSource[] = [];
  const variables = snap.variables ?? [];
  for (const prop of ["fill", "strokePaint"] as const) {
    const variableId = node.ownBindings?.[prop] ?? node.variableBindings?.[prop];
    if (variableId) {
      const variable = variables.find((v) => v.id === variableId);
      const resolved = variable && resolveVariable(variables, snap.variableCollections ?? [], snap.activeModes ?? {}, variable.id);
      if (variable?.type === "color" && typeof resolved?.value === "string") {
        candidates.push({ kind: "variable", id: variable.id, name: variable.name, value: resolved.value, prop });
      }
    }
    const styleId = prop === "fill" ? node.fillStyle : node.strokeStyle;
    const style = styleId ? snap.styles.find((s) => s.id === styleId) : undefined;
    if (style?.color) candidates.push({ kind: "style", id: style.id, name: style.name, value: style.color, prop });
  }
  if (!candidates.length) return undefined;
  const sample = parseHex(hex);
  const distance = (value: string) => {
    const paint = parseHex(value);
    return (paint.r - sample.r) ** 2 + (paint.g - sample.g) ** 2 + (paint.b - sample.b) ** 2;
  };
  return candidates.reduce((best, candidate) => distance(candidate.value) < distance(best.value) ? candidate : best);
}

function grouped(engine: Engine, run: () => void) {
  engine.dispatch({ type: "begin" });
  try {
    run();
  } finally {
    engine.dispatch({ type: "end" });
  }
}

/** Apply the sampled source token to selected fill/stroke properties. */
export function applyEyedropSource(
  engine: Engine,
  ids: string[],
  target: EyedropTargetProperty,
  source: EyedropSource,
): boolean {
  if (!ids.length) return false;
  grouped(engine, () => {
    if (source.kind === "variable") {
      for (const id of ids) engine.dispatch({ type: "bindVariable", id, prop: target, variableId: source.id });
    } else {
      engine.dispatch({ type: "select", ids });
      engine.dispatch({ type: "applyStyle", kind: target === "fill" ? "fill" : "stroke", styleId: source.id });
    }
  });
  return true;
}

/** Create a color variable from a sampled value and bind it to the targets. */
export function createEyedropVariable(
  engine: Engine,
  ids: string[],
  target: EyedropTargetProperty,
  hex: string,
  name: string,
): boolean {
  if (!ids.length || !name.trim()) return false;
  let created = false;
  grouped(engine, () => {
    let snap = engine.snapshot();
    let collection = snap.variableCollections?.find((c) => c.name === "Brand") ?? snap.variableCollections?.[0];
    if (!collection) {
      engine.dispatch({ type: "addCollection", name: "Colors" });
      snap = engine.snapshot();
      collection = snap.variableCollections?.find((c) => c.name === "Colors") ?? snap.variableCollections?.[0];
    }
    if (!collection) return;
    const id = uid("var");
    engine.dispatch({
      type: "addVariable",
      variable: { id, name: name.trim(), type: "color", value: hex.toLowerCase(), collection: collection.name },
    });
    for (const nodeId of ids) engine.dispatch({ type: "bindVariable", id: nodeId, prop: target, variableId: id });
    created = true;
  });
  return created;
}

/** Paint the sampled value, then create and apply a shared fill/stroke style. */
export function createEyedropStyle(
  engine: Engine,
  ids: string[],
  target: EyedropTargetProperty,
  hex: string,
  name: string,
): boolean {
  if (!ids.length || !name.trim()) return false;
  grouped(engine, () => {
    for (const id of ids) {
      engine.dispatch({
        type: "patch",
        id,
        patch: target === "fill" ? { fill: hex.toLowerCase(), fillVisible: true } : { strokePaint: hex.toLowerCase(), strokeVisible: true },
      });
    }
    engine.dispatch({ type: "select", ids });
    engine.dispatch({ type: "createStyle", kind: target === "fill" ? "fill" : "stroke", name: name.trim() });
  });
  return true;
}

/** Prompt for the Figma-style "create variable or style from this sample" action. */
export async function promptCreateEyedropToken(
  engine: Engine,
  ids: string[],
  target: EyedropTargetProperty,
  hex: string,
): Promise<void> {
  if (!ids.length) return;
  const choice = await askChoice({
    title: "Create from sampled color",
    body: `${hex.toUpperCase()} will be added to the selected paint.`,
    options: [
      { label: "Color variable", value: "variable", primary: true },
      { label: "Color style", value: "style" },
    ],
  });
  if (choice === null) return;
  const name = await askPrompt({
    title: choice === "variable" ? "Color variable name" : "Color style name",
    label: "Name",
    value: `Color ${hex.replace("#", "").toUpperCase()}`,
    confirmLabel: choice === "variable" ? "Create variable" : "Create style",
    validate: (value) => value.trim() ? null : "Enter a name.",
  });
  if (name === null) return;
  const created = choice === "variable"
    ? createEyedropVariable(engine, ids, target, hex, name)
    : createEyedropStyle(engine, ids, target, hex, name);
  if (created) toast(`Created ${choice === "variable" ? "variable" : "style"} ${name.trim()}`);
}

/** Clipboard representation for the eyedropper's deselected state. */
export function eyedropClipboardText(hex: string, source?: EyedropSource, shiftKey = false): string {
  const value = hex.toUpperCase();
  return shiftKey && source ? `${source.name} ${value}` : value;
}
