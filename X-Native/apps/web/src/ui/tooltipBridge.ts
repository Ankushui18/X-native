import { markShown, showDelay, splitShortcutLabel } from "./Tooltip";

/**
 * The app labels most of its controls with the native `title` attribute — icon
 * buttons, canvas tools, truncated labels. The shared Tooltip component cannot
 * reach those: the browser's own box waits ~1.5s, cannot be styled, drops the
 * shortcut, and never appears for keyboard users, so the product had two
 * tooltip systems that looked and behaved differently.
 *
 * Rewriting ~330 call sites is a wide, mechanical sweep. The bridge instead
 * adopts them at the moment of use:
 *
 *  - the title moves to `data-tip`, so the browser's unstyled box never appears,
 *  - a control with no other name gets `aria-label` — the accessible name the
 *    native tooltip was silently standing in for,
 *  - the shared `.tip` pill renders, with the same delay, style and shortcut
 *    chip as every component-wrapped control.
 *
 * The attribute is restored on leave, so anything else that reads `title`
 * (selectors, assistive tech, other tooling) still finds it.
 */

/** Controls whose label only exists as `title`. */
const LABELLABLE = "button, a[href], select, input, textarea, [role='button'], [role='menuitem'], [role='tab'], [role='menuitemradio']";

/** A control that shows no text of its own is nameless without `title`. */
function nameless(el: HTMLElement): boolean {
  return (
    !el.hasAttribute("aria-label") &&
    !el.hasAttribute("aria-labelledby") &&
    !(el.textContent || "").trim() &&
    !el.querySelector("img[alt]:not([alt=''])")
  );
}

/** Give every title-only control in `scope` the accessible name it lacks. Runs
 *  once on install and on newly inserted subtrees, so an icon button is named
 *  from the start rather than only after someone hovers it. */
export function nameTitleOnlyControls(scope: ParentNode): void {
  const found: HTMLElement[] = [];
  if (scope instanceof HTMLElement && scope.matches(`${LABELLABLE}[title]`)) found.push(scope);
  for (const el of scope.querySelectorAll<HTMLElement>(`${LABELLABLE}[title]`)) found.push(el);
  for (const el of found) {
    if (!nameless(el)) continue;
    el.setAttribute("aria-label", splitShortcutLabel(el.getAttribute("title") || "").label);
  }
}

export function installTooltipBridge(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};

  let anchor: HTMLElement | null = null;
  let timer = 0;

  /** A fresh node per showing, the way the component's portal does it. Reusing
   *  one node and toggling `display` leaves its pop-in animation parked on a
   *  stale frame, so hovering rendered the pill washed out (measured ~20%
   *  opaque). Creating it as it appears also means no idle node in the DOM. */
  const pill = (): HTMLDivElement => {
    document.getElementById("x-tip-bridge")?.remove();
    const el = document.createElement("div");
    el.id = "x-tip-bridge";
    el.className = "tip";
    el.dataset.static = "";
    el.setAttribute("role", "tooltip");
    document.body.appendChild(el);
    return el;
  };

  const adopt = (el: HTMLElement): string | null => {
    const text = el.dataset.tip ?? el.getAttribute("title");
    if (!text) return null;
    if (el.getAttribute("title")) {
      el.dataset.tip = text;
      el.removeAttribute("title");
    }
    if (nameless(el)) el.setAttribute("aria-label", splitShortcutLabel(text).label);
    return text;
  };

  const hide = () => {
    window.clearTimeout(timer);
    timer = 0;
    const current = anchor;
    if (current) markShown();
    anchor = null;
    document.getElementById("x-tip-bridge")?.remove();
    if (current) {
      const tip = current.dataset.tip;
      if (tip) {
        current.setAttribute("title", tip);
        delete current.dataset.tip;
      }
    }
  };

  const place = (el: HTMLElement, text: string) => {
    const box = pill();
    const { label, shortcut } = splitShortcutLabel(text);
    box.textContent = label;
    if (shortcut) {
      const sc = document.createElement("span");
      sc.className = "tip-sc";
      sc.textContent = shortcut;
      box.appendChild(sc);
    }
    const a = el.getBoundingClientRect();
    const t = box.getBoundingClientRect();
    let left = a.left + a.width / 2 - t.width / 2;
    // Above the control when there is room: most chrome is docked at the top
    // edge, where a fixed "above" placement would be clamped back down on top
    // of the control it describes.
    let top = a.top - t.height - 8;
    if (top < 6) top = Math.min(a.bottom + 8, window.innerHeight - t.height - 6);
    left = Math.max(6, Math.min(left, window.innerWidth - t.width - 6));
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  };

  const show = (el: HTMLElement, text: string, immediate: boolean) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (anchor === el) place(el, text);
    }, showDelay(immediate));
  };

  const target = (node: EventTarget | null): HTMLElement | null => {
    const el =
      node instanceof Element ? (node.closest("[title],[data-tip]") as HTMLElement | null) : null;
    if (!el || el.closest(".tip, .tip-host")) return null;
    return el;
  };

  const onOver = (e: Event) => {
    const el = target(e.target);
    if (!el) return;
    if (el === anchor) return;
    hide();
    const text = adopt(el);
    if (!text) return;
    anchor = el;
    show(el, text, false);
  };

  const onFocus = (e: Event) => {
    const el = target(e.target);
    if (!el) return;
    // Click-focus does not deserve a tooltip; keyboard focus does.
    if (!el.matches(":focus-visible")) return;
    hide();
    const text = adopt(el);
    if (!text) return;
    anchor = el;
    show(el, text, true);
  };

  /** Leaving a control hides it, but moving *within* one (onto its icon, say)
   *  fires `pointerout` too — that must not blink the pill off and re-arm the
   *  delay while the pointer is still on the control. */
  const onOut = (e: Event) => {
    if (!anchor) return;
    const to = (e as PointerEvent).relatedTarget;
    if (to instanceof Node && anchor.contains(to)) return;
    hide();
  };

  const onKey = (e: Event) => {
    if ((e as KeyboardEvent).key === "Escape") hide();
  };

  nameTitleOnlyControls(document);
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of Array.from(r.addedNodes)) {
        if (node instanceof Element) nameTitleOnlyControls(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("pointerover", onOver, true);
  document.addEventListener("pointerout", onOut, true);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("focusin", onFocus, true);
  document.addEventListener("focusout", hide, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);

  return () => {
    observer.disconnect();
    document.removeEventListener("pointerover", onOver, true);
    document.removeEventListener("pointerout", onOut, true);
    document.removeEventListener("pointerdown", hide, true);
    document.removeEventListener("focusin", onFocus, true);
    document.removeEventListener("focusout", hide, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", hide, true);
    window.removeEventListener("blur", hide);
    document.getElementById("x-tip-bridge")?.remove();
  };
}
