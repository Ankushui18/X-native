//! Lucide icon set (https://lucide.dev) — stroke icons, 24x24 grid,
//! constant 1.5 device-px stroke with rounded caps/joins — the same
//! library and geometry the HTML source-of-truth files load via
//! `data-lucide`, at the shared `IconScale` weight.
//!
//! Icons are stored as SVG path data (24x24 viewBox) and parsed once;
//! `draw_icon` scales them to the requested pixel size. The X logo paths
//! are lifted verbatim from the HTML files' inline SVG.

use std::collections::HashMap;
use std::sync::OnceLock;
use vello::kurbo::{Affine, BezPath, Stroke};
use vello::peniko::Color;
use vello::Scene;

/// Lucide path data per icon name (24x24 user units).
/// Single source of truth for the icon set: (name, Lucide path data)
/// pairs on the 24x24 design grid. Both `src()` (name lookup) and the
/// parse cache derive from this table, so a name that is not here
/// cannot be drawn — there is no second key list to drift. (The old
/// cache kept its own list; a name added to `src()` but not to the
/// cache rendered as a silent no-op. Audit F1.)
const ICONS: &[(&str, &[&str])] = &[
    ("search", &["M21 21l-4.34-4.34", "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z"]),
    ("plus", &["M5 12h14", "M12 5v14"]),
    ("minus", &["M5 12h14"]),
    ("line", &["M5 19 19 5"]),
    ("x", &["M18 6 6 18", "m6 6 12 12"]),
    ("chevron-down", &["m6 9 6 6 6-6"]),
    ("chevron-up", &["m18 15-6-6-6 6"]),
    ("chevron-right", &["m9 18 6-6-6-6"]),
    ("arrow-down", &["M12 5v14", "m19 12-7 7-7-7"]),
    // Figma's Arrow tool (⇧L): "the same segment, ending in the solid head
    // the shape menu's arrow draws" — a shaft with a V head, like the
    // arrow-up/-down/-right glyphs beside it. The old binding wore Lucide's
    // `arrow-up-right`, whose head arms run 10 units along the box edges and
    // read as a corner bracket ("open elsewhere"), not as a head on a shaft.
    ("arrow-up-right", &["M5 19 19 5", "M12 5h7v7"]),
    ("arrow-left-right", &["M8 3 4 7l4 4", "M4 7h16", "m16 21 4-4-4-4", "M20 17H4"]),
    ("arrow-up-down", &["m21 16-4 4-4-4", "M17 20V4", "m3 8 4-4 4 4", "M7 4v16"]),
    ("more-horizontal", &[
        "M19 12a1 1 0 1 0-2 0 1 1 0 0 0 2 0z",
        "M13 12a1 1 0 1 0-2 0 1 1 0 0 0 2 0z",
        "M7 12a1 1 0 1 0-2 0 1 1 0 0 0 2 0z",
    ]),
    ("more-vertical", &[
        "M13 5a1 1 0 1 0-2 0 1 1 0 0 0 2 0z",
        "M13 19a1 1 0 1 0-2 0 1 1 0 0 0 2 0z",
        "M13 12a1 1 0 1 0-2 0 1 1 0 0 0 2 0z",
    ]),
    ("box", &[
        "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
        "m3.3 7 8.7 5 8.7-5",
        "M12 22V12",
    ]),
    ("layout-dashboard", &[
        "M10 3H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1z",
        "M20 3h-6a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1z",
        "M20 13h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1z",
        "M10 16H4a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1z",
    ]),
    ("clock", &["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 6v6l4 2"]),
    ("square-round-corner", &[
        "M21 11a8 8 0 0 0-8-8",
        "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",
    ]),
    // Figma's Polygon glyph: a regular pentagon. The Polygon tool's default
    // is a triangle, but Figma's toolbar shows five sides — the old binding
    // wore Lucide's `triangle`, which is the shape the tool draws, not the
    // tool's own mark. Regular pentagon, centre (12,12), r=9, point up.
    ("polygon", &["M12 3 20.6 9.2 17.3 19.3 6.7 19.3 3.4 9.2Z"]),
    // Figma's Scale glyph (K): a box with a diagonal double-headed arrow —
    // "the whole layer scales", which is what separates it from Move. Lucide's
    // `maximize` (four outward corners) reads as expand/fullscreen instead.
    ("scale", &[
        "M5 9V7a2 2 0 0 1 2-2h2",
        "M19 15v2a2 2 0 0 1-2 2h-2",
        "M8 16 16 8",
        "M16 13V8h-5",
    ]),
    // Figma's Slice glyph: a bracketed region cut by a blade line — "a region
    // whose only job is to be exported". The old binding wore Lucide's
    // `scissors`, which is Figma's CUT action, so the same metaphor meant two
    // different things in our chrome.
    ("slice", &[
        "M4 8V6a2 2 0 0 1 2-2h2",
        "M20 8V6a2 2 0 0 0-2-2h-2",
        "M4 16v2a2 2 0 0 0 2 2h2",
        "M20 16v2a2 2 0 0 1-2 2h-2",
        "M4 12h16",
    ]),
    ("triangle", &[
        "M13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z",
    ]),
    // Figma's Star glyph: five points at the ratio the Star tool itself
    // defaults to — `booleans::STAR_RATIO` = 0.382, "the distance of the inner
    // points from the centre" — so the tool's mark is the shape the tool
    // draws, on the same rule the polygon glyph follows. Outer r=9 about
    // (12,12), point up; Lucide's star sits at 0.486 and reads chunkier than
    // the shape it stands for.
    ("star", &[
        "M12 3L14.02 9.22L20.56 9.22L15.27 13.06L17.29 19.28L12 15.44L6.71 19.28L8.73 13.06L3.44 9.22L9.98 9.22Z",
    ]),
    ("trash-2", &[
        "M3 6h18",
        "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
        "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
        "M10 11v6",
        "M14 11v6",
    ]),
    ("sparkles", &[
        "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
        "M20 3v4",
        "M22 5h-4",
    ]),
    ("grid-2x2", &[
        "M18 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z",
        "M3 12h18",
        "M12 3v18",
    ]),
    ("layout-grid", &[
        "M8 3H5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z",
        "M19 3h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z",
        "M19 14h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2z",
        "M8 14H5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2z",
    ]),
    ("list", &["M8 6h13", "M8 12h13", "M8 18h13", "M4 6h.01", "M4 12h.01", "M4 18h.01"]),
    ("import", &["M12 3v11", "m8 10 4 4 4-4", "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"]),
    ("layout-template", &[
        "M6 3h12a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
        "M6 13h5a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z",
        "M17 13h1a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z",
    ]),
    ("users", &[
        "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
        "M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
        "M22 21v-2a4 4 0 0 0-3-3.87",
        "M16 3.13a4 4 0 0 1 0 7.75",
    ]),
    ("user", &["M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"]),
    ("file", &[
        "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
        "M14 2v4a2 2 0 0 0 2 2h4",
    ]),
    ("file-text", &[
        "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
        "M14 2v4a2 2 0 0 0 2 2h4",
        "M10 9H8",
        "M16 13H8",
        "M16 17H8",
    ]),
    ("home", &["m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M9 22V12h6v10"]),
    ("pencil", &[
        "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
        "m15 5 4 4",
    ]),
    ("brush", &[
        "m14.622 17.897-10.68-2.913",
        "M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z",
        "M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15",
    ]),
    ("mouse-pointer-2", &[
        "M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z",
    ]),
    ("type", &["M4 7V4h16v3", "M9 20h6", "M12 4v16"]),
    ("square", &["M18 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"]),
    ("circle", &["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"]),
    ("pen-tool", &[
        "m12 19 7-7 3 3-7 7-3-3z",
        "m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z",
        "m2 2 7.586 7.586",
        "M13 11a2 2 0 1 0-4 0 2 2 0 0 0 4 0z",
    ]),
    ("hand", &[
        "M18 11V6a2 2 0 0 0-4 0",
        "M14 10V4a2 2 0 0 0-4 0v2",
        "M10 10.5V6a2 2 0 0 0-4 0v8",
        "M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15",
    ]),
    // Figma's Comment is a rounded-square bubble with its tail at the bottom-
    // left, not Lucide's circular one — the angular tail is what reads as
    // "pin a note to a spot" rather than "chat".
    ("message-circle", &["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"]),
    ("history", &["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M12 7v5l4 2"]),
    ("play", &["M6 3l14 9-14 9z"]),
    ("pipette", &[
        "m2 22 1-1h3l9-9",
        "M3 21v-3l9-9",
        "m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z",
    ]),
    ("eye", &[
        "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z",
        "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    ]),
    ("eye-off", &[
        "M9.88 9.88a3 3 0 1 0 4.24 4.24",
        "M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68",
        "M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61",
        "M2 2l20 20",
    ]),
    ("chevrons-up", &["m17 11-5-5-5 5", "m17 18-5-5-5 5"]),
    ("chevrons-down", &["m7 6 5 5 5-5", "m7 13 5 5 5-5"]),
    ("lock", &[
        "M20 13v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z",
        "M7 11V7a5 5 0 0 1 10 0v4",
    ]),
    ("rotate-cw", &["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"]),
    ("maximize-2", &["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"]),
    ("align-left", &["M21 6H3", "M15 12H3", "M17 18H3"]),
    ("code", &["M16 18 22 12 16 6", "M8 6 2 12 8 18"]),
    ("check", &["M20 6 9 17l-5-5"]),
    ("copy", &[
        "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z",
        "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
    ]),
    ("scissors", &[
        "M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
        "M8.12 8.12 12 12",
        "M20 4 8.12 15.88",
        "M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
        "M14.8 14.8 20 20",
    ]),
    ("clipboard", &[
        "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z",
        "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
    ]),
    ("copy-plus", &[
        "M15 12v6",
        "M12 15h6",
        "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z",
        "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
    ]),
    ("box-select", &[
        "M5 3a2 2 0 0 0-2 2",
        "M19 3a2 2 0 0 1 2 2",
        "M21 19a2 2 0 0 1-2 2",
        "M5 21a2 2 0 0 1-2-2",
        "M9 3h1",
        "M14 3h1",
        "M9 21h1",
        "M14 21h1",
        "M3 9v1",
        "M21 9v1",
        "M3 14v1",
        "M21 14v1",
        "M8 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z",
    ]),
    ("group", &[
        "M3 7V5c0-1.1.9-2 2-2h2",
        "M17 3h2c1.1 0 2 .9 2 2v2",
        "M21 17v2c0 1.1-.9 2-2 2h-2",
        "M7 21H5c-1.1 0-2-.9-2-2v-2",
        "M8 7h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z",
        "M11 12h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z",
    ]),
    ("ungroup", &[
        "M13 14h6a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-6a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z",
        "M5 3h6a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    ]),
    ("align-center", &["M17 6H7", "M21 12H3", "M15 18H9"]),
    ("align-right", &["M21 6H3", "M21 12H9", "M21 18H7"]),
    ("sliders-horizontal", &[
        "M21 4h-7",
        "M10 4H3",
        "M21 12h-9",
        "M8 12H3",
        "M21 20h-5",
        "M12 20H3",
        "M14 2v4",
        "M8 10v4",
        "M16 18v4",
    ]),
    ("shopping-cart", &[
        "M8 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
        "M19 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
        "M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12",
    ]),
    ("bar-chart-3", &["M3 3v16a2 2 0 0 0 2 2h16", "M18 17V9", "M13 17V5", "M8 17v-3"]),
    ("image", &[
        "M18 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z",
        "M9 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
        "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
    ]),
    ("component", &[
        "M5.5 8.5 9 12l-3.5 3.5L2 12l3.5-3.5Z",
        "m12 2 3.5 3.5L12 9 8.5 5.5 12 2Z",
        "M18.5 8.5 22 12l-3.5 3.5L15 12l3.5-3.5Z",
        "m12 15 3.5 3.5L12 22l-3.5-3.5L12 15Z",
    ]),
    // Figma's Frame glyph is a `#`. The key is spelled `frame-hash` rather
    // than `frame#`: the icon vocabulary is `[a-z0-9-]`, and a `#` in the key
    // is invisible to `extract_icons.mjs`, so the design sheet had no glyph to
    // draw for the Frame tool.
    ("frame-hash", &["M2 8h20", "M2 16h20", "M8 2v20", "M16 2v20"]),
    ("arrow-right", &["M5 12h14", "m12 5 7 7-7 7"]),
    ("arrow-up", &["M5 12h14", "m12 19-7-7 7-7"]),
    ("download", &["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"]),
    ("file-plus", &[
        "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
        "M14 2v4a2 2 0 0 0 2 2h4",
        "M12 18v-6",
        "M9 15h6",
    ]),
    ("folder-open", &[
        "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
    ]),
    ("frame", &["M22 6H2", "M6 2v4", "M6 18v4", "M18 2v4", "M18 18v4"]),
    // Figma's Section: a rounded container with its title's first stroke
    // inside the top-left corner — the labelled box the tool draws.
    // Figma's Section glyph: a DASHED square — the container whose whole job
    // is to hold layers, drawn as an outline that is not a solid boundary.
    // Eight short runs on the 24 grid; the old glyph was a solid rounded
    // square with a label tick, which read as a frame, not a section.
    ("section", &[
        "M8 4H6a2 2 0 0 0-2 2v2",
        "M16 4h2a2 2 0 0 1 2 2v2",
        "M20 16v2a2 2 0 0 1-2 2h-2",
        "M8 20H6a2 2 0 0 1-2-2v-2",
        "M11 4h2",
        "M11 20h2",
        "M4 11v2",
        "M20 11v2",
    ]),
    ("keyboard", &[
        "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
        "M6.5 8a.5.5 0 1 0-1 0 .5.5 0 0 0 1 0z",
        "M10.5 8a.5.5 0 1 0-1 0 .5.5 0 0 0 1 0z",
        "M14.5 8a.5.5 0 1 0-1 0 .5.5 0 0 0 1 0z",
        "M8.5 12a.5.5 0 1 0-1 0 .5.5 0 0 0 1 0z",
        "M12.5 12a.5.5 0 1 0-1 0 .5.5 0 0 0 1 0z",
        "M16.5 12a.5.5 0 1 0-1 0 .5.5 0 0 0 1 0z",
        "M7 16h10",
    ]),
    ("layout-list", &[
        "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
        "M12 3v18",
        "M3 9h15",
        "M3 15h15",
    ]),
    ("maximize", &[
        "M8 3H5a2 2 0 0 0-2 2v3",
        "M21 8V5a2 2 0 0 0-2-2h-3",
        "M3 16v3a2 2 0 0 0 2 2h3",
        "M16 21h3a2 2 0 0 0 2-2v-3",
    ]),
    ("mouse-pointer", &[
        "M12.586 12.586 19 19",
        "M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l2.56-9.439a.5.5 0 0 1 .283-.283l9.438-2.559a.501.501 0 0 0 .063-.947z",
    ]),
    ("redo", &["m15 14 5-5-5-5", "M20 9H9.5A5.5 5.5 0 0 0 4 14.5a5.5 5.5 0 0 0 5.5 5.5H13"]),
    ("eraser", &[
        "m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21",
        "M22 21H7",
        "m5 11 9 9",
    ]),
    ("reflect-vertical", &[
        "M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3",
        "M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3",
        "M12 20v2",
        "M12 14v2",
        "M12 8v2",
        "M12 2v2",
    ]),
    ("sticky-note", &[
        "M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z",
        "M15 3v6h6",
    ]),
    ("repeat", &[
        "m17 2 4 4-4 4",
        "M3 11v-1a4 4 0 0 1 4-4h14",
        "m7 22-4-4 4-4",
        "M21 13v1a4 4 0 0 1-4 4H3",
    ]),
    ("rotate-ccw", &["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"]),
    (
        "flip-horizontal",
        &[
            "M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3",
            "M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3",
            "M12 2v2",
            "M12 8v2",
            "M12 14v2",
            "M12 20v2",
        ],
    ),
    (
        "flip-vertical",
        &[
            "M21 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v3",
            "M21 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3",
            "M2 12h2",
            "M8 12h2",
            "M14 12h2",
            "M20 12h2",
        ],
    ),
    ("save", &[
        "M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
        "M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7",
        "M7 3v4a1 1 0 0 0 1 1h7",
    ]),
    ("target", &[
        "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z",
        "M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z",
        "M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
    ]),
    ("trash", &[
        "M3 6h18",
        "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
        "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
    ]),
    ("undo", &["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"]),
    ("zoom-in", &[
        "M21 21l-4.34-4.34",
        "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z",
        "M11 8v6",
        "M8 11h6",
    ]),
    ("zoom-out", &["M21 21l-4.34-4.34", "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "M8 11h6"]),
];

fn src(name: &str) -> &'static [&'static str] {
    ICONS
        .iter()
        .find(|(k, _)| *k == name)
        .map(|(_, p)| *p)
        .unwrap_or(&[])
}

fn cache() -> &'static HashMap<&'static str, Vec<BezPath>> {
    static CACHE: OnceLock<HashMap<&'static str, Vec<BezPath>>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let mut m = HashMap::new();
        for (key, data) in ICONS {
            let paths = data
                .iter()
                .filter_map(|d| BezPath::from_svg(d).ok())
                .collect();
            m.insert(*key, paths);
        }
        m
    })
}

/// Draw a Lucide icon: 24x24 design units scaled to `size` px at (x, y),
/// stroked with round caps/joins at a CONSTANT 1.5 device px — the
/// [`x_native::ui::IconScale`] stroke weight — regardless of the drawn
/// size. (A fixed design-unit width would render hairlines at 12px and
/// blobs at 24px; dividing by the scale keeps every icon on-weight.)
pub fn draw_icon(scene: &mut Scene, name: &str, x: f64, y: f64, size: f64, color: Color) {
    if !size.is_finite() || size <= 0.0 {
        return;
    }
    let paths = match cache().get(name) {
        Some(p) if !p.is_empty() => p,
        _ => return,
    };
    let s = size / 24.0;
    let t = Affine::translate((x, y)) * Affine::scale(s);
    let w = x_native::ui::IconScale::default().stroke_width / s;
    let stroke = Stroke::new(w)
        .with_caps(vello::kurbo::Cap::Round)
        .with_join(vello::kurbo::Join::Round);
    for p in paths {
        scene.stroke(&stroke, t, color, None, p);
    }
}

/// The 28x28 X logo from the HTML source of truth: rounded rect #1A1A1A,
/// green stroke-half, white stroke-half (exact path data from the files).
/// The ✦ glyph in the .md tab badge — Inter's latin subset has no U+2726,
/// so the 4-point star is drawn as a path matched to the Chromium render
/// (12×12 badge, ~6.5px glyph, center = badge center).
pub fn draw_md_star(scene: &mut Scene, cx: f64, cy: f64, r: f64, color: Color) {
    let k = 0.21 * r;
    let mut p = BezPath::new();
    p.move_to((cx, cy - r));
    p.curve_to((cx + k, cy - k), (cx + k, cy - k), (cx + r, cy));
    p.curve_to((cx + k, cy + k), (cx + k, cy + k), (cx, cy + r));
    p.curve_to((cx - k, cy + k), (cx - k, cy + k), (cx - r, cy));
    p.curve_to((cx - k, cy - k), (cx - k, cy - k), (cx, cy - r));
    p.close_path();
    scene.fill(
        vello::peniko::Fill::NonZero,
        Affine::IDENTITY,
        color,
        None,
        &p,
    );
}

pub fn draw_logo(scene: &mut Scene, x: f64, y: f64, size: f64) {
    use crate::theme::{C_FIELD, C_LOGO_GREEN, C_TEXT};
    let r = vello::kurbo::RoundedRect::new(x, y, x + size, y + size, size * (4.0 / 24.0));
    let _ = crate::theme::R_LOGO;
    scene.fill(
        vello::peniko::Fill::NonZero,
        Affine::IDENTITY,
        C_FIELD,
        None,
        &r,
    );

    static GREEN: OnceLock<Option<BezPath>> = OnceLock::new();
    static WHITE: OnceLock<Option<BezPath>> = OnceLock::new();
    let green = GREEN.get_or_init(|| {
        BezPath::from_svg("M16.7072 6.01489L16.5894 6.17866L15.9515 7.08685V7.10174H15.9445L15.3205 8.00248L15.1818 8.19603L14.6826 8.91067L14.4191 9.29032L14.0447 9.8263L13.6564 10.3846L13.4137 10.7345L12.9006 11.4715L12.7758 11.6427L12.1448 12.5509L12.131 12.5583L11.5 13.4591L11.6317 13.6452L12.131 14.3672L12.3875 14.7395L12.7619 15.2754L13.1433 15.8263L13.3929 16.1836L13.906 16.9132L14.0308 17.0918L14.6687 18H15.9307H17.1995H18.4684L17.8374 17.0844L17.7126 16.9057L17.1995 16.1762L16.9499 15.8189L16.5686 15.268L16.1941 14.732L15.9376 14.3598L15.4384 13.6377L15.3066 13.4442L15.9376 12.5434L16.5755 11.6203L16.6934 11.4491L17.2065 10.7122L17.4492 10.3623L17.8374 9.80397L18.2119 9.26799L18.4753 8.88834L18.9746 8.1737L19.1133 7.98015L19.7373 7.08685V7.07196L20.3821 6.16377L20.5 6H16.6934L16.7072 6.01489Z").ok()
    });
    let white = WHITE.get_or_init(|| {
        BezPath::from_svg("M8.90422 15.8311L9.29124 15.2795L9.67123 14.7429L9.93159 14.3702L10.4382 13.6472L10.5719 13.4609L11.2123 12.559L11.8597 11.6348L11.9793 11.4634L12.5 10.7255L12.2467 10.3752L11.8526 9.81615L11.4726 9.2795L11.2052 8.89938L10.6986 8.18385L10.5579 7.99006L9.92455 7.0882V7.07329H9.91751L9.27013 6.16398L9.15051 6H5.31548L5.43511 6.16398L6.07545 7.07329V7.0882L6.72283 7.99006L6.86357 8.18385L7.37021 8.89938L7.63761 9.2795L8.01055 9.81615L8.40461 10.3752L8.65794 10.7255L8.13722 11.4634L8.01055 11.6348L7.37021 12.5441L6.72987 13.4534L6.59617 13.6398L6.08952 14.3627L5.82916 14.7354L5.44918 15.272L5.06216 15.8236L4.80883 16.1814L4.28812 16.9118L4.16145 17.0907L3.52111 18H3.5H4.78772H6.07545H7.36317L8.01055 17.0832L8.13722 16.9043L8.65794 16.1739L8.91126 15.8161L8.90422 15.8311Z").ok()
    });
    let s = size / 24.0;
    let t = Affine::translate((x, y)) * Affine::scale(s);
    if let Some(p) = green {
        scene.fill(vello::peniko::Fill::NonZero, t, C_LOGO_GREEN, None, p);
    }
    if let Some(p) = white {
        scene.fill(vello::peniko::Fill::NonZero, t, C_TEXT, None, p);
    }
}

/// Custom mini SVGs used by the Auto layout "Flow" buttons in the HTML
/// (drawn as explicit rects, exactly as the inline SVGs do).
pub fn draw_flow_glyph(scene: &mut Scene, kind: usize, x: f64, y: f64, color: Color) {
    let stroke = Stroke::new(1.2);
    let rr = |scene: &mut Scene, rx: f64, ry: f64, rw: f64, rh: f64| {
        let r = vello::kurbo::RoundedRect::new(x + rx, y + ry, x + rx + rw, y + ry + rh, 1.0);
        scene.stroke(&stroke, Affine::IDENTITY, color, None, &r);
    };
    match kind {
        0 => {
            // 18x14: two 6x6 boxes side by side at y=4
            rr(scene, 1.0, 4.0, 6.0, 6.0);
            rr(scene, 11.0, 4.0, 6.0, 6.0);
        }
        1 => {
            // 14x18: two 6x6 boxes stacked at x=4
            rr(scene, 4.0, 1.0, 6.0, 6.0);
            rr(scene, 4.0, 11.0, 6.0, 6.0);
        }
        2 => {
            // 18x14: three 6x3 bars
            rr(scene, 1.0, 2.0, 6.0, 3.0);
            rr(scene, 9.0, 2.0, 6.0, 3.0);
            rr(scene, 1.0, 8.0, 6.0, 3.0);
        }
        _ => {
            // 16x16: four 5x5 grid boxes
            rr(scene, 1.0, 1.0, 5.0, 5.0);
            rr(scene, 10.0, 1.0, 5.0, 5.0);
            rr(scene, 1.0, 10.0, 5.0, 5.0);
            rr(scene, 10.0, 10.0, 5.0, 5.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every icon name the UI references must resolve to at least one
    /// parsable path. `draw_icon` no-ops silently on a miss, so a name
    /// dropped from the set becomes an empty button with no error —
    /// this census is the regression net. Keep it in sync when the UI
    /// starts referencing a new icon.
    #[test]
    fn every_referenced_icon_resolves() {
        let names: &[&str] = &[
            "arrow-down",
            "arrow-left-right",
            "arrow-right",
            "arrow-up",
            "arrow-up-down",
            "arrow-up-right",
            "box",
            "box-select",
            "brush",
            "check",
            "chevron-down",
            "chevron-right",
            "chevron-up",
            "chevrons-down",
            "chevrons-up",
            "circle",
            "clipboard",
            "code",
            "component",
            "copy",
            "copy-plus",
            "download",
            "eraser",
            "eye-off",
            "file",
            "file-plus",
            "file-text",
            "flip-horizontal",
            "flip-vertical",
            "folder-open",
            "frame",
            "frame-hash",
            "grid-2x2",
            "group",
            "hand",
            "home",
            "image",
            "keyboard",
            "layout-grid",
            "layout-list",
            "layout-template",
            "line",
            "lock",
            "maximize",
            "maximize-2",
            "message-circle",
            "minus",
            "more-horizontal",
            "more-vertical",
            "mouse-pointer",
            "mouse-pointer-2",
            "pen-tool",
            "pencil",
            "play",
            "plus",
            "redo",
            "reflect-vertical",
            "repeat",
            "rotate-ccw",
            "rotate-cw",
            "save",
            "scissors",
            "search",
            "section",
            "sliders-horizontal",
            "sparkles",
            "square",
            "star",
            "sticky-note",
            "target",
            "trash",
            "trash-2",
            "triangle",
            "type",
            "undo",
            "ungroup",
            "x",
            "zoom-in",
            "zoom-out",
        ];
        for n in names {
            let data = src(n);
            assert!(!data.is_empty(), "icon {n:?} has no ICONS entry");
            let parsed = cache()
                .get(n)
                .unwrap_or_else(|| panic!("icon {n:?} missing from cache"));
            assert!(
                parsed.len() == data.len(),
                "icon {n:?}: {}/{} paths failed to parse",
                data.len() - parsed.len(),
                data.len()
            );
        }
        assert_eq!(
            names.len(),
            79,
            "census list drifted — recount when adding icons"
        );
    }

    /// The two glyphs redrawn to Figma's metaphors, pinned by *geometry*
    /// rather than by eye (master row 18.10) — the same rule the polygon
    /// glyph's census test follows: a tool's mark is the shape the tool makes.
    ///
    /// * the **Star** carries five points with the inner ones at
    ///   `booleans::STAR_RATIO` (0.382) — Figma's "distance of the inner
    ///   points from the centre", and the ratio this app's Star tool defaults
    ///   to, so the glyph and the shape it draws agree;
    /// * the **Arrow** is a shaft ending in a V head, like the
    ///   arrow-up/-down/-right glyphs beside it. Lucide's `arrow-up-right`
    ///   ran its head arms 10 units along the box edges, which reads as a
    ///   corner bracket ("open elsewhere") rather than a head on a shaft.
    #[test]
    fn the_star_and_arrow_glyphs_are_figmas_metaphors() {
        use vello::kurbo::{PathEl, Point};

        fn pts_of(d: &str) -> Vec<Point> {
            BezPath::from_svg(d)
                .expect("glyph parses")
                .elements()
                .iter()
                .filter_map(|el| match el {
                    PathEl::MoveTo(p) | PathEl::LineTo(p) => Some(*p),
                    _ => None,
                })
                .collect()
        }

        // --- the star: ten vertices, alternating outer/inner at 0.382
        let pts = pts_of(src("star")[0]);
        assert_eq!(pts.len(), 10, "a five-point star has ten vertices");
        let radius = |p: Point| ((p.x - 12.0) * (p.x - 12.0) + (p.y - 12.0) * (p.y - 12.0)).sqrt();
        let outer = pts.iter().copied().map(radius).fold(0.0f64, f64::max);
        let inner = pts.iter().copied().map(radius).fold(f64::MAX, f64::min);
        assert!(
            (outer - 9.0).abs() < 0.05,
            "the tips ride the polygon glyph's r=9, got {outer:.2}"
        );
        let ratio = inner / outer;
        assert!(
            (ratio - x_native::booleans::STAR_RATIO).abs() < 0.01,
            "the inner points sit at the Star tool's default ratio 0.382, got {ratio:.3}"
        );

        // --- the arrow: one shaft, and a head whose arms are equal and short
        let arrow = src("arrow-up-right");
        assert_eq!(arrow.len(), 2, "a shaft and a head");
        let shaft = pts_of(arrow[0]);
        let head = pts_of(arrow[1]);
        assert_eq!(shaft.len(), 2, "the shaft is one segment");
        assert_eq!(head.len(), 3, "a V head is two arms meeting at a tip");
        let tip = head[1];
        assert!(
            (tip.x - shaft[1].x).abs() < 0.01 && (tip.y - shaft[1].y).abs() < 0.01,
            "the head sits on the shaft's end"
        );
        let arm = |p: Point| ((p.x - tip.x) * (p.x - tip.x) + (p.y - tip.y) * (p.y - tip.y)).sqrt();
        assert!(
            (arm(head[0]) - arm(head[2])).abs() < 0.01,
            "the two arms are the same length"
        );
        assert!(
            arm(head[0]) < 8.0,
            "the arms are a head, not Lucide's 10-unit corner bracket: {:.1}",
            arm(head[0])
        );
    }

    /// Figma's Comment is a rounded-square bubble with an angular tail at the
    /// bottom-left — the tail is the metaphor ("pin a note to a spot"), so the
    /// glyph must carry one closed outline that actually drops to a corner.
    #[test]
    fn the_comment_glyph_is_a_tailed_bubble() {
        use vello::kurbo::{PathEl, Point};
        let path = BezPath::from_svg(src("message-circle")[0]).expect("comment parses");
        let closes = path
            .elements()
            .iter()
            .filter(|e| matches!(e, PathEl::ClosePath))
            .count();
        assert_eq!(closes, 1, "one closed bubble outline");
        let line_pts: Vec<Point> = path
            .elements()
            .iter()
            .filter_map(|e| match e {
                PathEl::MoveTo(p) | PathEl::LineTo(p) => Some(*p),
                _ => None,
            })
            .collect();
        assert!(
            line_pts
                .iter()
                .any(|p| (p.x - 3.0).abs() < 0.01 && (p.y - 21.0).abs() < 0.01),
            "the tail drops to the bottom-left corner (3,21)"
        );
    }

    /// An icon no UI references yet must still parse cleanly, or it is
    /// a time bomb for the day it does.
    #[test]
    fn every_table_icon_parses() {
        for (name, data) in ICONS {
            let parsed = cache()
                .get(name)
                .unwrap_or_else(|| panic!("icon {name:?} missing from cache"));
            assert!(
                parsed.len() == data.len(),
                "icon {name:?}: {}/{} paths failed to parse",
                data.len() - parsed.len(),
                data.len()
            );
        }
    }
}
