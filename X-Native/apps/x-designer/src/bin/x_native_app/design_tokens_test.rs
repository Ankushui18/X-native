//! Design-system ratchet: the chrome paints through `crate::theme`'s role
//! vocabulary (`crate/x-ui/src/design_system.rs` is the single source of
//! truth), and this test is what keeps it that way.
//!
//! It scans the app's **production** paint code (everything before the first
//! `#[cfg(test)]`) for the three kinds of literals that used to accumulate:
//!
//! * a numeric corner radius in `fill_rrect` / `stroke_rrect`,
//! * a numeric optical size in `draw_icon`,
//! * a raw `Color::from_rgb8` / `from_rgba8` in a paint path.
//!
//! The ceilings are a ratchet, like `DEAD_CODE_CEILING` in
//! `scripts/check.sh`: fixing a literal means lowering the number here,
//! adding one means CI complains. The exceptions that remain are enumerated
//! with their reason — a literal is allowed when it describes *the user's
//! artwork* (a vector anchor, a board sticky colour, a watermark drawn on a
//! thumbnail) rather than the chrome, because a theme must never repaint what
//! the user drew.

use std::path::Path;

/// Files that paint chrome. `state.rs` and `theme.rs` own document content and
/// the token vocabulary itself, so they are listed with generous ceilings only
/// to catch a *paint* literal sneaking in.
const PAINTED: &[(&str, usize)] = &[
    // (file, raw-colour ceiling)
    ("dashboard.rs", 2),
    ("editor_ui.rs", 13),
    ("board_ui.rs", 3),
    ("loading.rs", 1),
    ("command.rs", 0),
    ("paint.rs", 2),
    ("run.rs", 4),
    ("state.rs", 22),
    ("icons.rs", 0),
    ("theme.rs", 24),
];

/// Corner radii that are allowed to stay literal, because they round something
/// in *document* space: vector anchors and their handles (1.0/1.5) and one
/// mock frame outline in a canvas preview (18.0). Anything else — and in
/// particular any value that is not on the radius ladder (2/4/6/8/12) — is a
/// chrome corner that must name a token.
const CANVAS_SPACE_RADII: &[f64] = &[1.0, 1.5, 18.0];

fn read(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/bin/x_native_app")
        .join(name);
    let src =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    // only production code: fixtures in `#[cfg(test)]` may build documents
    // out of literals, and pinning those numbers would make tests brittle
    // for no gain.
    match src.split_once("#[cfg(test)]") {
        Some((head, _)) => head.to_string(),
        None => src,
    }
}

/// Split a call's argument list on top-level commas.
fn split_args(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    for ch in body.chars() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                out.push(cur.clone());
                cur.clear();
                continue;
            }
            _ => {}
        }
        cur.push(ch);
    }
    out.push(cur);
    out
}

/// Yield `(line, argument list)` for every `callee(` call in `src`.
fn calls<'a>(src: &'a str, callee: &str) -> Vec<(usize, Vec<String>)> {
    let needle = format!("{callee}(");
    let mut found = Vec::new();
    let mut i = 0usize;
    while let Some(j) = src[i..].find(&needle).map(|k| k + i) {
        let mut depth = 1i32;
        let mut k = j + needle.len();
        let bytes = src.as_bytes();
        while k < bytes.len() && depth > 0 {
            match bytes[k] {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth -= 1,
                _ => {}
            }
            k += 1;
        }
        let body = &src[j + needle.len()..k.saturating_sub(1)];
        let line = src[..j].matches('\n').count() + 1;
        found.push((line, split_args(body)));
        i = k;
    }
    found
}

fn bare_float(arg: &str) -> Option<f64> {
    let a = arg.trim();
    if a.is_empty() || !a.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    a.parse::<f64>().ok()
}

/// Every `_rrect` radius / `draw_icon` size that is still written as a number.
fn raw_geometry(file: &str) -> (Vec<(usize, f64)>, Vec<(usize, f64)>) {
    let src = read(file);
    let mut radii = Vec::new();
    let mut icons = Vec::new();
    for callee in ["fill_rrect", "stroke_rrect"] {
        for (line, args) in calls(&src, callee) {
            if let Some(v) = args.get(2).and_then(|a| bare_float(a)) {
                radii.push((line, v));
            }
        }
    }
    for (line, args) in calls(&src, "draw_icon") {
        if let Some(v) = args.get(4).and_then(|a| bare_float(a)) {
            icons.push((line, v));
        }
    }
    (radii, icons)
}

fn raw_colours(file: &str) -> Vec<usize> {
    let src = read(file);
    let mut out: Vec<usize> = calls(&src, "Color::from_rgb8")
        .into_iter()
        .chain(calls(&src, "Color::from_rgba8"))
        .map(|(line, _)| line)
        .collect();
    out.sort_unstable();
    out
}

#[test]
fn chrome_paints_through_the_design_tokens() {
    // 1. icon sizes: every glyph in the chrome is on the optical ladder
    for (file, _) in PAINTED {
        let (_, icons) = raw_geometry(file);
        assert!(
            icons.is_empty(),
            "{file}: icon sizes must use the ICON_* steps, found {icons:?}"
        );
    }

    // 2. radii: only document-space corners may stay numeric
    let mut offenders = Vec::new();
    for (file, _) in PAINTED {
        let (radii, _) = raw_geometry(file);
        for (line, v) in radii {
            if !CANVAS_SPACE_RADII.contains(&v) {
                offenders.push(format!("{file}:{line} radius {v}"));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "chrome corners must use the R_* ladder (2/4/6/8/12); \
         document-space corners may use {CANVAS_SPACE_RADII:?}. Offenders: {offenders:?}"
    );

    // 3. colours: the ceilings are a ratchet — lower them, never raise them
    for (file, ceiling) in PAINTED {
        let found = raw_colours(file);
        assert!(
            found.len() <= *ceiling,
            "{file}: {} raw colour literals in paint code (ceiling {ceiling}) at lines {found:?} — \
             use a role from `crate::theme` (add one to ColorTokens if the role is missing)",
            found.len()
        );
    }
}

/// The vocabulary itself: every painted role must be a `ColorTokens` role or a
/// documented non-themeable literal (brand, avatar/team hues, canvas guides,
/// watermarks). A constant added here that is *not* derived from the palette
/// would silently stop following a theme switch.
#[test]
fn theme_constants_follow_the_palette_or_say_why_not() {
    let src = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/bin/x_native_app/theme.rs"),
    )
    .expect("read theme.rs");
    let production = src
        .split_once("#[cfg(test)]")
        .map(|(head, _)| head)
        .unwrap_or(src.as_str());

    let derived = production.matches("= rgb(role!(").count()
        + production.matches("= rgba(role!(").count()
        + production.matches("= C_").count();
    let literals = raw_colours("theme.rs").len();
    assert!(
        derived > literals,
        "theme.rs derives {derived} roles and states {literals} literals — a role \
         reached by a literal will not follow a theme switch"
    );

    // the non-themeable literals are exactly the content/brand set, and each
    // must say so — on its own line or in a comment directly above it
    let lines: Vec<&str> = production.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        let code = line.trim();
        if !(code.starts_with("pub const C_")
            && (code.contains("from_rgb8(") || code.contains("from_rgba8(")))
        {
            continue;
        }
        let name = code
            .trim_start_matches("pub const ")
            .split(':')
            .next()
            .unwrap_or("?");
        let above = i
            .checked_sub(1)
            .and_then(|j| lines.get(j))
            .map(|l| l.trim().starts_with("//"))
            .unwrap_or(false);
        assert!(
            line.contains("//") || above,
            "{name} is a literal color with no comment explaining why it is not a \
             palette role (brand, avatar, canvas guide, or watermark?)"
        );
    }
}
