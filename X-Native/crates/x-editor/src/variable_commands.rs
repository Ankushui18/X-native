//! Undoable variable authoring — the backend a "Variables" panel talks to.
//!
//! The document model (`x_core::Variables`) has always had write primitives
//! (`set`, `set_mode`, the pub tables), but nothing gave those edits *history*:
//! the main `Command` log only mutates the node tree (`apply(root, cmd)`), and
//! `Editor` deliberately holds no `Variables` — the app layer passes `&Variables`
//! in. Variable edits therefore happened outside undo. This module closes that
//! gap with a self-contained command log of its own, following the same
//! architecture decision as `commands.rs`: logs of (command, inverse), not
//! snapshots.
//!
//! Two entry points:
//! * [`VariableCommand`] + [`apply_variable`] + [`invert_variable`] — embeddable
//!   into any host history.
//! * [`VariableHistory`] — a ready-made undo/redo stack for variables
//!   (`commit`/`undo`/`redo`), mirroring `Editor`'s clear-redo-on-new-commit.
//!
//! Constructors (`set_number`, `set_color`, `remove_variable`, …) snapshot the
//! *current* value into the command's `from`, so every edit carries its own
//! exact inverse — including type moves (number → string) and mode overrides.
//! Semantics deliberately mirror the model's lookup order: colors, numbers,
//! strings, bools are separate tables and aliases are a separate mapping; a
//! set never silently clears a same-name entry in another table except when
//! the type actually changes (then the old table's entry is removed, and the
//! inverse restores it).

use x_core::{color_to_hex, parse_hex_color, Color, Variables};

// ------------------------------------------------------------------ values

/// A variable value as authored (colors stay colors here — unlike
/// `x_core::Value`, which flattens colors to hex strings for the prototype
/// expression language).
#[derive(Clone)]
pub enum VarValue {
    Color(Color),
    Number(f64),
    Str(String),
    Bool(bool),
}

impl VarValue {
    /// Parse a hex/css color string into a color value (`"#FF0000"`, …).
    pub fn color_of(s: &str) -> Option<VarValue> {
        parse_hex_color(s).map(VarValue::Color)
    }
    /// Hex string of a color value (round-trips through [`VarValue::color_of`]).
    pub fn hex(&self) -> Option<String> {
        match self {
            VarValue::Color(c) => Some(color_to_hex(*c)),
            _ => None,
        }
    }
    /// Table selector: 0=color, 1=number, 2=string, 3=bool (matches the
    /// base-table lookup order in `Variables::get`).
    fn kind(&self) -> u8 {
        match self {
            VarValue::Color(_) => 0,
            VarValue::Number(_) => 1,
            VarValue::Str(_) => 2,
            VarValue::Bool(_) => 3,
        }
    }
}

impl PartialEq for VarValue {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (VarValue::Color(a), VarValue::Color(b)) => a.to_rgba8() == b.to_rgba8(),
            (VarValue::Number(a), VarValue::Number(b)) => a == b,
            (VarValue::Str(a), VarValue::Str(b)) => a == b,
            (VarValue::Bool(a), VarValue::Bool(b)) => a == b,
            _ => false,
        }
    }
}
impl Eq for VarValue {}

impl std::fmt::Debug for VarValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VarValue::Color(c) => write!(f, "Color({})", color_to_hex(*c)),
            VarValue::Number(n) => write!(f, "Number({n})"),
            VarValue::Str(s) => write!(f, "Str({s:?})"),
            VarValue::Bool(b) => write!(f, "Bool({b})"),
        }
    }
}

// ---------------------------------------------------------------- commands

/// One undoable variable-table edit. `from`/`to` are full snapshots of the
/// edited slot; the inverse is always "swap them" (plus `SetExposed`, where
/// it is "flip `to`").
#[derive(Debug, Clone, PartialEq)]
pub enum VariableCommand {
    /// Create / overwrite / type-move / delete (to = `None`) a base value.
    SetBase {
        name: String,
        from: Option<VarValue>,
        to: Option<VarValue>,
    },
    /// Point `name` at another variable (to = `None` clears the alias).
    SetAlias {
        name: String,
        from: Option<String>,
        to: Option<String>,
    },
    /// Tag a variable into a collection (to = `None`/empty/"Local" → untag).
    SetCollection {
        name: String,
        from: Option<String>,
        to: Option<String>,
    },
    /// Toggle prototype-viewer exposure.
    SetExposed { name: String, to: bool },
    /// Switch the document's active mode (to = `None` → base tables).
    SetActiveMode {
        from: Option<String>,
        to: Option<String>,
    },
    /// Write / overwrite / remove (to = `None`) a mode-scoped override.
    /// Removal routes by `from`'s kind, so removals must be constructed
    /// through [`remove_mode_value`] (or carry a real snapshot).
    SetModeValue {
        name: String,
        mode: String,
        from: Option<VarValue>,
        to: Option<VarValue>,
    },
    /// Several edits applied as one history unit (e.g. a rename that moves
    /// the value, re-points old references via an alias, and retires the old
    /// entry). Applies in order; the inverse applies the inverted commands
    /// in reverse order.
    Batch(Vec<VariableCommand>),
}

/// Apply one variable edit. Returns `false` (and changes nothing) when the
/// edit is a no-op or underspecified (e.g. a `SetModeValue` removal with no
/// `from` snapshot to route the table by, or an unknown target mode).
pub fn apply_variable(vars: &mut Variables, cmd: &VariableCommand) -> bool {
    match cmd {
        VariableCommand::SetBase { name, from, to } => {
            if from == to {
                return false;
            }
            // A type move must clear the old table (the model's lookup order
            // would otherwise shadow it).
            if let Some(f) = from {
                if to.as_ref().map(|t| t.kind()) != Some(f.kind()) {
                    remove_base(vars, name, f.kind());
                }
            }
            match to {
                Some(v) => {
                    insert_base(vars, name, v.clone());
                    true
                }
                None => {
                    // Full delete: clear every base table (only `from`'s table
                    // can hold it after the type-move rule above, but be total).
                    for k in 0..4 {
                        remove_base(vars, name, k);
                    }
                    true
                }
            }
        }
        VariableCommand::SetAlias { name, from, to } => {
            if from == to {
                return false;
            }
            match to {
                Some(t) => vars.aliases.insert(name.clone(), t.clone()),
                None => vars.aliases.remove(name),
            };
            true
        }
        VariableCommand::SetCollection { name, from, to } => {
            if from == to {
                return false;
            }
            // Normalize the untag aliases (None/empty/"Local") so re-tagging
            // with an equivalent no-op is rejected, not recorded as history.
            let normalized = match to {
                Some(t) if !t.is_empty() && t != "Local" => Some(t.clone()),
                _ => None,
            };
            if vars.collections.get(name) == normalized.as_ref() {
                return false;
            }
            match normalized {
                Some(c) => {
                    vars.collections.insert(name.clone(), c);
                }
                None => {
                    vars.collections.remove(name);
                }
            }
            true
        }
        VariableCommand::SetExposed { name, to } => {
            if *to {
                vars.exposed.insert(name.clone())
            } else {
                vars.exposed.remove(name)
            }
        }
        VariableCommand::SetActiveMode { from, to } => {
            if from == to {
                return false;
            }
            match to {
                Some(m) => {
                    // Mirror `Variables::set_mode`: unknown modes are ignored.
                    let known = vars.modes.contains_key(m)
                        || vars.num_modes.contains_key(m)
                        || vars.str_modes.contains_key(m)
                        || vars.bool_modes.contains_key(m);
                    if !known {
                        return false;
                    }
                    vars.active_mode = Some(m.clone());
                    true
                }
                None => {
                    vars.active_mode = None;
                    true
                }
            }
        }
        VariableCommand::SetModeValue {
            name,
            mode,
            from,
            to,
        } => {
            if from == to {
                return false;
            }
            match to {
                Some(v) => {
                    insert_mode(vars, mode, name, v);
                    true
                }
                None => match from {
                    Some(f) => remove_mode(vars, mode, name, f.kind()),
                    None => false,
                },
            }
        }
        VariableCommand::Batch(cmds) => {
            let mut any = false;
            for c in cmds {
                any |= apply_variable(vars, c);
            }
            any
        }
    }
}

/// The exact inverse of one edit.
pub fn invert_variable(cmd: &VariableCommand) -> VariableCommand {
    match cmd {
        VariableCommand::SetBase { name, from, to } => VariableCommand::SetBase {
            name: name.clone(),
            from: to.clone(),
            to: from.clone(),
        },
        VariableCommand::SetAlias { name, from, to } => VariableCommand::SetAlias {
            name: name.clone(),
            from: to.clone(),
            to: from.clone(),
        },
        VariableCommand::SetCollection { name, from, to } => VariableCommand::SetCollection {
            name: name.clone(),
            from: to.clone(),
            to: from.clone(),
        },
        VariableCommand::SetExposed { name, to } => VariableCommand::SetExposed {
            name: name.clone(),
            to: !*to,
        },
        VariableCommand::SetActiveMode { from, to } => VariableCommand::SetActiveMode {
            from: to.clone(),
            to: from.clone(),
        },
        VariableCommand::SetModeValue {
            name,
            mode,
            from,
            to,
        } => VariableCommand::SetModeValue {
            name: name.clone(),
            mode: mode.clone(),
            from: to.clone(),
            to: from.clone(),
        },
        VariableCommand::Batch(cmds) => {
            VariableCommand::Batch(cmds.iter().rev().map(invert_variable).collect())
        }
    }
}

// -------------------------------------------------------------- table glue

fn insert_base(vars: &mut Variables, name: &str, v: VarValue) {
    match v {
        VarValue::Color(c) => {
            vars.colors.insert(name.to_string(), c);
        }
        VarValue::Number(n) => {
            vars.numbers.insert(name.to_string(), n);
        }
        VarValue::Str(s) => {
            vars.strings.insert(name.to_string(), s);
        }
        VarValue::Bool(b) => {
            vars.bools.insert(name.to_string(), b);
        }
    }
}

fn remove_base(vars: &mut Variables, name: &str, kind: u8) -> bool {
    match kind {
        0 => vars.colors.remove(name).is_some(),
        1 => vars.numbers.remove(name).is_some(),
        2 => vars.strings.remove(name).is_some(),
        _ => vars.bools.remove(name).is_some(),
    }
}

fn insert_mode(vars: &mut Variables, mode: &str, name: &str, v: &VarValue) {
    match v {
        VarValue::Color(c) => {
            vars.modes.entry(mode.to_string()).or_default().insert(name.to_string(), *c);
        }
        VarValue::Number(n) => {
            vars.num_modes.entry(mode.to_string()).or_default().insert(name.to_string(), *n);
        }
        VarValue::Str(s) => {
            vars.str_modes.entry(mode.to_string()).or_default().insert(name.to_string(), s.clone());
        }
        VarValue::Bool(b) => {
            vars.bool_modes.entry(mode.to_string()).or_default().insert(name.to_string(), *b);
        }
    }
}

fn remove_mode(vars: &mut Variables, mode: &str, name: &str, kind: u8) -> bool {
    match kind {
        0 => vars.modes.get_mut(mode).and_then(|t| t.remove(name)).is_some(),
        1 => vars.num_modes.get_mut(mode).and_then(|t| t.remove(name)).is_some(),
        2 => vars.str_modes.get_mut(mode).and_then(|t| t.remove(name)).is_some(),
        _ => vars.bool_modes.get_mut(mode).and_then(|t| t.remove(name)).is_some(),
    }
}

/// Current base-table value, in `Variables::get`'s order (colors → numbers →
/// strings → bools; aliases and modes are separate concerns).
fn snapshot_base(vars: &Variables, name: &str) -> Option<VarValue> {
    if let Some(c) = vars.colors.get(name) {
        return Some(VarValue::Color(*c));
    }
    if let Some(n) = vars.numbers.get(name) {
        return Some(VarValue::Number(*n));
    }
    if let Some(s) = vars.strings.get(name) {
        return Some(VarValue::Str(s.clone()));
    }
    if let Some(b) = vars.bools.get(name) {
        return Some(VarValue::Bool(*b));
    }
    None
}

/// Current mode-table override, whatever kind it is.
fn snapshot_mode(vars: &Variables, name: &str, mode: &str) -> Option<VarValue> {
    if let Some(c) = vars.modes.get(mode).and_then(|t| t.get(name)) {
        return Some(VarValue::Color(*c));
    }
    if let Some(n) = vars.num_modes.get(mode).and_then(|t| t.get(name)) {
        return Some(VarValue::Number(*n));
    }
    if let Some(s) = vars.str_modes.get(mode).and_then(|t| t.get(name)) {
        return Some(VarValue::Str(s.clone()));
    }
    if let Some(b) = vars.bool_modes.get(mode).and_then(|t| t.get(name)) {
        return Some(VarValue::Bool(*b));
    }
    None
}

// ------------------------------------------------------------ constructors

/// Snapshot-and-set a number variable (creates it if absent).
pub fn set_number(vars: &Variables, name: &str, to: f64) -> VariableCommand {
    VariableCommand::SetBase {
        name: name.to_string(),
        from: snapshot_base(vars, name),
        to: Some(VarValue::Number(to)),
    }
}

/// Snapshot-and-set a color variable (creates it if absent).
pub fn set_color(vars: &Variables, name: &str, to: Color) -> VariableCommand {
    VariableCommand::SetBase {
        name: name.to_string(),
        from: snapshot_base(vars, name),
        to: Some(VarValue::Color(to)),
    }
}

/// Snapshot-and-set a string variable (creates it if absent).
pub fn set_string(vars: &Variables, name: &str, to: impl Into<String>) -> VariableCommand {
    VariableCommand::SetBase {
        name: name.to_string(),
        from: snapshot_base(vars, name),
        to: Some(VarValue::Str(to.into())),
    }
}

/// Snapshot-and-set a boolean variable (creates it if absent).
pub fn set_bool(vars: &Variables, name: &str, to: bool) -> VariableCommand {
    VariableCommand::SetBase {
        name: name.to_string(),
        from: snapshot_base(vars, name),
        to: Some(VarValue::Bool(to)),
    }
}

/// Delete a variable (base value or alias); `None` if nothing is there.
pub fn remove_variable(vars: &Variables, name: &str) -> Option<VariableCommand> {
    if let Some(v) = snapshot_base(vars, name) {
        return Some(VariableCommand::SetBase {
            name: name.to_string(),
            from: Some(v),
            to: None,
        });
    }
    if let Some(t) = vars.aliases.get(name) {
        return Some(VariableCommand::SetAlias {
            name: name.to_string(),
            from: Some(t.clone()),
            to: None,
        });
    }
    None
}

/// Snapshot-and-set an alias (`target = None` clears it).
pub fn set_alias(vars: &Variables, name: &str, target: Option<&str>) -> VariableCommand {
    VariableCommand::SetAlias {
        name: name.to_string(),
        from: vars.aliases.get(name).cloned(),
        to: target.map(str::to_string),
    }
}

/// Snapshot-and-set a variable's collection tag (`None`/empty/"Local" untags).
pub fn set_collection(vars: &Variables, name: &str, coll: Option<&str>) -> VariableCommand {
    VariableCommand::SetCollection {
        name: name.to_string(),
        from: vars.collections.get(name).cloned(),
        to: coll.map(str::to_string),
    }
}

/// Toggle prototype-viewer exposure for a variable.
pub fn set_exposed(vars: &Variables, name: &str, on: bool) -> VariableCommand {
    let _ = vars; // snapshot lives in the model (BTreeSet membership)
    VariableCommand::SetExposed {
        name: name.to_string(),
        to: on,
    }
}

/// Snapshot-and-switch the active mode; `None` if `mode` has no table
/// (mirrors `Variables::set_mode`'s validation).
pub fn set_active_mode(vars: &Variables, mode: &str) -> Option<VariableCommand> {
    let known = vars.modes.contains_key(mode)
        || vars.num_modes.contains_key(mode)
        || vars.str_modes.contains_key(mode)
        || vars.bool_modes.contains_key(mode);
    if !known {
        return None;
    }
    Some(VariableCommand::SetActiveMode {
        from: vars.active_mode.clone(),
        to: Some(mode.to_string()),
    })
}

/// Clear the active mode (back to base tables). No-op-safe.
pub fn clear_active_mode(vars: &Variables) -> Option<VariableCommand> {
    vars.active_mode.as_ref()?;
    Some(VariableCommand::SetActiveMode {
        from: vars.active_mode.clone(),
        to: None,
    })
}

/// Snapshot-and-set a mode-scoped override (creates the mode table if absent).
pub fn set_mode_value(
    vars: &Variables,
    name: &str,
    mode: &str,
    to: VarValue,
) -> VariableCommand {
    VariableCommand::SetModeValue {
        name: name.to_string(),
        mode: mode.to_string(),
        from: snapshot_mode(vars, name, mode),
        to: Some(to),
    }
}

/// Delete a mode-scoped override; `None` if the variable has no override in
/// that mode (any kind).
pub fn remove_mode_value(vars: &Variables, name: &str, mode: &str) -> Option<VariableCommand> {
    let from = snapshot_mode(vars, name, mode)?;
    Some(VariableCommand::SetModeValue {
        name: name.to_string(),
        mode: mode.to_string(),
        from: Some(from),
        to: None,
    })
}

/// Rename a variable as one undoable [`VariableCommand::Batch`]: the value
/// moves to `new`, the old name becomes an alias of the new one (so existing
/// bindings — `Node::bind`, style refs, prototype expressions — keep
/// resolving), and the old entry is retired. Renaming an alias re-points it
/// instead. Mode-scoped overrides keep the old name in v1 (resolution goes
/// through the alias only for base lookups). `None` when `new` is empty,
/// equals `old`, or `old` has neither value nor alias.
pub fn rename_variable(vars: &Variables, old: &str, new: &str) -> Option<VariableCommand> {
    let new = new.trim();
    if new.is_empty() || new == old {
        return None;
    }
    if let Some(target) = vars.aliases.get(old).cloned() {
        // Re-point the alias under its new name and retire the old one
        // (chains stay within the model's MAX_ALIAS_DEPTH walk).
        return Some(VariableCommand::Batch(vec![
            set_alias(vars, old, None),
            VariableCommand::SetAlias {
                name: new.to_string(),
                from: None,
                to: Some(target),
            },
        ]));
    }
    let value = snapshot_base(vars, old)?;
    Some(VariableCommand::Batch(vec![
        VariableCommand::SetBase {
            name: new.to_string(),
            from: snapshot_base(vars, new),
            to: Some(value.clone()),
        },
        set_alias(vars, old, Some(new)),
        VariableCommand::SetBase {
            name: old.to_string(),
            from: Some(value),
            to: None,
        },
    ]))
}

/// Convenience: apply a batch (e.g. one panel edit fanned out over several
/// variables). Returns how many edits changed state.
pub fn apply_all(vars: &mut Variables, cmds: &[VariableCommand]) -> usize {
    cmds.iter().filter(|c| apply_variable(vars, c)).count()
}

// ----------------------------------------------------------------- history

/// Undo/redo log for variable edits (command-log architecture, matching
/// `Editor`'s stacks; `limit == 0` means unbounded).
#[derive(Debug, Clone, Default)]
pub struct VariableHistory {
    undo: Vec<VariableCommand>,
    redo: Vec<VariableCommand>,
    limit: usize,
}

impl VariableHistory {
    pub fn new(limit: usize) -> Self {
        Self {
            undo: Vec::new(),
            redo: Vec::new(),
            limit,
        }
    }

    /// Apply + record. A rejected edit (apply returned `false`) pushes nothing
    /// and clears nothing — the caller can surface the rejection.
    pub fn commit(&mut self, vars: &mut Variables, cmd: VariableCommand) -> bool {
        if !apply_variable(vars, &cmd) {
            return false;
        }
        self.redo.clear();
        self.undo.push(cmd);
        if self.limit > 0 && self.undo.len() > self.limit {
            self.undo.remove(0);
        }
        true
    }

    pub fn undo(&mut self, vars: &mut Variables) -> bool {
        let Some(cmd) = self.undo.pop() else {
            return false;
        };
        if apply_variable(vars, &invert_variable(&cmd)) {
            self.redo.push(cmd);
            true
        } else {
            // Should not happen (commands carry their own exact inverses);
            // restore forward state so history stays consistent.
            self.undo.push(cmd);
            false
        }
    }

    pub fn redo(&mut self, vars: &mut Variables) -> bool {
        let Some(cmd) = self.redo.pop() else {
            return false;
        };
        if apply_variable(vars, &cmd) {
            self.undo.push(cmd);
            true
        } else {
            self.redo.push(cmd);
            false
        }
    }

    pub fn undo_len(&self) -> usize {
        self.undo.len()
    }

    pub fn redo_len(&self) -> usize {
        self.redo.len()
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }
}

// ------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::Value;

    #[test]
    fn number_create_undo_redo() {
        let mut vars = Variables::default();
        let mut h = VariableHistory::default();
        assert!(h.commit(&mut vars, set_number(&vars, "gap", 8.0)));
        assert_eq!(vars.get("gap"), Some(Value::Num(8.0)));
        assert_eq!(vars.catalog()[0].2, "number");
        assert!(h.undo(&mut vars));
        assert_eq!(vars.get("gap"), None);
        assert!(h.redo(&mut vars));
        assert_eq!(vars.get("gap"), Some(Value::Num(8.0)));
    }

    #[test]
    fn color_roundtrip_and_mode_override() {
        let mut vars = Variables::default();
        let mut h = VariableHistory::default();
        let base = Color::from_rgb8(0x11, 0x22, 0x33);
        assert!(h.commit(&mut vars, set_color(&vars, "brand", base)));
        assert!(h.commit(
            &mut vars,
            set_mode_value(&vars, "brand", "dark", VarValue::color_of("#ff0000").unwrap())
        ));
        assert!(h.commit(&mut vars, set_active_mode(&vars, "dark").unwrap()));
        let active_hex = vars.get("brand").unwrap();
        assert_ne!(active_hex, Value::Str(color_to_hex(base)));
        // Undo active mode → base color again.
        assert!(h.undo(&mut vars));
        assert_eq!(vars.get("brand"), Some(Value::Str(color_to_hex(base))));
        // Unknown mode is rejected and pushes nothing.
        let bad = set_active_mode(&vars, "nope").unwrap_or(VariableCommand::SetActiveMode {
            from: None,
            to: Some("nope".into()),
        });
        assert!(!h.commit(&mut vars, bad));
        assert_eq!(h.undo_len(), 2);
    }

    #[test]
    fn alias_resolves_and_undos() {
        let mut vars = Variables::default();
        let mut h = VariableHistory::default();
        h.commit(&mut vars, set_number(&vars, "radius", 8.0));
        h.commit(&mut vars, set_alias(&vars, "r", Some("radius")));
        assert_eq!(vars.get("r"), Some(Value::Num(8.0)));
        h.commit(&mut vars, set_alias(&vars, "r", None));
        assert_eq!(vars.get("r"), None);
        h.undo(&mut vars);
        assert_eq!(vars.get("r"), Some(Value::Num(8.0)));
    }

    #[test]
    fn type_move_and_exact_restore() {
        let mut vars = Variables::default();
        let mut h = VariableHistory::default();
        h.commit(&mut vars, set_number(&vars, "v", 1.0));
        h.commit(&mut vars, set_string(&vars, "v", "auto"));
        assert_eq!(vars.get("v"), Some(Value::Str("auto".into())));
        assert!(!vars.numbers.contains_key("v"), "type move clears old table");
        h.undo(&mut vars);
        assert_eq!(vars.get("v"), Some(Value::Num(1.0)));
        assert!(!vars.strings.contains_key("v"), "inverse restores old table exactly");
    }

    #[test]
    fn remove_variable_restores_exact_color() {
        let mut vars = Variables::default();
        let mut h = VariableHistory::default();
        let c = Color::from_rgb8(0xAA, 0xBB, 0xCC);
        h.commit(&mut vars, set_color(&vars, "bg", c));
        let cmd = remove_variable(&vars, "bg").unwrap();
        h.commit(&mut vars, cmd);
        assert_eq!(vars.get("bg"), None);
        h.undo(&mut vars);
        assert_eq!(vars.get("bg"), Some(Value::Str(color_to_hex(c))));
    }

    #[test]
    fn collection_exposed_catalog() {
        let mut vars = Variables::default();
        let mut h = VariableHistory::default();
        h.commit(&mut vars, set_number(&vars, "gap", 4.0));
        h.commit(&mut vars, set_collection(&vars, "gap", Some("Primitives")));
        h.commit(&mut vars, set_exposed(&vars, "gap", true));
        assert_eq!(vars.collection_of("gap"), "Primitives");
        assert!(vars.exposed.contains("gap"));
        assert_eq!(vars.catalog()[0].0, "Primitives");
        h.undo(&mut vars); // un-expose
        assert!(!vars.exposed.contains("gap"));
        h.undo(&mut vars); // untag collection
        assert_eq!(vars.collection_of("gap"), "Local");
        // "Local" and "" are untag aliases of each other — second is a no-op.
        assert!(!h.commit(&mut vars, set_collection(&vars, "gap", Some("Local"))));
    }

    #[test]
    fn mode_value_remove_and_reject_underspecified() {
        let mut vars = Variables::default();
        let mut h = VariableHistory::default();
        h.commit(&mut vars, set_color(&vars, "bg", Color::from_rgb8(1, 2, 3)));
        h.commit(
            &mut vars,
            set_mode_value(&vars, "bg", "dark", VarValue::color_of("#00ff00").unwrap()),
        );
        let rm = remove_mode_value(&vars, "bg", "dark").unwrap();
        h.commit(&mut vars, rm);
        assert_eq!(snapshot_mode(&vars, "bg", "dark"), None);
        h.undo(&mut vars);
        // Exact override restored — compare components (hex formatting is the
        // model's business, not ours).
        match snapshot_mode(&vars, "bg", "dark") {
            Some(VarValue::Color(c)) => {
                let t = c.to_rgba8();
                assert_eq!([t.r, t.g, t.b, t.a], [0, 255, 0, 255]);
            }
            other => panic!("expected dark-mode color override, got {other:?}"),
        }
        // Underspecified removal (no from) is rejected.
        assert!(!apply_variable(
            &mut vars,
            &VariableCommand::SetModeValue {
                name: "bg".into(),
                mode: "dark".into(),
                from: None,
                to: None,
            }
        ));
    }

    #[test]
    fn redo_cleared_on_new_commit_and_limit_holds() {
        let mut vars = Variables::default();
        let mut h = VariableHistory::new(2);
        h.commit(&mut vars, set_number(&vars, "n", 1.0));
        h.commit(&mut vars, set_number(&vars, "n", 2.0));
        h.undo(&mut vars);
        assert_eq!(h.redo_len(), 1);
        h.commit(&mut vars, set_number(&vars, "n", 3.0)); // clears redo
        assert_eq!(h.redo_len(), 0);
        h.commit(&mut vars, set_number(&vars, "n", 4.0)); // exceeds limit 2
        assert_eq!(h.undo_len(), 2);
        // No-op edits are rejected and record nothing.
        assert!(!h.commit(&mut vars, set_number(&vars, "n", 4.0)));
        assert_eq!(h.undo_len(), 2);
    }

    #[test]
    fn apply_all_counts_changes() {
        let mut vars = Variables::default();
        let cmds = vec![
            set_number(&vars, "a", 1.0),
            set_bool(&vars, "flag", true),
            set_exposed(&vars, "a", true),
        ];
        assert_eq!(apply_all(&mut vars, &cmds), 3);
        assert_eq!(vars.get("flag"), Some(Value::Bool(true)));
    }

    #[test]
    fn rename_moves_value_keeps_old_references_and_undo_restores() {
        let mut vars = Variables::default();
        let mut h = VariableHistory::default();
        h.commit(&mut vars, set_number(&vars, "gap", 8.0));
        let cmd = rename_variable(&vars, "gap", "spacing").unwrap();
        assert!(h.commit(&mut vars, cmd));
        assert_eq!(vars.get("spacing"), Some(Value::Num(8.0)));
        // Old references keep resolving through the alias…
        assert_eq!(vars.get("gap"), Some(Value::Num(8.0)));
        // …but the old entry is retired (the catalog shows one variable).
        assert!(!vars.numbers.contains_key("gap"));
        assert_eq!(vars.catalog().len(), 1);
        // One undo reverts the whole rename.
        assert!(h.undo(&mut vars));
        assert_eq!(vars.get("gap"), Some(Value::Num(8.0)));
        assert!(!vars.numbers.contains_key("spacing"));
        assert_eq!(vars.aliases.get("gap"), None);
        // Guards: empty and same-name renames are rejected.
        assert!(rename_variable(&vars, "gap", "").is_none());
        assert!(rename_variable(&vars, "gap", "gap").is_none());
    }

    #[test]
    fn rename_alias_repoints_instead() {
        let mut vars = Variables::default();
        let mut h = VariableHistory::default();
        h.commit(&mut vars, set_number(&vars, "radius", 8.0));
        h.commit(&mut vars, set_alias(&vars, "r", Some("radius")));
        let cmd = rename_variable(&vars, "r", "corner").unwrap();
        assert!(h.commit(&mut vars, cmd));
        assert_eq!(vars.get("corner"), Some(Value::Num(8.0)));
        assert_eq!(vars.aliases.get("r"), None);
        assert!(h.undo(&mut vars));
        assert_eq!(vars.aliases.get("r").map(String::as_str), Some("radius"));
        assert_eq!(vars.aliases.get("corner"), None);
    }
}
