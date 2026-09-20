#!/usr/bin/env python3
"""Replicates `ColorTokens::contrast_audit` (crates/x-ui/src/theme.rs) exactly,
so a palette can be validated here before the Rust gate can be reached.

The Rust source of truth:
  TEXT_ROLES      8 roles @ 4.5
  SURFACE_ROLES   6 surfaces
  ACCENT_FILLS    on_accent on accent/accent_hover/accent_active @ 4.5
  LABEL_FILLS     on_danger on danger_fill @ 4.5
  INDICATOR_ROLES selection, focus_ring on surface @ 3.0
  => 8*6 + 3 + 1 + 2 = 54 pairs
"""
import sys

TEXT_ROLES = ["text_primary", "text_secondary", "text_dim", "accent_ink",
              "success", "warning", "danger", "text_placeholder"]
SURFACES = ["background", "canvas", "surface", "surface_elevated",
            "surface_hover", "surface_active"]
ACCENT_FILLS = ["accent", "accent_hover", "accent_active"]
INDICATORS = ["selection", "focus_ring"]


def chan(v):
    s = v / 255.0
    return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4


def lum(c):
    return 0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2])


def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = (la, lb) if la >= lb else (lb, la)
    return (hi + 0.05) / (lo + 0.05)


def hx(s):
    s = s.lstrip('#')
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def audit(pal):
    fails, pairs = [], 0
    for fg in TEXT_ROLES:
        for bg in SURFACES:
            pairs += 1
            r = ratio(pal[fg], pal[bg])
            if r + 1e-6 < 4.5:
                fails.append(f"{fg} on {bg} {r:.2f}:1 (needs 4.5:1)")
    for bg in ACCENT_FILLS:
        pairs += 1
        r = ratio(pal["on_accent"], pal[bg])
        if r + 1e-6 < 4.5:
            fails.append(f"on_accent on {bg} {r:.2f}:1 (needs 4.5:1)")
    pairs += 1
    r = ratio(pal["on_danger"], pal["danger_fill"])
    if r + 1e-6 < 4.5:
        fails.append(f"on_danger on danger_fill {r:.2f}:1 (needs 4.5:1)")
    for n in INDICATORS:
        pairs += 1
        r = ratio(pal[n], pal["surface"])
        if r + 1e-6 < 3.0:
            fails.append(f"{n} on surface {r:.2f}:1 (needs 3.0:1)")
    headroom = min(
        (ratio(pal[f], pal[s]) / 4.5 for f in TEXT_ROLES for s in SURFACES),
        default=0)
    return fails, pairs, headroom


GRAPHITE = {
    "background": "#090909", "canvas": "#060606", "surface": "#1b1d23",
    "surface_elevated": "#24262d", "surface_hover": "#2e313a",
    "surface_active": "#2e3038", "border": "#2a2c34",
    "border_strong": "#3a3d46", "text_primary": "#f2f3f7",
    "text_secondary": "#b0b5c1", "text_dim": "#9a9eaa",
    "text_placeholder": "#939aa6", "accent": "#6b49f5",
    "accent_hover": "#5b3ce0", "accent_active": "#4a2fc4",
    "accent_ink": "#b4a4ff", "on_accent": "#ffffff", "selection": "#7c5cfc",
    "focus_ring": "#a996ff", "success": "#4cd966", "warning": "#f0ad4e",
    "danger": "#ef9a94", "danger_fill": "#c0392b", "on_danger": "#ffffff",
}

if __name__ == "__main__":
    p = {k: hx(v) for k, v in GRAPHITE.items()}
    f, n, h = audit(p)
    print(f"SHIPPING GRAPHITE: {n} pairs, {len(f)} fail, headroom {h:.2f}x")
    for x in f:
        print("   ", x)
    print()
    print("white on Figma #0D99FF :", f"{ratio(hx('#ffffff'), hx('#0d99ff')):.2f}:1")
    print("Figma #0D99FF on #2C2C2C:", f"{ratio(hx('#0d99ff'), hx('#2c2c2c')):.2f}:1")
    print("Figma #B3B3B3 on #2C2C2C:", f"{ratio(hx('#b3b3b3'), hx('#2c2c2c')):.2f}:1")
    print()
    print("candidate accent FILLS (need white on top >= 4.5:1):")
    for c in ["#0d99ff", "#0b8ae6", "#0085e6", "#0b7fd4", "#0a6fb8",
              "#0c6fd1", "#0a66b3", "#006bbf", "#0b62a8", "#0d7fd0",
              "#0b77c9", "#0a72bd"]:
        print(f"   {c}  {ratio(hx('#ffffff'), hx(c)):.2f}:1")
