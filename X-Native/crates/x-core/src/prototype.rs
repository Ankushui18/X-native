//! Prototyping model (Figma parity): interactions with triggers and actions,
//! overlays, flow starting points, and animation presets.
//!
//! A node carries zero or more [`Interaction`]s. Each pairs a [`Trigger`]
//! (what the user does) with an [`Action`] (what happens) plus transition
//! timing and an [`Animation`] preset. Frames can also be marked as flow
//! starting points via [`Node::is_starting_point`].

use crate::Node;

/// When an interaction fires.
///
/// The press trio mirrors Figma: `OnPress` is "while pressing" (fires on
/// pointer-down, and the player reverts its navigate/overlay effect on
/// release); `MouseUp` fires once on release with no revert (pair it with
/// a press that opens a menu to replicate drop-down navigation).
// No `Eq`: `WhenVideoHits` carries an f32 time, and f32 is only `PartialEq`.
#[derive(Debug, Clone, PartialEq)]
pub enum Trigger {
    OnClick,
    OnHover,
    OnPress,
    OnDrag,
    AfterDelay {
        ms: u32,
    },
    MouseEnter,
    MouseLeave,
    MouseUp,
    /// Figma's *Mouse down / Touch press*: the press itself, permanent and
    /// one-way — unlike [`Trigger::OnPress`], which reverts when the press
    /// ends. Figma documents the split (plugin API: "MOUSE_ENTER, MOUSE_LEAVE,
    /// MOUSE_UP and MOUSE_DOWN are permanent, one-way navigation") and lists
    /// it in the Prototype panel beside Mouse up (help 360040315773).
    MouseDown,
    /// Prototype-player key press (Figma "key" gamepad/keyboard trigger).
    /// `key` is a single character ("a", "1") or a named key ("Enter",
    /// "Space", "Escape").
    KeyDown {
        key: String,
    },
    /// Triggered when a video reaches a specific time (Figma parity).
    WhenVideoHits {
        /// Time in seconds
        time: f32,
    },
    /// Triggered when a video ends playback (Figma parity).
    WhenVideoEnds,
}

impl Trigger {
    pub fn to_str(&self) -> &'static str {
        match self {
            Trigger::OnClick => "click",
            Trigger::OnHover => "hover",
            Trigger::OnPress => "press",
            Trigger::OnDrag => "drag",
            Trigger::AfterDelay { .. } => "delay",
            Trigger::MouseEnter => "enter",
            Trigger::MouseLeave => "leave",
            Trigger::MouseUp => "mouseup",
            Trigger::MouseDown => "mousedown",
            Trigger::KeyDown { .. } => "key",
            Trigger::WhenVideoHits { .. } => "video-hit",
            Trigger::WhenVideoEnds => "video-end",
        }
    }
    /// The trigger's name in the Prototype panel — ONE owner, in Figma's own
    /// words. The set is what help 360040315773 prints for the trigger
    /// control: *On click / On tap*, *While hovering*, *While pressing*,
    /// *Mouse enter*, *Mouse leave*, *Mouse down / Touch press*, *Mouse up /
    /// Touch release*, *On drag*, *After delay*, *Key/Gamepad*, *When video
    /// hits*, *When video ends*. The desktop spelling is the row's — the
    /// reference panel reads "On drag", never "On tap" — so the touch aliases
    /// stay in the docs.
    ///
    /// The short form only: what a trigger carries (a delay, a key, a video
    /// time) is its *parameter* and has its own field in the row;
    /// [`Trigger::label_with`] is the one-line spelling.
    pub fn label(&self) -> &'static str {
        match self {
            Trigger::OnClick => "On click",
            Trigger::OnDrag => "On drag",
            Trigger::OnHover => "While hovering",
            Trigger::OnPress => "While pressing",
            Trigger::KeyDown { .. } => "Key/Gamepad",
            Trigger::MouseEnter => "Mouse enter",
            Trigger::MouseLeave => "Mouse leave",
            Trigger::MouseDown => "Mouse down",
            Trigger::MouseUp => "Mouse up",
            Trigger::AfterDelay { .. } => "After delay",
            Trigger::WhenVideoHits { .. } => "When video hits",
            Trigger::WhenVideoEnds => "When video ends",
        }
    }

    /// Every trigger the panel offers, in the menu's order: Figma's list
    /// (help 360040315773) with its default, *On click*, moved to the front.
    /// ONE table — the menu paints it, a press writes `row`'s entry, and the
    /// delay/key/video entries carry the value the row starts from.
    pub fn all() -> [Trigger; 12] {
        [
            Trigger::OnClick,
            Trigger::OnDrag,
            Trigger::OnHover,
            Trigger::OnPress,
            Trigger::KeyDown { key: String::new() },
            Trigger::MouseEnter,
            Trigger::MouseLeave,
            Trigger::MouseDown,
            Trigger::MouseUp,
            Trigger::AfterDelay { ms: 800 },
            Trigger::WhenVideoHits { time: 0.0 },
            Trigger::WhenVideoEnds,
        ]
    }

    /// The menu row this trigger sits on — its identity without the parameter,
    /// which is the wire name (`to_str`), so the menu's tick and a press on it
    /// cannot disagree about what "the same trigger" means.
    pub fn row(&self) -> usize {
        let me = self.to_str();
        let list = Trigger::all();
        list.iter().position(|t| t.to_str() == me).unwrap_or(0)
    }
    /// Full label including the delay duration or video time — the one-line
    /// spelling, built from [`Trigger::label`] so the words have one owner.
    pub fn label_with(&self) -> String {
        match self {
            Trigger::AfterDelay { ms } => format!("{} ({} ms)", self.label(), ms),
            Trigger::KeyDown { key } => format!("{} ({})", self.label(), key),
            Trigger::WhenVideoHits { time } => format!("{} ({:.1}s)", self.label(), time),
            _ => self.label().to_string(),
        }
    }
}

/// What happens when the trigger fires.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Switch the whole canvas to another frame (top-level page).
    Navigate { destination: String },
    /// Show another frame floating on top of the current one.
    OpenOverlay {
        overlay: String,
        position: OverlayPosition,
    },
    /// Replace the topmost open overlay with a different frame.
    SwapOverlay { overlay: String },
    /// Dismiss the topmost open overlay.
    CloseOverlay,
    /// Open an external URL in the browser (Figma "open link"): leaves
    /// the prototype. Players surface the URL in the fire effect and
    /// change nothing else; hosts do the opening.
    OpenLink { url: String },
    /// Scroll the nearest scrollable ancestor so `destination` is in view.
    ScrollTo { destination: String },
    /// Navigate back to the previous frame (presentation history).
    Back,
    /// Prototype logic: assign `value` (evaluated against the current
    /// variables) to the variable `name` (Figma "set variable").
    SetVar { name: String, value: Expr },
    /// Prototype logic: switch the active variable mode (Figma "change to",
    /// e.g. light -> dark theming).
    SetMode { mode: String },
    /// Prototype logic: run `then` when `cond` holds, else `els`
    /// (Figma conditional prototyping). Branches may nest further `Cond`s.
    Cond {
        cond: Condition,
        then: Box<Action>,
        els: Option<Box<Action>>,
    },
}

impl Action {
    /// The frame id this action references, if any (for destination labels).
    pub fn target(&self) -> Option<&str> {
        match self {
            Action::Navigate { destination }
            | Action::OpenOverlay {
                overlay: destination,
                ..
            }
            | Action::SwapOverlay {
                overlay: destination,
            }
            | Action::ScrollTo { destination } => Some(destination),
            Action::CloseOverlay
            | Action::Back
            | Action::OpenLink { .. }
            | Action::SetVar { .. }
            | Action::SetMode { .. }
            | Action::Cond { .. } => None,
        }
    }
    pub fn kind(&self) -> &'static str {
        match self {
            Action::Navigate { .. } => "navigate",
            Action::OpenOverlay { .. } => "overlay",
            Action::SwapOverlay { .. } => "swap",
            Action::CloseOverlay => "close",
            Action::ScrollTo { .. } => "scroll",
            Action::OpenLink { .. } => "link",
            Action::Back => "back",
            Action::SetVar { .. } => "setvar",
            Action::SetMode { .. } => "setmode",
            Action::Cond { .. } => "cond",
        }
    }
}

/// Where an overlay frame is anchored on the canvas.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum OverlayPosition {
    Center,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    /// Absolute offset from the top-left of the canvas.
    Manual(f64, f64),
}

/// The five named overlay anchors (everything but [`OverlayPosition::Manual`]).
/// Players position overlays with [`overlay_offset`]; the property panel
/// offers these five plus manual offsets.
pub const NAMED_OVERLAY_POSITIONS: [OverlayPosition; 5] = [
    OverlayPosition::Center,
    OverlayPosition::TopLeft,
    OverlayPosition::TopRight,
    OverlayPosition::BottomLeft,
    OverlayPosition::BottomRight,
];

/// Top-left offset of an overlay inside its frame, in frame-local units:
/// the frame is `frame_w × frame_h`, the overlay `ov_w × ov_h`. Named
/// positions anchor to the frame edges; `Manual(x, y)` is taken as-is.
/// Pure geometry shared by the editor player, the app preview, and the
/// overlay painter, so hit-testing and rendering can never disagree.
pub fn overlay_offset(
    frame_w: f64,
    frame_h: f64,
    ov_w: f64,
    ov_h: f64,
    pos: OverlayPosition,
) -> (f64, f64) {
    match pos {
        OverlayPosition::Center => ((frame_w - ov_w) / 2.0, (frame_h - ov_h) / 2.0),
        OverlayPosition::TopLeft => (0.0, 0.0),
        OverlayPosition::TopRight => (frame_w - ov_w, 0.0),
        OverlayPosition::BottomLeft => (0.0, frame_h - ov_h),
        OverlayPosition::BottomRight => (frame_w - ov_w, frame_h - ov_h),
        OverlayPosition::Manual(x, y) => (x, y),
    }
}

impl OverlayPosition {
    pub fn to_str(self) -> &'static str {
        match self {
            OverlayPosition::Center => "center",
            OverlayPosition::TopLeft => "topleft",
            OverlayPosition::TopRight => "topright",
            OverlayPosition::BottomLeft => "bottomleft",
            OverlayPosition::BottomRight => "bottomright",
            OverlayPosition::Manual(..) => "manual",
        }
    }
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str, px: f64, py: f64) -> Self {
        match s {
            "topleft" => OverlayPosition::TopLeft,
            "topright" => OverlayPosition::TopRight,
            "bottomleft" => OverlayPosition::BottomLeft,
            "bottomright" => OverlayPosition::BottomRight,
            "manual" => OverlayPosition::Manual(px, py),
            _ => OverlayPosition::Center,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            OverlayPosition::Center => "Center",
            OverlayPosition::TopLeft => "Top left",
            OverlayPosition::TopRight => "Top right",
            OverlayPosition::BottomLeft => "Bottom left",
            OverlayPosition::BottomRight => "Bottom right",
            OverlayPosition::Manual(..) => "Manual",
        }
    }
}

/// Direction for Move in / Move out animations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Left,
    Right,
    Top,
    Bottom,
}

/// Easing function for animations (Figma parity).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Easing {
    /// Linear interpolation (no easing)
    Linear,
    /// Ease in (accelerate from zero velocity)
    EaseIn,
    /// Ease out (decelerate to zero velocity)
    EaseOut,
    /// Ease in and out (accelerate then decelerate)
    EaseInOut,
    /// Custom cubic bezier curve (x1, y1, x2, y2)
    CubicBezier(f32, f32, f32, f32),
}

impl Easing {
    pub fn label(&self) -> &'static str {
        match self {
            Easing::Linear => "Linear",
            Easing::EaseIn => "Ease in",
            Easing::EaseOut => "Ease out",
            Easing::EaseInOut => "Ease in and out",
            Easing::CubicBezier(..) => "Custom",
        }
    }

    pub fn to_str(&self) -> String {
        match self {
            Easing::Linear => "linear".to_string(),
            Easing::EaseIn => "ease-in".to_string(),
            Easing::EaseOut => "ease-out".to_string(),
            Easing::EaseInOut => "ease-in-out".to_string(),
            Easing::CubicBezier(x1, y1, x2, y2) => {
                format!("cubic-bezier({},{},{},{})", x1, y1, x2, y2)
            }
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "linear" => Easing::Linear,
            "ease-in" => Easing::EaseIn,
            "ease-out" => Easing::EaseOut,
            "ease-in-out" => Easing::EaseInOut,
            _ if s.starts_with("cubic-bezier(") => {
                // Parse cubic-bezier(x1,y1,x2,y2)
                let inner = &s[13..s.len() - 1];
                let parts: Vec<&str> = inner.split(',').collect();
                if parts.len() == 4 {
                    let x1 = parts[0].trim().parse().unwrap_or(0.0);
                    let y1 = parts[1].trim().parse().unwrap_or(0.0);
                    let x2 = parts[2].trim().parse().unwrap_or(1.0);
                    let y2 = parts[3].trim().parse().unwrap_or(1.0);
                    Easing::CubicBezier(x1, y1, x2, y2)
                } else {
                    Easing::Linear
                }
            }
            _ => Easing::Linear,
        }
    }
}

impl Direction {
    pub fn to_str(self) -> &'static str {
        match self {
            Direction::Left => "left",
            Direction::Right => "right",
            Direction::Top => "top",
            Direction::Bottom => "bottom",
        }
    }
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Self {
        match s {
            "right" => Direction::Right,
            "top" => Direction::Top,
            "bottom" => Direction::Bottom,
            _ => Direction::Left,
        }
    }
}

/// Transition animation preset (Figma's interaction animation list).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Animation {
    Instant,
    Dissolve,
    SmartAnimate,
    SlideIn,
    MoveIn(Direction),
    MoveOut(Direction),
    SlideOut,
}

impl Animation {
    pub fn to_str(self) -> &'static str {
        match self {
            Animation::Instant => "instant",
            Animation::Dissolve => "dissolve",
            Animation::SmartAnimate => "smart",
            Animation::SlideIn => "slide",
            Animation::SlideOut => "slideout",
            Animation::MoveIn(..) => "movein",
            Animation::MoveOut(..) => "moveout",
        }
    }
    /// Direction suffix for Move in / Move out (`movein-left`).
    pub fn dir_str(self) -> Option<&'static str> {
        match self {
            Animation::MoveIn(d) | Animation::MoveOut(d) => Some(d.to_str()),
            _ => None,
        }
    }
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Self {
        // "movein-left" style (direction suffix) or a plain preset name
        if let Some(rest) = s.strip_prefix("movein-") {
            return Animation::MoveIn(Direction::from_str(rest));
        }
        if let Some(rest) = s.strip_prefix("moveout-") {
            return Animation::MoveOut(Direction::from_str(rest));
        }
        match s {
            "instant" => Animation::Instant,
            "dissolve" => Animation::Dissolve,
            "slide" => Animation::SlideIn,
            "slideout" => Animation::SlideOut,
            "movein" => Animation::MoveIn(Direction::Left),
            "moveout" => Animation::MoveOut(Direction::Left),
            _ => Animation::SmartAnimate,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Animation::Instant => "Instant",
            Animation::Dissolve => "Dissolve",
            Animation::SmartAnimate => "Smart animate",
            Animation::SlideIn => "Slide in",
            Animation::SlideOut => "Slide out",
            Animation::MoveIn(..) => "Move in",
            Animation::MoveOut(..) => "Move out",
        }
    }
    /// Label including the direction, when one applies.
    pub fn label_with_dir(self) -> String {
        match self.dir_str() {
            Some(d) => format!("{} ({d})", self.label()),
            None => self.label().to_string(),
        }
    }
}

// ------------------------------------------------------ prototype logic
//
// Figma parity: variables in prototypes + conditional prototyping. A tiny
// expression language over the document's variables drives `SetVar` values
// and `Cond` conditions. Evaluation is total: unknown variables, type
// mismatches, and division by zero degrade to sane defaults instead of
// panicking, so untrusted `.x` files can never crash the player.

/// A evaluated value: number, string, or boolean.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Num(f64),
    Str(String),
    Bool(bool),
}

/// Tiny expression language for prototype logic (Figma's "adjust variable"
/// math, plus string concatenation for text variables).
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Val(Value),
    /// Read a variable by name.
    Var(String),
    Neg(Box<Expr>),
    Add(Box<Expr>, Box<Expr>),
    Sub(Box<Expr>, Box<Expr>),
    Mul(Box<Expr>, Box<Expr>),
    Div(Box<Expr>, Box<Expr>),
    Min(Box<Expr>, Box<Expr>),
    Max(Box<Expr>, Box<Expr>),
    Round(Box<Expr>),
    Concat(Box<Expr>, Box<Expr>),
}

impl Expr {
    pub fn num(n: f64) -> Self {
        Expr::Val(Value::Num(n))
    }
    pub fn var(name: &str) -> Self {
        Expr::Var(name.into())
    }
    pub fn str_(s: &str) -> Self {
        Expr::Val(Value::Str(s.into()))
    }
    pub fn bool_(b: bool) -> Self {
        Expr::Val(Value::Bool(b))
    }
}

/// Comparison used by [`Condition`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CondOp {
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
}

impl CondOp {
    pub fn to_str(self) -> &'static str {
        match self {
            CondOp::Eq => "eq",
            CondOp::Ne => "ne",
            CondOp::Gt => "gt",
            CondOp::Ge => "ge",
            CondOp::Lt => "lt",
            CondOp::Le => "le",
        }
    }
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Self {
        match s {
            "ne" => CondOp::Ne,
            "gt" => CondOp::Gt,
            "ge" => CondOp::Ge,
            "lt" => CondOp::Lt,
            "le" => CondOp::Le,
            _ => CondOp::Eq,
        }
    }
}

/// `lhs <op> rhs`, both sides evaluated against the current variables.
#[derive(Debug, Clone, PartialEq)]
pub struct Condition {
    pub lhs: Expr,
    pub op: CondOp,
    pub rhs: Expr,
}

/// Evaluate an expression against the document variables. Unknown
/// variables and type mismatches degrade: numbers fall back to `0.0`
/// (NaN-safe), strings to `""`, bools to `false`.
pub fn eval_expr(e: &Expr, vars: &crate::Variables) -> Value {
    use Value::*;
    match e {
        Expr::Val(v) => v.clone(),
        Expr::Var(name) => vars.get(name).unwrap_or(Num(0.0)),
        Expr::Neg(a) => match eval_expr(a, vars) {
            Num(n) => Num(-n),
            other => other,
        },
        Expr::Add(a, b) => Num(as_num(&eval_expr(a, vars)) + as_num(&eval_expr(b, vars))),
        Expr::Sub(a, b) => Num(as_num(&eval_expr(a, vars)) - as_num(&eval_expr(b, vars))),
        Expr::Mul(a, b) => Num(as_num(&eval_expr(a, vars)) * as_num(&eval_expr(b, vars))),
        Expr::Div(a, b) => {
            let d = as_num(&eval_expr(b, vars));
            if d == 0.0 {
                Num(0.0)
            } else {
                Num(as_num(&eval_expr(a, vars)) / d)
            }
        }
        Expr::Min(a, b) => Num(as_num(&eval_expr(a, vars)).min(as_num(&eval_expr(b, vars)))),
        Expr::Max(a, b) => Num(as_num(&eval_expr(a, vars)).max(as_num(&eval_expr(b, vars)))),
        Expr::Round(a) => Num(as_num(&eval_expr(a, vars)).round()),
        Expr::Concat(a, b) => Str(format!(
            "{}{}",
            as_str(&eval_expr(a, vars)),
            as_str(&eval_expr(b, vars))
        )),
    }
}

fn as_num(v: &Value) -> f64 {
    match v {
        Value::Num(n) if n.is_finite() => *n,
        Value::Bool(true) => 1.0,
        _ => 0.0,
    }
}

fn as_str(v: &Value) -> String {
    match v {
        Value::Str(s) => s.clone(),
        Value::Num(n) => format_num(*n),
        Value::Bool(b) => b.to_string(),
    }
}

/// Compact number formatting: integers without a trailing `.0`.
pub fn format_num(n: f64) -> String {
    if !n.is_finite() {
        return "0".into();
    }
    if (n - n.trunc()).abs() < f64::EPSILON && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// Evaluate a condition. Type mismatches compare unequal (and unordered
/// for Gt/Lt/Ge/Le) rather than failing.
pub fn condition_holds(c: &Condition, vars: &crate::Variables) -> bool {
    let l = eval_expr(&c.lhs, vars);
    let r = eval_expr(&c.rhs, vars);
    use CondOp::*;
    use Value::*;
    match (&l, &r) {
        (Num(a), Num(b)) => match c.op {
            Eq => a == b,
            Ne => a != b,
            Gt => a > b,
            Ge => a >= b,
            Lt => a < b,
            Le => a <= b,
        },
        (Str(a), Str(b)) => match c.op {
            Eq => a == b,
            Ne => a != b,
            Gt => a > b,
            Ge => a >= b,
            Lt => a < b,
            Le => a <= b,
        },
        (Bool(a), Bool(b)) => match c.op {
            Eq => a == b,
            Ne => a != b,
            _ => false,
        },
        _ => c.op == Ne,
    }
}

// ------------------------------------------------------ expression text
//
// A tiny infix parser/format pair so the Prototype panel can author
// `SetVar` values and `Cond` conditions as text ("count + 1",
// "count >= 2"). Supports numbers, variable names, unary minus,
// + - * / with standard precedence, parentheses, and the functions
// min(a, b), max(a, b), round(n), neg(n), concat(a, b).

/// Parse an expression from designer-typed text.
pub fn parse_expr_text(s: &str) -> Result<Expr, String> {
    let toks = tokenize_expr(s)?;
    let mut p = P2 { toks, i: 0 };
    let e = p.parse_add()?;
    if p.i != p.toks.len() {
        return Err(format!("unexpected {:?}", p.toks[p.i]));
    }
    Ok(e)
}

#[derive(Debug, Clone, PartialEq)]
enum Tok2 {
    Num(f64),
    Str(String),
    Ident(String),
    Op(char),
}

fn tokenize_expr(s: &str) -> Result<Vec<Tok2>, String> {
    let mut out = vec![];
    let b: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_whitespace() {
            i += 1;
        } else if c.is_ascii_digit() || (c == '.' && i + 1 < b.len() && b[i + 1].is_ascii_digit()) {
            let start = i;
            while i < b.len() && (b[i].is_ascii_digit() || b[i] == '.') {
                i += 1;
            }
            let txt: String = b[start..i].iter().collect();
            let n: f64 = txt.parse().map_err(|_| format!("bad number \"{txt}\""))?;
            out.push(Tok2::Num(n));
        } else if c == '"' {
            // string literal (for concat): no escapes beyond \" beyond the
            // obvious — take chars until the closing quote
            let start = i + 1;
            i += 1;
            while i < b.len() && b[i] != '"' {
                i += 1;
            }
            if i >= b.len() {
                return Err("unterminated string literal".into());
            }
            out.push(Tok2::Str(b[start..i].iter().collect()));
            i += 1;
        } else if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < b.len() && (b[i].is_alphanumeric() || b[i] == '_' || b[i] == '.') {
                i += 1;
            }
            out.push(Tok2::Ident(b[start..i].iter().collect()));
        } else if matches!(c, '+' | '-' | '*' | '/' | '(' | ')' | ',') {
            out.push(Tok2::Op(c));
            i += 1;
        } else {
            return Err(format!("unexpected character '{c}'"));
        }
    }
    Ok(out)
}

struct P2 {
    toks: Vec<Tok2>,
    i: usize,
}

impl P2 {
    fn peek(&self) -> Option<&Tok2> {
        self.toks.get(self.i)
    }
    fn parse_add(&mut self) -> Result<Expr, String> {
        let mut l = self.parse_mul()?;
        while let Some(Tok2::Op(op @ ('+' | '-'))) = self.peek() {
            let op = *op;
            self.i += 1;
            let r = self.parse_mul()?;
            l = if op == '+' {
                Expr::Add(Box::new(l), Box::new(r))
            } else {
                Expr::Sub(Box::new(l), Box::new(r))
            };
        }
        Ok(l)
    }
    fn parse_mul(&mut self) -> Result<Expr, String> {
        let mut l = self.parse_unary()?;
        while let Some(Tok2::Op(op @ ('*' | '/'))) = self.peek() {
            let op = *op;
            self.i += 1;
            let r = self.parse_unary()?;
            l = if op == '*' {
                Expr::Mul(Box::new(l), Box::new(r))
            } else {
                Expr::Div(Box::new(l), Box::new(r))
            };
        }
        Ok(l)
    }
    fn parse_unary(&mut self) -> Result<Expr, String> {
        if let Some(Tok2::Op('-')) = self.peek() {
            self.i += 1;
            return Ok(Expr::Neg(Box::new(self.parse_unary()?)));
        }
        self.parse_primary()
    }
    fn parse_primary(&mut self) -> Result<Expr, String> {
        match self.peek().cloned() {
            Some(Tok2::Num(n)) => {
                self.i += 1;
                Ok(Expr::Val(Value::Num(n)))
            }
            Some(Tok2::Str(t)) => {
                self.i += 1;
                Ok(Expr::Val(Value::Str(t)))
            }
            Some(Tok2::Ident(name)) => {
                self.i += 1;
                if let Some(Tok2::Op('(')) = self.peek() {
                    self.i += 1;
                    let mut args = vec![self.parse_add()?];
                    while let Some(Tok2::Op(',')) = self.peek() {
                        self.i += 1;
                        args.push(self.parse_add()?);
                    }
                    if let Some(Tok2::Op(')')) = self.peek() {
                        self.i += 1;
                    } else {
                        return Err(format!("missing ')' after {name}("));
                    }
                    return match name.as_str() {
                        "min" => {
                            if args.len() == 2 {
                                Ok(Expr::Min(
                                    Box::new(args[0].clone()),
                                    Box::new(args[1].clone()),
                                ))
                            } else {
                                Err("min takes 2 arguments".into())
                            }
                        }
                        "max" => {
                            if args.len() == 2 {
                                Ok(Expr::Max(
                                    Box::new(args[0].clone()),
                                    Box::new(args[1].clone()),
                                ))
                            } else {
                                Err("max takes 2 arguments".into())
                            }
                        }
                        "round" => {
                            if args.len() == 1 {
                                Ok(Expr::Round(Box::new(args[0].clone())))
                            } else {
                                Err("round takes 1 argument".into())
                            }
                        }
                        "neg" => {
                            if args.len() == 1 {
                                Ok(Expr::Neg(Box::new(args[0].clone())))
                            } else {
                                Err("neg takes 1 argument".into())
                            }
                        }
                        "concat" => {
                            if args.len() == 2 {
                                Ok(Expr::Concat(
                                    Box::new(args[0].clone()),
                                    Box::new(args[1].clone()),
                                ))
                            } else {
                                Err("concat takes 2 arguments".into())
                            }
                        }
                        _ => Err(format!("unknown function \"{name}\"")),
                    };
                }
                Ok(Expr::Var(name))
            }
            Some(Tok2::Op('(')) => {
                self.i += 1;
                let e = self.parse_add()?;
                if let Some(Tok2::Op(')')) = self.peek() {
                    self.i += 1;
                    Ok(e)
                } else {
                    Err("missing ')'".into())
                }
            }
            other => Err(format!("unexpected {other:?}")),
        }
    }
}

/// Format an expression back to designer-editable text. Nested binary
/// operations are parenthesized so `format(parse(s))` is stable.
pub fn format_expr(e: &Expr) -> String {
    fn prec(e: &Expr) -> u8 {
        match e {
            Expr::Add(..) | Expr::Sub(..) => 1,
            Expr::Mul(..) | Expr::Div(..) => 2,
            _ => 3,
        }
    }
    fn go(e: &Expr) -> String {
        match e {
            Expr::Val(v) => match v {
                Value::Num(n) => format_num(*n),
                Value::Str(s) => format!("\"{s}\""),
                Value::Bool(b) => b.to_string(),
            },
            Expr::Var(n) => n.clone(),
            Expr::Neg(a) => format!("-{}", wrap(a, 3)),
            Expr::Add(a, b) => format!("{} + {}", wrap(a, 1), wrap(b, 1)),
            Expr::Sub(a, b) => format!("{} - {}", wrap(a, 1), wrap(b, 2)),
            Expr::Mul(a, b) => format!("{} * {}", wrap(a, 2), wrap(b, 2)),
            Expr::Div(a, b) => format!("{} / {}", wrap(a, 2), wrap(b, 3)),
            Expr::Min(a, b) => format!("min({}, {})", go(a), go(b)),
            Expr::Max(a, b) => format!("max({}, {})", go(a), go(b)),
            Expr::Round(a) => format!("round({})", go(a)),
            Expr::Concat(a, b) => format!("concat({}, {})", go(a), go(b)),
        }
    }
    fn wrap(e: &Expr, min_prec: u8) -> String {
        if prec(e) < min_prec {
            format!("({})", go(e))
        } else {
            go(e)
        }
    }
    go(e)
}

/// Parse a condition from designer-typed text: "lhs op rhs" with
/// `== != >= <= > < =`.
pub fn parse_cond_text(s: &str) -> Result<Condition, String> {
    for (op_text, op) in [
        (">=", CondOp::Ge),
        ("<=", CondOp::Le),
        ("!=", CondOp::Ne),
        ("==", CondOp::Eq),
        (">", CondOp::Gt),
        ("<", CondOp::Lt),
        ("=", CondOp::Eq),
    ] {
        if let Some((l, r)) = s.split_once(op_text) {
            let lhs = parse_expr_text(l.trim())?;
            let rhs = parse_expr_text(r.trim())?;
            return Ok(Condition { lhs, op, rhs });
        }
    }
    Err("expected a comparison like \"count >= 2\"".into())
}

/// Format a condition back to designer-editable text.
pub fn format_cond(c: &Condition) -> String {
    let op = match c.op {
        CondOp::Eq => "==",
        CondOp::Ne => "!=",
        CondOp::Gt => ">",
        CondOp::Ge => ">=",
        CondOp::Lt => "<",
        CondOp::Le => "<=",
    };
    format!("{} {} {}", format_expr(&c.lhs), op, format_expr(&c.rhs))
}

/// Recursion cap for nested `Cond` branches (untrusted `.x` files).
const MAX_COND_DEPTH: u32 = 32;

/// Apply the variable-side effects of an action, returning the navigation
/// action (if any) for the player to execute. `SetVar`/`SetMode` mutate
/// `vars`; `Cond` picks a branch; everything else passes through.
pub fn run_action(action: &Action, vars: &mut crate::Variables) -> Option<Action> {
    run_action_depth(action, vars, 0)
}

fn run_action_depth(action: &Action, vars: &mut crate::Variables, depth: u32) -> Option<Action> {
    if depth > MAX_COND_DEPTH {
        return None;
    }
    match action {
        Action::SetVar { name, value } => {
            let v = eval_expr(value, vars);
            vars.set(name, v);
            None
        }
        Action::SetMode { mode } => {
            vars.set_mode(mode);
            None
        }
        Action::Cond { cond, then, els } => {
            let branch = if condition_holds(cond, vars) {
                then
            } else {
                els.as_deref()?
            };
            run_action_depth(branch, vars, depth + 1)
        }
        other => Some(other.clone()),
    }
}

/// One interaction: a trigger paired with an action, timing, and animation.
#[derive(Debug, Clone, PartialEq)]
pub struct Interaction {
    pub trigger: Trigger,
    pub action: Action,
    /// Multiple actions: Figma supports running several actions in sequence
    /// from a single trigger (e.g., navigate + set variable + play sound).
    /// When non-empty, these take precedence over `action`. Empty by
    /// default for backward compatibility with single-action interactions.
    pub actions: Vec<Action>,
    pub transition_ms: u32,
    pub animation: Animation,
    /// Easing function for the animation (Figma parity).
    pub easing: Easing,
    /// Whether to reset object properties when navigating (Figma parity).
    /// If true, object states (scroll position, form inputs, etc.) are
    /// reset when this interaction fires.
    pub reset_on_navigate: bool,
    /// Figma's **Animate matching layers** tick, in the interaction's own
    /// animation section (help 360039818874). On: the two screens' layers are
    /// matched by name *and* hierarchy, the matches smart-animate their
    /// differences, and everything else takes [`Interaction::animation`]. Off
    /// by default, the way Figma's box starts.
    pub animate_matching_layers: bool,
}

/// What the transition does with one layer of the destination screen when
/// **Animate matching layers** is on (help 360039818874).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LayerTransition {
    /// The layer matches one in the outgoing screen — same name, same place in
    /// the hierarchy — so its differences animate instead of the screen's
    /// transition. `from` is the outgoing layer's id.
    SmartAnimate { from: String },
    /// Nothing matched: a new layer dissolves in.
    Dissolve,
    /// Matched, but fixed or sticky: it holds still, with no transition at all.
    Hold,
}

/// One destination layer's place in the plan, in document order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayerPlan {
    pub to: String,
    pub name: String,
    pub transition: LayerTransition,
}

/// Figma's matching rule, in one place: two layers match when their **names**
/// and their **hierarchy** — the chain of ancestor names from the screen, which
/// is how Figma writes it — are equal ([help 360039818874](https://help.figma.com/hc/en-us/articles/360039818874)).
///
/// The decisions this returns are the article's four cases:
///
/// * matched, not fixed → [`LayerTransition::SmartAnimate`]: the layer's
///   differences animate and the rest of the screen uses the interaction's own
///   transition;
/// * matched, fixed or sticky → [`LayerTransition::Hold`]: no transition;
/// * no match → [`LayerTransition::Dissolve`], which is also what a fixed layer
///   with no match does (it can't hold a position it never had).
///
/// The screen roots themselves are not matched — a screen is not one of its own
/// layers — so a layer's path starts at its parent.
pub fn matching_layers(from: &Node, to: &Node) -> Vec<LayerPlan> {
    use std::collections::HashMap;

    /// The outgoing screen's layers by name path; the alias keeps both
    /// signatures short enough to read in one line.
    type Index<'a> = HashMap<Vec<String>, &'a Node>;

    fn index<'a>(n: &'a Node, path: &mut Vec<String>, out: &mut Index<'a>) {
        for c in &n.children {
            path.push(c.name.clone());
            out.insert(path.clone(), c);
            index(c, path, out);
            path.pop();
        }
    }
    let mut by_path = HashMap::new();
    index(from, &mut Vec::new(), &mut by_path);

    fn plan(n: &Node, path: &mut Vec<String>, by_path: &Index<'_>, out: &mut Vec<LayerPlan>) {
        for c in &n.children {
            path.push(c.name.clone());
            let held = crate::ScrollPosition::of(&c.constraints)
                != crate::ScrollPosition::ScrollWithParent;
            let transition = match by_path.get(path) {
                Some(_) if held => LayerTransition::Hold,
                Some(m) => LayerTransition::SmartAnimate { from: m.id.clone() },
                None => LayerTransition::Dissolve,
            };
            out.push(LayerPlan {
                to: c.id.clone(),
                name: c.name.clone(),
                transition,
            });
            plan(c, path, by_path, out);
            path.pop();
        }
    }
    let mut out = Vec::new();
    plan(to, &mut Vec::new(), &by_path, &mut out);
    out
}

impl Interaction {
    /// The common case: on click, navigate to `destination`, smart-animate.
    pub fn click(destination: &str) -> Self {
        Self {
            trigger: Trigger::OnClick,
            action: Action::Navigate {
                destination: destination.into(),
            },
            actions: vec![],
            transition_ms: 350,
            animation: Animation::SmartAnimate,
            easing: Easing::EaseInOut,
            reset_on_navigate: true,
            animate_matching_layers: false,
        }
    }

    /// Create an interaction with multiple actions (Figma parity).
    pub fn with_actions(
        trigger: Trigger,
        actions: Vec<Action>,
        transition_ms: u32,
        animation: Animation,
    ) -> Self {
        let action = actions.first().cloned().unwrap_or(Action::Back);
        Self {
            trigger,
            action,
            actions,
            transition_ms,
            animation,
            easing: Easing::EaseInOut,
            reset_on_navigate: true,
            animate_matching_layers: false,
        }
    }

    /// Create an interaction with full customization (Figma parity).
    pub fn custom(
        trigger: Trigger,
        action: Action,
        transition_ms: u32,
        animation: Animation,
        easing: Easing,
    ) -> Self {
        Self {
            trigger,
            action,
            actions: vec![],
            transition_ms,
            animation,
            easing,
            reset_on_navigate: true,
            animate_matching_layers: false,
        }
    }

    /// Returns all actions for this interaction: `actions` if non-empty,
    /// otherwise wraps the single `action` in a vec.
    pub fn all_actions(&self) -> Vec<&Action> {
        if self.actions.is_empty() {
            vec![&self.action]
        } else {
            self.actions.iter().collect()
        }
    }
}

/// The interactions a node actually fires during playback. Rich
/// `Node::interactions` win; a legacy `Node::prototype` link (old `.x` docs,
/// or the one-shot Prototype panel) is surfaced as a single `OnClick →
/// Navigate` interaction so the player has one uniform code path.
pub fn effective_interactions(node: &crate::Node) -> Vec<Interaction> {
    if !node.interactions.is_empty() {
        return node.interactions.clone();
    }
    if let Some(p) = &node.prototype {
        return vec![Interaction {
            trigger: Trigger::OnClick,
            action: Action::Navigate {
                destination: p.destination.clone(),
            },
            actions: vec![],
            transition_ms: p.transition_ms,
            animation: Animation::SmartAnimate,
            easing: Easing::EaseInOut,
            reset_on_navigate: false,
            animate_matching_layers: false,
        }];
    }
    vec![]
}

fn contains_id(n: &crate::Node, id: &str) -> bool {
    n.children.iter().any(|c| c.id == id || contains_id(c, id))
}

/// Find the interaction to fire for a hit node: the NEAREST ancestor of
/// `hit` (including itself) carrying an interaction with the given trigger.
/// Returns `(node_id, interaction)`. Descendants are searched first so the
/// deepest (nearest-to-hit) match wins.
pub fn find_interaction_for(
    node: &crate::Node,
    hit: &str,
    trigger: Trigger,
) -> Option<(String, Interaction)> {
    fn walk(n: &crate::Node, hit: &str, trigger: Trigger) -> Option<(String, Interaction)> {
        for c in &n.children {
            if let Some(r) = walk(c, hit, trigger.clone()) {
                return Some(r);
            }
        }
        if n.id == hit || contains_id(n, hit) {
            return effective_interactions(n)
                .into_iter()
                .find(|i| i.trigger == trigger)
                .map(|i| (n.id.clone(), i));
        }
        None
    }
    walk(node, hit, trigger)
}

/// Find the first `KeyDown` interaction in a subtree whose key matches
/// `key` (case-insensitive for single characters, exact for named keys
/// like "Enter"). Document order; used by the present-mode player when a
/// keystroke arrives.
pub fn find_key_interaction(node: &crate::Node, key: &str) -> Option<(String, Interaction)> {
    fn walk(n: &crate::Node, key: &str, out: &mut Option<(String, Interaction)>) {
        if out.is_some() {
            return;
        }
        for i in effective_interactions(n) {
            if let Trigger::KeyDown { key: k } = &i.trigger {
                let hit = if k.chars().count() == 1 && key.chars().count() == 1 {
                    k.eq_ignore_ascii_case(key)
                } else {
                    k == key
                };
                if hit {
                    *out = Some((n.id.clone(), i));
                    return;
                }
            }
        }
        for c in &n.children {
            walk(c, key, out);
            if out.is_some() {
                return;
            }
        }
    }
    let mut out = None;
    walk(node, key, &mut out);
    out
}

/// All `AfterDelay` interactions in a subtree, as `(node_id, delay_ms, i)`,
/// for the player to arm when a page becomes current.
pub fn delayed_interactions(node: &crate::Node) -> Vec<(String, u32, Interaction)> {
    fn walk(n: &crate::Node, out: &mut Vec<(String, u32, Interaction)>) {
        for i in effective_interactions(n) {
            if let Trigger::AfterDelay { ms } = i.trigger {
                out.push((n.id.clone(), ms, i));
            }
        }
        for c in &n.children {
            walk(c, out);
        }
    }
    let mut out = vec![];
    walk(node, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Color, Node};

    #[test]
    fn effective_interactions_prefers_rich_model_and_merges_legacy() {
        // legacy prototype link -> one OnClick/Navigate interaction
        let n =
            Node::rect("a", 0.0, 0.0, 10.0, 10.0, peniko::Color::WHITE).prototype("page-2", 400);
        let eff = effective_interactions(&n);
        assert_eq!(eff.len(), 1);
        assert_eq!(eff[0].trigger, Trigger::OnClick);
        assert_eq!(eff[0].transition_ms, 400);
        assert!(
            matches!(&eff[0].action, Action::Navigate { destination } if destination == "page-2")
        );

        // explicit interactions win over the legacy field
        let n2 = Node::rect("b", 0.0, 0.0, 10.0, 10.0, peniko::Color::WHITE)
            .prototype("legacy", 100)
            .interaction(Interaction {
                trigger: Trigger::OnHover,
                action: Action::Back,
                actions: vec![],
                transition_ms: 0,
                animation: Animation::Instant,
                easing: Easing::Linear,
                reset_on_navigate: false,
                animate_matching_layers: false,
            });
        let eff2 = effective_interactions(&n2);
        assert_eq!(eff2.len(), 1);
        assert_eq!(eff2[0].trigger, Trigger::OnHover);
        assert!(matches!(eff2[0].action, Action::Back));

        // no interactions at all
        let n3 = Node::rect("c", 0.0, 0.0, 10.0, 10.0, peniko::Color::WHITE);
        assert!(effective_interactions(&n3).is_empty());
    }

    /// Figma's trigger control is a dropdown whose entries are its own words
    /// (help 360040315773); the panel reads them from `label`, one owner for
    /// both. This pins the list, the order the menu shows it in, and the rule
    /// that the short form never carries a parameter.
    #[test]
    fn the_trigger_words_are_figmas_and_the_menu_lists_every_one() {
        let figma = [
            "On click",
            "On drag",
            "While hovering",
            "While pressing",
            "Key/Gamepad",
            "Mouse enter",
            "Mouse leave",
            "Mouse down",
            "Mouse up",
            "After delay",
            "When video hits",
            "When video ends",
        ];
        let words: Vec<&str> = Trigger::all().iter().map(|t| t.label()).collect();
        assert_eq!(words, figma.to_vec());
        for (k, t) in Trigger::all().iter().enumerate() {
            assert_eq!(t.row(), k, "{} sits on its own menu row", t.label());
        }
        // a parameter never leaks into the row's words: the pill is the short
        // form and the field beside it holds the number
        assert_eq!(Trigger::AfterDelay { ms: 0 }.label(), "After delay");
        assert_eq!(Trigger::AfterDelay { ms: 900 }.label(), "After delay");
        let key = Trigger::KeyDown { key: "A".into() };
        assert_eq!(key.label(), "Key/Gamepad");
        let video = Trigger::WhenVideoHits { time: 5.5 };
        assert_eq!(video.label(), "When video hits");
        // the one-line spelling is built from the same words
        assert_eq!(
            Trigger::AfterDelay { ms: 800 }.label_with(),
            "After delay (800 ms)"
        );
        assert_eq!(key.label_with(), "Key/Gamepad (A)");
        assert_eq!(Trigger::MouseDown.label_with(), "Mouse down");
        // the wire name is the menu's identity, and Mouse down is on the wire
        assert_eq!(Trigger::MouseDown.to_str(), "mousedown");
    }

    #[test]
    fn trigger_and_animation_string_roundtrip() {
        assert_eq!(Trigger::OnClick.to_str(), "click");
        assert_eq!(Trigger::AfterDelay { ms: 900 }.to_str(), "delay");
        assert_eq!(
            Trigger::AfterDelay { ms: 900 }.label_with(),
            "After delay (900 ms)"
        );
        assert_eq!(Animation::from_str("instant"), Animation::Instant);
        assert_eq!(Animation::from_str("dissolve"), Animation::Dissolve);
        assert_eq!(Animation::from_str("slide"), Animation::SlideIn);
        assert_eq!(Animation::from_str("bogus"), Animation::SmartAnimate);
        assert_eq!(
            OverlayPosition::from_str("topleft", 0.0, 0.0),
            OverlayPosition::TopLeft
        );
        assert_eq!(
            OverlayPosition::from_str("manual", 12.0, 34.0),
            OverlayPosition::Manual(12.0, 34.0)
        );
        assert_eq!(
            OverlayPosition::from_str("nope", 0.0, 0.0),
            OverlayPosition::Center
        );
    }

    #[test]
    fn find_interaction_for_prefers_nearest_ancestor() {
        use crate::Node;
        // frame > inner(frame) > button; the inner frame and the button both
        // have OnClick interactions — the button's (nearest) must win.
        let page = Node::frame("page", 400.0, 300.0).child(
            Node::frame("inner", 200.0, 200.0)
                .interaction(Interaction::click("page-b"))
                .child(
                    Node::rect("btn", 10.0, 10.0, 50.0, 30.0, peniko::Color::WHITE)
                        .interaction(Interaction::click("page-c")),
                ),
        );
        let (id, i) = find_interaction_for(&page, "btn", Trigger::OnClick).unwrap();
        assert_eq!(id, "btn");
        assert!(matches!(i.action, Action::Navigate { destination } if destination == "page-c"));
        // hit on the frame body (no button) -> inner frame's interaction
        let (id2, _) = find_interaction_for(&page, "inner", Trigger::OnClick).unwrap();
        assert_eq!(id2, "inner");
        // no match for a different trigger
        assert!(find_interaction_for(&page, "btn", Trigger::OnHover).is_none());
        // unknown hit
        assert!(find_interaction_for(&page, "nope", Trigger::OnClick).is_none());
    }

    #[test]
    fn expr_eval_arithmetic_and_vars() {
        let mut vars = crate::Variables::default();
        vars.numbers.insert("count".into(), 7.0);
        vars.strings.insert("user".into(), "Ada".into());
        vars.bools.insert("pro".into(), true);

        use Expr::*;
        let var = |n: &str| Expr::var(n);
        let num = |n: f64| Expr::num(n);
        let str_ = |s: &str| Expr::str_(s);
        let bool_ = |b: bool| Expr::bool_(b);
        let e = |x: Expr| eval_expr(&x, &vars);
        assert_eq!(
            e(Add(Box::new(var("count")), Box::new(num(3.0)))),
            Value::Num(10.0)
        );
        assert_eq!(
            e(Mul(Box::new(var("count")), Box::new(num(2.0)))),
            Value::Num(14.0)
        );
        assert_eq!(
            e(Div(Box::new(var("count")), Box::new(num(0.0)))),
            Value::Num(0.0)
        );
        assert_eq!(
            e(Div(Box::new(num(10.0)), Box::new(num(4.0)))),
            Value::Num(2.5)
        );
        assert_eq!(e(Neg(Box::new(var("count")))), Value::Num(-7.0));
        assert_eq!(
            e(Min(Box::new(var("count")), Box::new(num(3.0)))),
            Value::Num(3.0)
        );
        assert_eq!(
            e(Max(Box::new(var("count")), Box::new(num(3.0)))),
            Value::Num(7.0)
        );
        assert_eq!(
            e(Round(Box::new(Div(
                Box::new(num(10.0)),
                Box::new(num(3.0))
            )))),
            Value::Num(3.0)
        );
        // unknown var degrades to 0, bool coerces in numeric context
        assert_eq!(
            e(Add(Box::new(var("nope")), Box::new(num(1.0)))),
            Value::Num(1.0)
        );
        assert_eq!(
            e(Add(Box::new(bool_(true)), Box::new(num(1.0)))),
            Value::Num(2.0)
        );
        // strings concatenate; numbers stringify into concat
        assert_eq!(
            e(Concat(Box::new(var("user")), Box::new(str_("!")))),
            Value::Str("Ada!".into())
        );
        assert_eq!(
            e(Concat(Box::new(str_("n=")), Box::new(var("count")))),
            Value::Str("n=7".into())
        );
    }

    #[test]
    fn conditions_compare_typed_and_mismatched() {
        let mut vars = crate::Variables::default();
        vars.numbers.insert("qty".into(), 5.0);
        vars.strings.insert("mode".into(), "edit".into());
        vars.bools.insert("pro".into(), true);

        let c = |l: Expr, op: CondOp, r: Expr| Condition { lhs: l, op, rhs: r };
        use CondOp::*;
        use Expr::*;
        let var = |n: &str| Expr::var(n);
        let num = |n: f64| Expr::num(n);
        let str_ = |s: &str| Expr::str_(s);
        let bool_ = |b: bool| Expr::bool_(b);
        assert!(condition_holds(&c(var("qty"), Gt, num(4.0)), &vars));
        assert!(!condition_holds(&c(var("qty"), Le, num(4.0)), &vars));
        assert!(condition_holds(&c(var("mode"), Eq, str_("edit")), &vars));
        assert!(condition_holds(&c(var("pro"), Eq, bool_(true)), &vars));
        assert!(!condition_holds(&c(var("pro"), Gt, bool_(false)), &vars));
        // type mismatch: unequal (Ne holds), ordered comparisons false
        assert!(condition_holds(&c(var("qty"), Ne, str_("5")), &vars));
        assert!(!condition_holds(&c(var("qty"), Gt, str_("4")), &vars));
    }

    #[test]
    fn run_action_sets_vars_and_picks_branches() {
        let mut vars = crate::Variables::default();
        vars.numbers.insert("page".into(), 1.0);
        vars.colors.insert("bg".into(), peniko::Color::WHITE);

        // SetVar with an expression over the current value
        let a = Action::SetVar {
            name: "page".into(),
            value: Expr::Add(Box::new(Expr::var("page")), Box::new(Expr::num(1.0))),
        };
        assert!(run_action(&a, &mut vars).is_none());
        assert_eq!(vars.numbers["page"], 2.0);

        // Cond: qty >= 2 -> set page to 10, else set to 20
        let cond = Action::Cond {
            cond: Condition {
                lhs: Expr::var("page"),
                op: CondOp::Ge,
                rhs: Expr::num(2.0),
            },
            then: Box::new(Action::SetVar {
                name: "page".into(),
                value: Expr::num(10.0),
            }),
            els: Some(Box::new(Action::SetVar {
                name: "page".into(),
                value: Expr::num(20.0),
            })),
        };
        assert!(run_action(&cond, &mut vars).is_none());
        assert_eq!(vars.numbers["page"], 10.0);
        // now the else branch
        let cond_false = Action::Cond {
            cond: Condition {
                lhs: Expr::var("page"),
                op: CondOp::Lt,
                rhs: Expr::num(2.0),
            },
            then: Box::new(Action::SetVar {
                name: "page".into(),
                value: Expr::num(30.0),
            }),
            els: None,
        };
        assert!(run_action(&cond_false, &mut vars).is_none());
        assert_eq!(vars.numbers["page"], 10.0); // unchanged, no else

        // navigation actions pass through untouched
        let nav = run_action(&Action::Back, &mut vars);
        assert!(matches!(nav, Some(Action::Back)));

        // SetMode flips the active mode
        vars.modes.insert("dark".into(), Default::default());
        run_action(
            &Action::SetMode {
                mode: "dark".into(),
            },
            &mut vars,
        );
        assert_eq!(vars.active_mode.as_deref(), Some("dark"));

        // deep nesting is depth-capped, not stack-overflowed
        let mut deep = Action::SetVar {
            name: "page".into(),
            value: Expr::num(99.0),
        };
        for _ in 0..100 {
            deep = Action::Cond {
                cond: Condition {
                    lhs: Expr::bool_(true),
                    op: CondOp::Eq,
                    rhs: Expr::bool_(true),
                },
                then: Box::new(deep),
                els: None,
            };
        }
        assert!(run_action(&deep, &mut vars).is_none());
        assert_eq!(vars.numbers["page"], 10.0); // cap hit before the SetVar
    }

    /// "Animate matching layers" is Figma's rule about which layers of the
    /// destination screen animate on their own (help 360039818874): name plus
    /// hierarchy decides, matched fixed layers hold, new layers dissolve in.
    #[test]
    fn matching_layers_follows_names_hierarchy_and_fixed() {
        fn titled(id: &str, name: &str, child: &str, child_name: &str) -> Node {
            let mut f = Node::frame(id, 100.0, 80.0);
            f.name = name.into();
            let mut c = Node::rect(child, 0.0, 0.0, 20.0, 8.0, Color::WHITE);
            c.name = child_name.into();
            f.child(c)
        }
        let mut pinned_from = Node::rect("pinned-from", 0.0, 90.0, 40.0, 20.0, Color::WHITE);
        pinned_from.name = "Pinned".into();
        let from = Node::frame("Home", 300.0, 200.0)
            .child(titled("card-from", "Card", "title-from", "Title"))
            .child(titled("old-from", "Old", "old-title-from", "Title"))
            .child(pinned_from);

        let mut pinned = Node::rect("pinned-to", 0.0, 90.0, 40.0, 20.0, Color::WHITE);
        pinned.name = "Pinned".into();
        pinned.constraints.fixed = true;
        let mut ghost = Node::rect("ghost-to", 60.0, 90.0, 40.0, 20.0, Color::WHITE);
        ghost.name = "Ghost".into();
        ghost.constraints.fixed = true;
        let mut fresh = Node::rect("fresh-to", 0.0, 120.0, 40.0, 20.0, Color::WHITE);
        fresh.name = "Fresh".into();
        let mut moved = titled("card-to", "Card", "title-to", "Title");
        moved.w = 120.0;
        let to = Node::frame("Detail", 300.0, 200.0)
            .child(moved)
            .child(titled("new-to", "New", "new-title-to", "Title"))
            .child(pinned)
            .child(ghost)
            .child(fresh);

        // document order, parents before their children: [card, title, new,
        // new-title, pinned, ghost, fresh] — Figma's four cases among them
        let plan = matching_layers(&from, &to);
        assert_eq!(plan.len(), 7, "every destination layer is planned");
        assert_eq!(plan[0].to, "card-to", "document order, parents first");
        assert_eq!(plan[0].name, "Card");
        assert_eq!(
            plan[0].transition,
            LayerTransition::SmartAnimate {
                from: "card-from".into(),
            }
        );
        // the child matches through the hierarchy, not through the screens
        assert_eq!(
            plan[1].transition,
            LayerTransition::SmartAnimate {
                from: "title-from".into(),
            }
        );
        // its parent is renamed, so the same child name is another layer
        assert_eq!(plan[3].transition, LayerTransition::Dissolve);
        // matched but fixed: no transition at all
        assert_eq!(plan[4].transition, LayerTransition::Hold);
        // a fixed layer with nothing to match dissolves, not holds
        assert_eq!(plan[5].transition, LayerTransition::Dissolve);
        // and a layer the outgoing screen never had dissolves in
        assert_eq!(plan[6].transition, LayerTransition::Dissolve);
    }

    #[test]
    fn keydown_and_move_animations_roundtrip_strings() {
        assert_eq!(Trigger::KeyDown { key: "a".into() }.to_str(), "key");
        assert_eq!(
            Trigger::KeyDown {
                key: "Enter".into()
            }
            .label_with(),
            "Key/Gamepad (Enter)"
        );
        assert_eq!(Animation::MoveIn(Direction::Left).to_str(), "movein");
        assert_eq!(Animation::MoveIn(Direction::Right).dir_str(), Some("right"));
        assert_eq!(
            Animation::from_str("movein-bottom"),
            Animation::MoveIn(Direction::Bottom)
        );
        assert_eq!(
            Animation::from_str("moveout-right"),
            Animation::MoveOut(Direction::Right)
        );
        assert_eq!(Animation::from_str("slideout"), Animation::SlideOut);
        assert_eq!(
            Animation::from_str("movein"),
            Animation::MoveIn(Direction::Left)
        );
        assert_eq!(Animation::from_str("bogus"), Animation::SmartAnimate);
        assert_eq!(
            Animation::MoveIn(Direction::Top).label_with_dir(),
            "Move in (top)"
        );
        assert_eq!(Animation::Dissolve.label_with_dir(), "Dissolve");
        // new action kinds
        assert_eq!(
            Action::SetVar {
                name: "x".into(),
                value: Expr::num(1.0)
            }
            .kind(),
            "setvar"
        );
        assert_eq!(
            Action::SetMode {
                mode: "dark".into()
            }
            .kind(),
            "setmode"
        );
        assert_eq!(
            Action::target(&Action::SetMode {
                mode: "dark".into()
            }),
            None
        );
    }

    #[test]
    fn find_key_interaction_matches_case_insensitive_single_chars() {
        let page = Node::frame("page", 400.0, 300.0).child(
            Node::rect("btn", 10.0, 10.0, 50.0, 30.0, peniko::Color::WHITE).interaction(
                Interaction {
                    trigger: Trigger::KeyDown { key: "a".into() },
                    action: Action::Back,
                    actions: vec![],
                    transition_ms: 0,
                    animation: Animation::Instant,
                    easing: Easing::Linear,
                    reset_on_navigate: false,
                    animate_matching_layers: false,
                },
            ),
        );
        let (id, i) = find_key_interaction(&page, "A").expect("case-insensitive match");
        assert_eq!(id, "btn");
        assert!(matches!(i.action, Action::Back));
        // named keys match exactly
        let page2 = Node::frame("p", 400.0, 300.0).child(
            Node::rect("x", 0.0, 0.0, 10.0, 10.0, peniko::Color::WHITE).interaction(Interaction {
                trigger: Trigger::KeyDown {
                    key: "Enter".into(),
                },
                action: Action::Back,
                actions: vec![],
                transition_ms: 0,
                animation: Animation::Instant,
                easing: Easing::Linear,
                reset_on_navigate: false,
                animate_matching_layers: false,
            }),
        );
        assert!(find_key_interaction(&page2, "Enter").is_some());
        assert!(find_key_interaction(&page2, "enter").is_none());
        assert!(find_key_interaction(&page, "b").is_none());
    }

    #[test]
    fn expr_text_parser_precedence_and_functions() {
        let vars = crate::Variables::default();
        let eval = |s: &str| {
            let e = parse_expr_text(s).expect(s);
            eval_expr(&e, &vars)
        };
        assert_eq!(eval("2 + 3 * 4"), Value::Num(14.0));
        assert_eq!(eval("(2 + 3) * 4"), Value::Num(20.0));
        assert_eq!(eval("10 / 4"), Value::Num(2.5));
        assert_eq!(eval("-5 + 2"), Value::Num(-3.0));
        assert_eq!(eval("min(3, 7)"), Value::Num(3.0));
        assert_eq!(eval("max(3, 7)"), Value::Num(7.0));
        assert_eq!(eval("round(10 / 3)"), Value::Num(3.0));
        assert_eq!(eval("neg(4)"), Value::Num(-4.0));
        assert_eq!(eval("concat(\"a\", \"b\")"), Value::Str("ab".into()));
        // a lone identifier is a variable read (unknown -> 0)
        assert_eq!(eval("nope"), Value::Num(0.0));
        // errors
        assert!(parse_expr_text("2 +").is_err());
        assert!(parse_expr_text("(2").is_err());
        assert!(parse_expr_text("sin(1)").is_err());
        assert!(parse_expr_text("2 $ 3").is_err());
        assert!(parse_expr_text("min(1)").is_err());
    }

    #[test]
    fn expr_text_format_roundtrips() {
        for txt in [
            "2 + 3 * 4",
            "(2 + 3) * 4",
            "count + 1",
            "min(a, 2) * 3",
            "round(x / 2)",
            "-5 + b",
            "max(min(a, b), c)",
            "concat(\"n=\", count)",
        ] {
            let e = parse_expr_text(txt).expect(txt);
            let f = format_expr(&e);
            let e2 = parse_expr_text(&f).expect(&f);
            assert_eq!(e, e2, "{txt} -> {f}");
        }
        // canonical spacing
        assert_eq!(format_expr(&parse_expr_text("2+3*4").unwrap()), "2 + 3 * 4");
        assert_eq!(
            format_expr(&parse_expr_text("(2+3)*4").unwrap()),
            "(2 + 3) * 4"
        );
    }

    #[test]
    fn cond_text_parse_format_and_eval() {
        let mut vars = crate::Variables::default();
        vars.numbers.insert("count".into(), 3.0);
        let c = parse_cond_text("count >= 2").expect("parse");
        assert_eq!(c.op, CondOp::Ge);
        assert!(condition_holds(&c, &vars));
        assert_eq!(format_cond(&c), "count >= 2");

        // all operators
        for (op, holds) in [
            ("==", true),
            ("!=", false),
            (">", false),
            ("<", false),
            ("<=", true),
            (">=", true),
        ] {
            let c = parse_cond_text(&format!("count {op} 3")).unwrap();
            assert_eq!(condition_holds(&c, &vars), holds, "{op}");
        }
        // '=' means equals
        let c = parse_cond_text("count = 3").unwrap();
        assert!(condition_holds(&c, &vars));
        // both sides can be expressions
        let c = parse_cond_text("count + 1 > 2 * 1").unwrap();
        assert!(condition_holds(&c, &vars));
        // round-trip
        let c = parse_cond_text("min(a, 5) <= count").unwrap();
        assert_eq!(format_cond(&c), "min(a, 5) <= count");
        let c2 = parse_cond_text(&format_cond(&c)).unwrap();
        assert_eq!(c, c2);
        // errors
        assert!(parse_cond_text("count").is_err());
        assert!(parse_cond_text("count > ").is_err());
    }

    #[test]
    fn delayed_interactions_collects_after_delay_only() {
        use crate::Node;
        let page = Node::frame("page", 400.0, 300.0)
            .child(
                Node::rect("a", 0.0, 0.0, 10.0, 10.0, peniko::Color::WHITE).interaction(
                    Interaction {
                        trigger: Trigger::AfterDelay { ms: 700 },
                        action: Action::Back,
                        actions: vec![],
                        transition_ms: 0,
                        animation: Animation::Instant,
                        easing: Easing::Linear,
                        reset_on_navigate: false,
                        animate_matching_layers: false,
                    },
                ),
            )
            .child(
                Node::rect("b", 0.0, 0.0, 10.0, 10.0, peniko::Color::WHITE)
                    .interaction(Interaction::click("x")),
            );
        let d = delayed_interactions(&page);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].0, "a");
        assert_eq!(d[0].1, 700);
        assert!(matches!(d[0].2.action, Action::Back));
    }

    #[test]
    fn overlay_offset_anchors_all_five_positions() {
        // frame 400x300, overlay 100x80
        let at = |p: OverlayPosition| overlay_offset(400.0, 300.0, 100.0, 80.0, p);
        assert_eq!(at(OverlayPosition::Center), (150.0, 110.0));
        assert_eq!(at(OverlayPosition::TopLeft), (0.0, 0.0));
        assert_eq!(at(OverlayPosition::TopRight), (300.0, 0.0));
        assert_eq!(at(OverlayPosition::BottomLeft), (0.0, 220.0));
        assert_eq!(at(OverlayPosition::BottomRight), (300.0, 220.0));
        assert_eq!(at(OverlayPosition::Manual(12.0, 34.0)), (12.0, 34.0));
        // oversized overlays overflow symmetrically from the center
        let over = overlay_offset(100.0, 100.0, 200.0, 50.0, OverlayPosition::Center);
        assert_eq!(over, (-50.0, 25.0));
        assert_eq!(NAMED_OVERLAY_POSITIONS.len(), 5);
        assert!(!NAMED_OVERLAY_POSITIONS.contains(&OverlayPosition::Manual(0.0, 0.0)));
    }

    #[test]
    fn easing_roundtrips_through_strings() {
        // Standard easings
        assert_eq!(Easing::from_str("linear"), Easing::Linear);
        assert_eq!(Easing::from_str("ease-in"), Easing::EaseIn);
        assert_eq!(Easing::from_str("ease-out"), Easing::EaseOut);
        assert_eq!(Easing::from_str("ease-in-out"), Easing::EaseInOut);

        // Custom bezier
        let bezier = Easing::from_str("cubic-bezier(0.4,0.0,0.2,1.0)");
        if let Easing::CubicBezier(x1, y1, x2, y2) = bezier {
            assert!((x1 - 0.4).abs() < 0.001);
            assert!((y1 - 0.0).abs() < 0.001);
            assert!((x2 - 0.2).abs() < 0.001);
            assert!((y2 - 1.0).abs() < 0.001);
        } else {
            panic!("Expected CubicBezier");
        }

        // Labels
        assert_eq!(Easing::Linear.label(), "Linear");
        assert_eq!(Easing::EaseIn.label(), "Ease in");
        assert_eq!(Easing::EaseOut.label(), "Ease out");
        assert_eq!(Easing::EaseInOut.label(), "Ease in and out");
        assert_eq!(Easing::CubicBezier(0.4, 0.0, 0.2, 1.0).label(), "Custom");
    }

    #[test]
    fn video_triggers_work() {
        // WhenVideoHits
        let trigger = Trigger::WhenVideoHits { time: 5.5 };
        assert_eq!(trigger.to_str(), "video-hit");
        assert_eq!(trigger.label(), "When video hits");
        assert_eq!(trigger.label_with(), "When video hits (5.5s)");

        // WhenVideoEnds
        let trigger = Trigger::WhenVideoEnds;
        assert_eq!(trigger.to_str(), "video-end");
        assert_eq!(trigger.label(), "When video ends");
        assert_eq!(trigger.label_with(), "When video ends");
    }

    #[test]
    fn interaction_includes_easing_and_state_management() {
        let interaction = Interaction::custom(
            Trigger::OnClick,
            Action::Back,
            300,
            Animation::Dissolve,
            Easing::EaseOut,
        );

        assert_eq!(interaction.easing, Easing::EaseOut);
        assert!(interaction.reset_on_navigate, "Figma default: reset scroll on navigate");
    }
}
