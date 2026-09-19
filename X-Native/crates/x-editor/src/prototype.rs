use crate::selection::hit_test;
#[allow(unused_imports)]
use crate::*;
use x_core::kurbo::{Affine, Point};
use x_core::peniko::Color;
use x_core::*;

// ------------------------------------------------------- prototype playback

/// One open overlay: the frame floating above the current screen, and
/// where it is anchored (see [`overlay_offset`]).
#[derive(Debug, Clone, PartialEq)]
pub struct Overlay {
    pub frame: String,
    pub position: OverlayPosition,
}

/// Cap on simultaneously open overlays — untrusted `.x` files can nest
/// `OpenOverlay` actions arbitrarily deep through `Cond` chains, and each
/// open overlay costs a paint pass in hosts.
pub const MAX_OVERLAYS: usize = 16;

/// What firing one action did. Hosts (the editor player, the app's flow
/// preview) share the [`fire_action`] engine and use the effect to
/// refocus, repaint, and re-arm delay triggers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FireEffect {
    /// A new screen became current (navigate / back / bare swap).
    pub navigated: Option<String>,
    /// The interaction's transition, for animated hosts.
    pub transition_ms: u32,
    /// The overlay stack changed (open / swap / close / cleared).
    pub overlays_changed: bool,
    /// Preview variables changed (a set-var / set-mode / conditional ran).
    pub vars_changed: bool,
    /// Figma "scroll to": pan the viewport to this node without leaving
    /// the screen — no history, no overlay changes, no delay re-arm.
    pub scrolled_to: Option<String>,
    /// Figma "open link": hand this URL to the system browser; nothing
    /// else changes.
    pub opened_link: Option<String>,
}

impl FireEffect {
    fn none(transition_ms: u32) -> Self {
        Self {
            navigated: None,
            transition_ms,
            overlays_changed: false,
            vars_changed: false,
            scrolled_to: None,
            opened_link: None,
        }
    }

    /// Did firing do anything observable at all?
    pub fn fired(&self) -> bool {
        self.navigated.is_some()
            || self.overlays_changed
            || self.vars_changed
            || self.scrolled_to.is_some()
            || self.opened_link.is_some()
    }
}

/// Fire one prototype action against preview state.
///
/// `vars` is the PREVIEW's store — hosts pass a clone of the document
/// variables, so `SetVar`/`SetMode`/conditionals can never edit the file.
/// `known` reports whether a frame id exists (each host checks its own
/// page model). Navigation clears the overlay stack: leaving a screen
/// dismisses whatever floated above it.
#[allow(clippy::too_many_arguments)]
pub fn fire_action(
    current: &mut String,
    stack: &mut Vec<String>,
    overlays: &mut Vec<Overlay>,
    vars: &mut Variables,
    known: &dyn Fn(&str) -> bool,
    action: &Action,
    transition_ms: u32,
) -> FireEffect {
    let nav = run_action(action, vars);
    // A conditional that resolves to navigation wrote nothing; one that
    // resolves to logic (or nowhere) counts as a variable effect.
    let vars_changed = nav.is_none()
        && matches!(
            action,
            Action::SetVar { .. } | Action::SetMode { .. } | Action::Cond { .. }
        );
    let Some(nav) = nav else {
        let mut effect = FireEffect::none(transition_ms);
        effect.vars_changed = vars_changed;
        return effect;
    };
    match nav {
        Action::Navigate { destination } => {
            if !known(&destination) {
                return FireEffect::none(transition_ms);
            }
            stack.push(current.clone());
            *current = destination.clone();
            let cleared = !overlays.is_empty();
            overlays.clear();
            FireEffect {
                navigated: Some(destination),
                transition_ms,
                overlays_changed: cleared,
                vars_changed,
                scrolled_to: None,
                opened_link: None,
            }
        }
        // Figma "scroll to": pan within the current screen — no history
        // entry, no overlay changes, no delay re-arm. Hosts move the
        // viewport to the destination and stay on the screen.
        Action::ScrollTo { destination } => {
            if !known(&destination) {
                return FireEffect::none(transition_ms);
            }
            FireEffect {
                navigated: None,
                transition_ms,
                overlays_changed: false,
                vars_changed,
                scrolled_to: Some(destination),
                opened_link: None,
            }
        }
        Action::Back => {
            let Some(prev) = stack.pop() else {
                return FireEffect::none(transition_ms);
            };
            *current = prev.clone();
            let cleared = !overlays.is_empty();
            overlays.clear();
            FireEffect {
                navigated: Some(prev),
                transition_ms,
                overlays_changed: cleared,
                vars_changed,
                scrolled_to: None,
                opened_link: None,
            }
        }
        Action::OpenOverlay { overlay, position } => {
            if !known(&overlay) || overlays.len() >= MAX_OVERLAYS {
                return FireEffect::none(transition_ms);
            }
            overlays.push(Overlay {
                frame: overlay,
                position,
            });
            FireEffect {
                navigated: None,
                transition_ms,
                overlays_changed: true,
                vars_changed,
                scrolled_to: None,
                opened_link: None,
            }
        }
        // Figma "swap overlay": with an overlay open, the top one is
        // replaced in place (settings kept); from a bare frame it behaves
        // like "navigate to" — a screen change that adds NO history, so
        // Back skips it. (Figma keys this on the hotspot's location; the
        // engine keys it on stack emptiness, which agrees whenever the
        // hotspot that fired sits in the topmost layer — the only node a
        // top-down player can hit.)
        Action::SwapOverlay { overlay } => {
            if !known(&overlay) {
                return FireEffect::none(transition_ms);
            }
            if let Some(top) = overlays.last_mut() {
                top.frame = overlay;
                FireEffect {
                    navigated: None,
                    transition_ms,
                    overlays_changed: true,
                    vars_changed,
                    scrolled_to: None,
                    opened_link: None,
                }
            } else {
                *current = overlay.clone();
                FireEffect {
                    navigated: Some(overlay),
                    transition_ms,
                    overlays_changed: false,
                    vars_changed,
                    scrolled_to: None,
                    opened_link: None,
                }
            }
        }
        Action::CloseOverlay => {
            if overlays.pop().is_none() {
                return FireEffect::none(transition_ms);
            }
            FireEffect {
                navigated: None,
                transition_ms,
                overlays_changed: true,
                vars_changed,
                scrolled_to: None,
                opened_link: None,
            }
        }
        // Figma "open link": leaves the prototype — the URL rides the
        // effect to the host; nothing else changes.
        Action::OpenLink { url } => FireEffect {
            navigated: None,
            transition_ms,
            overlays_changed: false,
            vars_changed,
            scrolled_to: None,
            opened_link: Some(url),
        },
        // Unreachable: `run_action` consumes the logic actions into `None`
        // above; the arm exists because the match must be exhaustive.
        Action::SetVar { .. } | Action::SetMode { .. } | Action::Cond { .. } => {
            let mut effect = FireEffect::none(transition_ms);
            effect.vars_changed = true;
            effect
        }
    }
}

/// What one Esc press did in the player: dismiss the top overlay first,
/// then step back through navigation history, then signal exit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EscOutcome {
    Dismissed,
    Back,
    Exit,
}

/// World position of a node's local origin, accumulating transforms from
/// `root`. Used to anchor overlays at their rendered position.
pub fn world_origin(root: &Node, id: &str) -> Option<Point> {
    fn walk(n: &Node, parent: Affine, id: &str) -> Option<Point> {
        let world = parent * n.transform.matrix(n.w, n.h);
        if n.id == id {
            return Some(world * Point::new(0.0, 0.0));
        }
        n.children.iter().find_map(|c| walk(c, world, id))
    }
    walk(root, Affine::IDENTITY, id)
}

/// Hit-test the open overlay stack top-down: the topmost
/// `(overlay_frame_id, hit_node_id)` under `point`, or `None` when the
/// point misses every overlay. Overlays render at [`overlay_offset`] from
/// the current frame's world origin — NOT at their authored position —
/// so each candidate is relocated before hit-testing. Frames are assumed
/// axis-aligned (a rotated frame would skew the anchor).
pub fn hit_overlay(
    root: &Node,
    frame_id: &str,
    overlays: &[Overlay],
    point: Point,
) -> Option<(String, String)> {
    let frame = find(root, frame_id)?;
    let origin = world_origin(root, frame_id)?;
    for ov in overlays.iter().rev() {
        let Some(node) = find(root, &ov.frame) else {
            continue;
        };
        let (ox, oy) = overlay_offset(frame.w, frame.h, node.w, node.h, ov.position);
        let mut placed = node.clone();
        placed.transform.x = origin.x + ox;
        placed.transform.y = origin.y + oy;
        if let Some(hit) = hit_test(&placed, point) {
            return Some((ov.frame.clone(), hit));
        }
    }
    None
}

/// An armed `AfterDelay` trigger: fire `ix` when the player clock reaches
/// `at_ms`. `source_overlay` pins delays authored inside an overlay:
/// closing the overlay disarms them.
#[derive(Debug, Clone, PartialEq)]
pub struct Delay {
    pub at_ms: u64,
    pub source_overlay: Option<String>,
    pub ix: Interaction,
}

/// A "while" interaction in flight: Figma's "while hovering" and "while
/// pressing" auto-reverse — leaving the hotspot (hover) or lifting the
/// pointer (press) undoes the navigate/overlay-open. The revert only
/// lands if the player still sits in the "while" result: anything else
/// the user did meanwhile (a click that navigated on) wins and the span
/// dies quietly. Shared with hosts so every player reverts alike.
#[derive(Debug, Clone, PartialEq)]
pub enum WhileSpan {
    /// A "while" navigate pushed `origin` and landed on `dest`: revert
    /// pops the push and shows `origin` again.
    Navigated {
        hotspot: String,
        origin: String,
        dest: String,
    },
    /// A "while" trigger opened overlay `frame`: revert removes it.
    OverlayOpened { hotspot: String, frame: String },
}

impl WhileSpan {
    /// The hotspot whose "while" trigger armed this span.
    pub fn hotspot(&self) -> &str {
        match self {
            WhileSpan::Navigated { hotspot, .. } => hotspot,
            WhileSpan::OverlayOpened { hotspot, .. } => hotspot,
        }
    }
}

/// Prototype player: the full 9-trigger / 10-action interaction model
/// over one document tree. Hosts feed pointer/key/clock events and read
/// back `current` / `stack` / `overlays`; transition metadata is
/// surfaced so a renderer can animate.
///
/// `vars` is the preview's OWN store — hosts clone the document variables
/// in ([`Player::with_vars`]) so playback can never edit the file.
pub struct Player<'a> {
    pub doc: &'a Node,
    pub current: String,
    /// navigation history (back target + depth); pub so hosts can render
    /// "back" affordances
    pub stack: Vec<String>,
    /// open overlay stack, bottom → top.
    pub overlays: Vec<Overlay>,
    /// preview-owned variables (see above).
    pub vars: Variables,
    /// node id under the pointer (drives hover / enter / leave).
    pub hovered: Option<String>,
    /// armed `AfterDelay` triggers, in arm order.
    pub delays: Vec<Delay>,
    /// logical clock (ms); hosts advance it with [`Player::tick`].
    pub now_ms: u64,
    dragging: bool,
    drag_fired: bool,
    hover_span: Option<WhileSpan>,
    press_span: Option<WhileSpan>,
}
impl<'a> Player<'a> {
    pub fn new(doc: &'a Node, start: &str) -> Self {
        let mut p = Self {
            doc,
            current: start.into(),
            stack: vec![],
            overlays: vec![],
            vars: Variables::default(),
            hovered: None,
            delays: vec![],
            now_ms: 0,
            dragging: false,
            drag_fired: false,
            hover_span: None,
            press_span: None,
        };
        p.arm_delays();
        p
    }

    /// Same, with the preview variable store preloaded (hosts clone the
    /// document variables so playback can't edit the file).
    pub fn with_vars(doc: &'a Node, start: &str, vars: Variables) -> Self {
        let mut p = Self::new(doc, start);
        p.vars = vars;
        p
    }

    /// Run one interaction's action through the shared engine, then reset
    /// hover and re-arm delays when the screen changed.
    fn fire(&mut self, ix: &Interaction) -> FireEffect {
        let doc = self.doc;
        let effect = fire_action(
            &mut self.current,
            &mut self.stack,
            &mut self.overlays,
            &mut self.vars,
            &|id| find(doc, id).is_some(),
            &ix.action,
            ix.transition_ms,
        );
        if effect.navigated.is_some() {
            self.hovered = None;
            self.arm_delays();
        } else if effect.overlays_changed {
            self.arm_overlay_delays();
        }
        effect
    }

    /// The `trigger` interaction owned by `hit`, searching the topmost
    /// overlay first, then the current frame. Split from `fire_trigger`
    /// so the search borrows `&self` and returns an owned interaction —
    /// firing it borrows `&mut self` (it may push/pop overlays).
    fn find_trigger(&self, hit: &str, trigger: &Trigger) -> Option<Interaction> {
        for ov in self.overlays.iter().rev() {
            let found = find(self.doc, &ov.frame)
                .and_then(|n| find_interaction_for(n, hit, trigger.clone()));
            if let Some((_, ix)) = found {
                return Some(ix);
            }
        }
        find(self.doc, &self.current)
            .and_then(|n| find_interaction_for(n, hit, trigger.clone()))
            .map(|(_, ix)| ix)
    }

    /// Fire `trigger` for `hit` wherever it lives: the topmost overlay
    /// first, then the current frame. `false` when nothing handles it.
    fn fire_trigger(&mut self, hit: &str, trigger: Trigger) -> bool {
        self.fire_trigger_effect(hit, trigger).is_some()
    }

    /// [`Player::fire_trigger`], returning the fired interaction's effect
    /// instead of "handled": `None` when no interaction carries the
    /// trigger, and an effect whose [`FireEffect::fired`] is false when the
    /// action was inert (a `Back` with no history, a `CloseOverlay` with
    /// nothing open). Callers that mean "did anything happen" — the drag
    /// cycle, the click path — need that distinction, exactly as
    /// [`Player::click`] does.
    fn fire_trigger_effect(&mut self, hit: &str, trigger: Trigger) -> Option<FireEffect> {
        let ix = self.find_trigger(hit, &trigger)?;
        let origin = self.current.clone();
        let overlay_depth = self.overlays.len();
        let stack_depth = self.stack.len();
        let effect = self.fire(&ix);
        self.arm_while_span(hit, &trigger, &origin, overlay_depth, stack_depth);
        Some(effect)
    }

    /// Arm Figma's while-hovering/while-pressing auto-reverse: a "while"
    /// trigger that navigated (with a history push) or opened an overlay
    /// reverts when the pointer leaves (hover) or lifts (press). Logic
    /// actions, closes, backs, and swaps never arm — a back already
    /// popped, so there is no push to return.
    fn arm_while_span(
        &mut self,
        hit: &str,
        trigger: &Trigger,
        origin: &str,
        overlay_depth: usize,
        stack_depth: usize,
    ) {
        let slot = match trigger {
            Trigger::OnHover => &mut self.hover_span,
            Trigger::OnPress => &mut self.press_span,
            _ => return,
        };
        *slot = None;
        if self.current != origin && self.stack.len() > stack_depth {
            *slot = Some(WhileSpan::Navigated {
                hotspot: hit.into(),
                origin: origin.into(),
                dest: self.current.clone(),
            });
        } else if self.overlays.len() > overlay_depth {
            if let Some(top) = self.overlays.last() {
                *slot = Some(WhileSpan::OverlayOpened {
                    hotspot: hit.into(),
                    frame: top.frame.clone(),
                });
            }
        }
    }

    /// Revert a taken "while" span: navigate back without pushing
    /// history (re-arming the origin screen's delays), or remove the
    /// opened overlay — but only if the player still sits in the "while"
    /// result. Returns whether anything reverted.
    fn revert_span(&mut self, span: Option<WhileSpan>) -> bool {
        match span {
            Some(WhileSpan::Navigated { origin, dest, .. }) if self.current == dest => {
                self.current = origin;
                self.stack.pop();
                self.arm_delays();
                true
            }
            Some(WhileSpan::OverlayOpened { frame, .. })
                if self.overlays.iter().any(|o| o.frame == frame) =>
            {
                self.overlays.retain(|o| o.frame != frame);
                true
            }
            _ => false,
        }
    }

    /// Drop the hover span when the pointer leaves `hotspot`, reverting
    /// its effect when the player still sits in the "while" result.
    /// Returns whether anything reverted.
    fn leave_hover_span(&mut self, hotspot: &str) -> bool {
        let relevant = self
            .hover_span
            .as_ref()
            .is_some_and(|s| s.hotspot() == hotspot);
        if !relevant {
            return false;
        }
        // take the span out first: `revert_span` borrows `self` mutably, so it
        // cannot share the call with the `Option::take` that reads the field
        let span = self.hover_span.take();
        self.revert_span(span)
    }

    /// Drop the press span on release, reverting its effect when the
    /// player still sits in the "while" result (wherever the pointer
    /// lifted). Returns whether anything reverted.
    fn release_press_span(&mut self) -> bool {
        // same split as `leave_hover_span` (see above)
        let span = self.press_span.take();
        self.revert_span(span)
    }

    /// Node under `point` plus the subtree to search for its triggers:
    /// `(search_root_id, hit_node_id)`. The topmost overlay wins, else the
    /// current frame.
    fn pick(&self, point: Point) -> Option<(String, String)> {
        if let Some(hit) = hit_overlay(self.doc, &self.current, &self.overlays, point) {
            return Some(hit);
        }
        let frame = find(self.doc, &self.current)?;
        hit_test(frame, point).map(|hit| (self.current.clone(), hit))
    }

    /// Show `frame` as a fresh preview session: clear the navigation
    /// history, the overlays, and all hover/drag/while-span state, then
    /// arm delays. The host enters its viewer the same way (a fresh
    /// `FlowState`), so a re-entry can never inherit a stale back target:
    /// a "while hovering" span abandoned by `enter` has its push dropped
    /// with the rest of the history.
    pub fn enter(&mut self, frame: &str) {
        self.current = frame.into();
        self.stack.clear();
        self.overlays.clear();
        self.hovered = None;
        self.dragging = false;
        self.drag_fired = false;
        self.hover_span = None;
        self.press_span = None;
        self.arm_delays();
    }

    /// Arm the current frame's `AfterDelay` triggers against the clock.
    /// Called on enter and after every navigation; navigation discards
    /// previously armed delays (pending timers don't survive a screen).
    pub fn arm_delays(&mut self) {
        let Some(frame) = find(self.doc, &self.current) else {
            self.delays.clear();
            return;
        };
        let now = self.now_ms;
        let mut armed = Vec::new();
        for (_, ms, ix) in delayed_interactions(frame) {
            armed.push(Delay {
                at_ms: now.saturating_add(u64::from(ms)),
                source_overlay: None,
                ix,
            });
        }
        self.delays = armed;
    }

    /// Arm `AfterDelay` triggers of the topmost overlay (base-frame delays
    /// keep running underneath). Stale entries die in [`Player::tick`].
    fn arm_overlay_delays(&mut self) {
        let (Some(top), now) = (self.overlays.last().cloned(), self.now_ms) else {
            return;
        };
        let Some(node) = find(self.doc, &top.frame) else {
            return;
        };
        for (_, ms, ix) in delayed_interactions(node) {
            self.delays.push(Delay {
                at_ms: now.saturating_add(u64::from(ms)),
                source_overlay: Some(top.frame.clone()),
                ix,
            });
        }
    }

    /// Click at `point` (document coords). The topmost overlay under the
    /// point eats the click first; otherwise the nearest ancestor of the
    /// hit node carrying an `OnClick` interaction fires it — rich
    /// `Node::interactions` first, legacy `prototype` links via the same
    /// `effective_interactions` path the runtime uses everywhere else.
    /// Returns transition ms when the click did something observable
    /// (navigated, changed overlays, or ran variable logic).
    pub fn click(&mut self, point: Point) -> Option<u32> {
        if let Some((frame_id, hit_id)) =
            hit_overlay(self.doc, &self.current, &self.overlays, point)
        {
            let node = find(self.doc, &frame_id)?;
            let (_, ix) = find_interaction_for(node, &hit_id, Trigger::OnClick)?;
            let effect = self.fire(&ix);
            return effect.fired().then_some(ix.transition_ms);
        }
        let frame = find(self.doc, &self.current)?;
        let hit_id = hit_test(frame, point)?;
        let (_owner, ix) = find_interaction_for(frame, &hit_id, Trigger::OnClick)?;
        let effect = self.fire(&ix);
        effect.fired().then_some(ix.transition_ms)
    }

    /// Move the pointer to `point`: fires `MouseLeave` on the node being
    /// left and `MouseEnter` then `OnHover` on the node being entered
    /// (either may be absent), then the while-hovering auto-reverse.
    /// Overlays participate top-down. Hovering the same node twice fires
    /// nothing the second time. A "while hovering" navigate clears hover
    /// tracking, orphaning its span — the next move anywhere counts as
    /// leaving the hotspot, even onto empty canvas. Returns `true` when
    /// something fired or reverted.
    pub fn hover(&mut self, point: Point) -> bool {
        let next = self.pick(point).map(|(_, hit)| hit);
        let orphan = self.hovered.is_none() && self.hover_span.is_some();
        if next == self.hovered && !orphan {
            return false;
        }
        let mut fired = false;
        let orphan_hotspot = self.hover_span.as_ref().map(|s| s.hotspot().to_string());
        let old = self.hovered.clone().or(orphan_hotspot);
        if let Some(old) = old {
            if Some(&old) != next.as_ref() {
                fired |= self.fire_trigger(&old, Trigger::MouseLeave);
                // explicit leave first (authorial intent), then the
                // ambient while-hovering auto-reverse — guarded, so it
                // quietly dies when the explicit leave already moved on
                fired |= self.leave_hover_span(&old);
            }
        }
        self.hovered = next.clone();
        if let Some(hit) = next {
            fired |= self.fire_trigger(&hit, Trigger::MouseEnter);
            fired |= self.fire_trigger(&hit, Trigger::OnHover);
        }
        fired
    }

    /// Press down at `point`: fires `OnPress` on the node under the
    /// pointer and arms drag detection. Hosts call this on mouse-down and
    /// [`Player::click`] for the tap itself. Pressing a new node while a
    /// "while hovering" span is armed keeps the orphan (hover tracking
    /// stays cleared), so the next move still counts as leaving the
    /// hotspot; real streams hover-move before pressing, so this only
    /// triggers on press-without-move.
    pub fn press(&mut self, point: Point) -> bool {
        self.dragging = true;
        self.drag_fired = false;
        if let Some((_, hit)) = self.pick(point) {
            let orphaned = self.hover_span.as_ref().is_some_and(|s| s.hotspot() != hit);
            if !orphaned {
                self.hovered = Some(hit.clone());
            }
            let mut fired = self.fire_trigger(&hit, Trigger::OnPress);
            // Mouse down is the press itself: permanent and one-way, where
            // "while pressing" arms the release that unwinds it
            fired |= self.fire_trigger(&hit, Trigger::MouseDown);
            fired
        } else {
            false
        }
    }

    /// Drag through `point` (pointer held): fires `OnDrag` once per
    /// press-drag-release cycle. Returns `true` on the move that fired —
    /// an `OnDrag` whose action was inert (a `Back` with no history) did
    /// not fire, so the cycle stays armed and the next move may still.
    pub fn drag_to(&mut self, point: Point) -> bool {
        if !self.dragging || self.drag_fired {
            return false;
        }
        let Some((_, hit)) = self.pick(point) else {
            return false;
        };
        // like `press`: a drag must not forge hover state over an armed
        // "while hovering" span — the next move still leaves the hotspot
        let orphaned = self.hover_span.as_ref().is_some_and(|s| s.hotspot() != hit);
        if !orphaned {
            self.hovered = Some(hit.clone());
        }
        let Some(effect) = self.fire_trigger_effect(&hit, Trigger::OnDrag) else {
            return false;
        };
        if effect.fired() {
            self.drag_fired = true;
            true
        } else {
            false
        }
    }

    /// Release the pointer over `point`: ends drag detection, reverts an
    /// armed "while pressing" span, then fires `MouseUp` on the node
    /// under the release point (Figma's drop-down pattern: the press
    /// opens the menu, the release selects the item). Returns `true`
    /// when anything fired or reverted.
    pub fn release(&mut self, point: Point) -> bool {
        self.dragging = false;
        let mut out = self.release_press_span();
        if let Some((_, hit)) = self.pick(point) {
            out |= self.fire_trigger(&hit, Trigger::MouseUp);
        }
        out
    }

    /// Deliver `key` to the player: the first `KeyDown` interaction whose
    /// key matches fires (topmost overlay first, then the current frame —
    /// [`find_key_interaction`] order within each). Returns transition ms
    /// when something fired.
    pub fn key(&mut self, key: &str) -> Option<u32> {
        if let Some(ix) = self.find_key(key) {
            let effect = self.fire(&ix);
            return effect.fired().then_some(ix.transition_ms);
        }
        None
    }

    /// First `KeyDown` interaction matching `key`, topmost overlay
    /// first, then the current frame. `&self` search feeding `key`'s
    /// `&mut self` firing (see `find_trigger`).
    fn find_key(&self, key: &str) -> Option<Interaction> {
        for ov in self.overlays.iter().rev() {
            let found = find(self.doc, &ov.frame).and_then(|n| find_key_interaction(n, key));
            if let Some((_, ix)) = found {
                return Some(ix);
            }
        }
        find(self.doc, &self.current)
            .and_then(|n| find_key_interaction(n, key))
            .map(|(_, ix)| ix)
    }

    /// Advance the logical clock, firing due `AfterDelay` triggers in arm
    /// order. A navigation cancels the remaining due timers and re-arms
    /// for the new screen. Returns how many fired.
    pub fn tick(&mut self, now_ms: u64) -> usize {
        self.now_ms = now_ms;
        let mut fired = 0;
        while let Some(i) = self.delays.iter().position(|d| d.at_ms <= now_ms) {
            let d = self.delays.remove(i);
            if let Some(src) = &d.source_overlay {
                if !self.overlays.iter().any(|o| &o.frame == src) {
                    continue; // its overlay closed: disarmed
                }
            }
            let effect = self.fire(&d.ix);
            if effect.fired() {
                fired += 1;
            }
            if effect.navigated.is_some() {
                break; // fire() re-armed for the new screen; old timers die
            }
        }
        fired
    }

    /// One Esc press: dismiss the top overlay, else step back through
    /// history, else report [`EscOutcome::Exit`] (hosts leave the player).
    pub fn escape(&mut self) -> EscOutcome {
        if self.overlays.pop().is_some() {
            return EscOutcome::Dismissed;
        }
        if self.back() {
            return EscOutcome::Back;
        }
        EscOutcome::Exit
    }

    pub fn back(&mut self) -> bool {
        if let Some(prev) = self.stack.pop() {
            self.current = prev;
            self.overlays.clear();
            self.hovered = None;
            self.arm_delays();
            true
        } else {
            false
        }
    }
}

// ------------------------------------------------------------ smart animate

/// Phase 8.3: smart animate. Given two frames, nodes with MATCHING IDS are
/// interpolated (position, size, rotation, opacity, solid fill color) at
/// progress `t` in [0,1]; the result is a renderable in-between frame.
/// Nodes only present in `to` fade in; nodes only in `from` fade out —
/// the same matching rule comparable tools use.
pub fn smart_animate(from: &Node, to: &Node, t: f64) -> Node {
    let t = t.clamp(0.0, 1.0);
    let mut frame = to.clone();
    frame.id = format!("{}~{}@{t:.3}", from.id, to.id);

    fn collect<'n>(n: &'n Node, map: &mut std::collections::HashMap<String, &'n Node>) {
        map.insert(n.id.clone(), n);
        for c in &n.children {
            collect(c, map);
        }
    }
    let mut from_map = std::collections::HashMap::new();
    for c in &from.children {
        collect(c, &mut from_map);
    }

    fn lerp(a: f64, b: f64, t: f64) -> f64 {
        a + (b - a) * t
    }
    fn lerp_color(a: Color, b: Color, t: f64) -> Color {
        // components are linear f32 rgba; interpolate per channel
        let lerp = |x: f32, y: f32| (x as f64 + (y as f64 - x as f64) * t) as f32;
        Color::new([
            lerp(a.components[0], b.components[0]),
            lerp(a.components[1], b.components[1]),
            lerp(a.components[2], b.components[2]),
            lerp(a.components[3], b.components[3]),
        ])
    }

    fn blend_tree(node: &mut Node, from_map: &std::collections::HashMap<String, &Node>, t: f64) {
        if let Some(src) = from_map.get(&node.id) {
            node.transform.x = lerp(src.transform.x, node.transform.x, t);
            node.transform.y = lerp(src.transform.y, node.transform.y, t);
            node.transform.rotation = lerp(src.transform.rotation, node.transform.rotation, t);
            node.w = lerp(src.w, node.w, t);
            node.h = lerp(src.h, node.h, t);
            node.opacity = lerp(src.opacity as f64, node.opacity as f64, t) as f32;
            if let (Paint::Solid(a), Paint::Solid(b)) = (&src.fill, &node.fill.clone()) {
                node.fill = Paint::Solid(lerp_color(*a, *b, t));
            }
        } else {
            // new in `to`: fade in
            node.opacity = (node.opacity as f64 * t) as f32;
        }
        for c in &mut node.children {
            blend_tree(c, from_map, t);
        }
    }
    for c in &mut frame.children {
        blend_tree(c, &from_map, t);
    }

    // nodes that existed in `from` but not in `to`: fade OUT (append ghosts)
    let mut to_ids = std::collections::HashSet::new();
    fn ids(n: &Node, set: &mut std::collections::HashSet<String>) {
        set.insert(n.id.clone());
        for c in &n.children {
            ids(c, set);
        }
    }
    for c in &to.children {
        ids(c, &mut to_ids);
    }
    for c in &from.children {
        if !to_ids.contains(&c.id) {
            let mut ghost = c.clone();
            ghost.opacity = (ghost.opacity as f64 * (1.0 - t)) as f32;
            frame.children.push(ghost);
        }
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two screens plus a dialog: `home` holds the click/hover/press/
    /// drag/overlay buttons, `detail` holds the delay, while-pressing,
    /// and mouse-up buttons, `dlg` is overlay content. Buttons are
    /// 60x30 rects at y=20, x=10/90/170/250/330.
    fn player_doc() -> Node {
        fn btn(id: &str, x: f64, ix: Interaction) -> Node {
            Node::rect(id, x, 20.0, 60.0, 30.0, Color::WHITE).interaction(ix)
        }
        let click = |dest: &str| Interaction::click(dest);
        let home = Node::frame("home", 400.0, 300.0)
            .child(btn("go", 10.0, click("detail")))
            .child(btn(
                "hov",
                90.0,
                Interaction {
                    trigger: Trigger::OnHover,
                    action: Action::Navigate {
                        destination: "detail".into(),
                    },
                    transition_ms: 0,
                    animation: Animation::Instant,
                    actions: vec![],
                    easing: Easing::Linear,
                    reset_on_navigate: false,
                },
            ))
            .child(btn(
                "prs",
                170.0,
                Interaction {
                    trigger: Trigger::OnPress,
                    action: Action::SetVar {
                        name: "taps".into(),
                        value: Expr::Add(Box::new(Expr::var("taps")), Box::new(Expr::num(1.0))),
                    },
                    transition_ms: 0,
                    animation: Animation::Instant,
                    actions: vec![],
                    easing: Easing::Linear,
                    reset_on_navigate: false,
                },
            ))
            .child(btn(
                "drg",
                250.0,
                Interaction {
                    trigger: Trigger::OnDrag,
                    action: Action::Back,
                    transition_ms: 0,
                    animation: Animation::Instant,
                    actions: vec![],
                    easing: Easing::Linear,
                    reset_on_navigate: false,
                },
            ))
            .child(btn(
                "ovl",
                330.0,
                Interaction {
                    trigger: Trigger::OnClick,
                    action: Action::OpenOverlay {
                        overlay: "dlg".into(),
                        position: OverlayPosition::Center,
                    },
                    transition_ms: 120,
                    animation: Animation::Dissolve,
                    actions: vec![],
                    easing: Easing::Linear,
                    reset_on_navigate: false,
                },
            ));
        let detail = Node::frame("detail", 400.0, 300.0)
            .child(btn(
                "later",
                10.0,
                Interaction {
                    trigger: Trigger::AfterDelay { ms: 500 },
                    action: Action::Back,
                    transition_ms: 0,
                    animation: Animation::Instant,
                    actions: vec![],
                    easing: Easing::Linear,
                    reset_on_navigate: false,
                },
            ))
            .child(btn(
                "hold",
                90.0,
                Interaction {
                    trigger: Trigger::OnPress,
                    action: Action::Navigate {
                        destination: "home".into(),
                    },
                    transition_ms: 0,
                    animation: Animation::Instant,
                    actions: vec![],
                    easing: Easing::Linear,
                    reset_on_navigate: false,
                },
            ))
            .child(btn(
                "up",
                170.0,
                Interaction {
                    trigger: Trigger::MouseUp,
                    action: Action::SetVar {
                        name: "n".into(),
                        value: Expr::num(99.0),
                    },
                    transition_ms: 0,
                    animation: Animation::Instant,
                    actions: vec![],
                    easing: Easing::Linear,
                    reset_on_navigate: false,
                },
            ));
        let mut dlg = Node::frame("dlg", 160.0, 100.0).child(btn(
            "shut",
            10.0,
            Interaction {
                trigger: Trigger::OnClick,
                action: Action::CloseOverlay,
                transition_ms: 0,
                animation: Animation::Instant,
                actions: vec![],
                easing: Easing::Linear,
                reset_on_navigate: false,
            },
        ));
        // authored far from home: overlay hit-testing must use the RENDERED
        // (anchored) position, never this one
        dlg.transform.x = 600.0;
        Node::frame("root", 1000.0, 600.0)
            .child(home)
            .child(detail)
            .child(dlg)
    }

    fn known(id: &str) -> bool {
        matches!(id, "a" | "b" | "dlg" | "dlg2")
    }

    #[test]
    fn engine_routes_all_ten_actions() {
        let mut current = "a".to_string();
        let mut stack = vec!["z".to_string()];
        let mut overlays = vec![];
        let mut vars = Variables::default();
        vars.numbers.insert("n".into(), 1.0);

        // SetVar + Cond run against the preview store, no navigation
        let e = fire_action(
            &mut current,
            &mut stack,
            &mut overlays,
            &mut vars,
            &known,
            &Action::SetVar {
                name: "n".into(),
                value: Expr::num(41.0),
            },
            100,
        );
        assert!(e.vars_changed);
        assert_eq!(vars.numbers["n"], 41.0);
        assert!(e.navigated.is_none());
        let e = fire_action(
            &mut current,
            &mut stack,
            &mut overlays,
            &mut vars,
            &known,
            &Action::Cond {
                cond: Condition {
                    lhs: Expr::var("n"),
                    op: CondOp::Gt,
                    rhs: Expr::num(40.0),
                },
                then: Box::new(Action::Navigate {
                    destination: "b".into(),
                }),
                els: None,
            },
            100,
        );
        assert_eq!(e.navigated.as_deref(), Some("b"));
        assert_eq!(current, "b");
        assert_eq!(stack, vec!["z", "a"]);

        // unknown destinations are refused, not half-applied
        let e = fire_action(
            &mut current,
            &mut stack,
            &mut overlays,
            &mut vars,
            &known,
            &Action::Navigate {
                destination: "nope".into(),
            },
            100,
        );
        assert!(!e.fired());
        assert_eq!(current, "b");

        // overlay stack: open / swap / close
        let e = fire_action(
            &mut current,
            &mut stack,
            &mut overlays,
            &mut vars,
            &known,
            &Action::OpenOverlay {
                overlay: "dlg".into(),
                position: OverlayPosition::TopRight,
            },
            100,
        );
        assert!(e.overlays_changed && e.navigated.is_none());
        assert_eq!(overlays.len(), 1);
        assert_eq!(overlays[0].position, OverlayPosition::TopRight);
        let e = fire_action(
            &mut current,
            &mut stack,
            &mut overlays,
            &mut vars,
            &known,
            &Action::SwapOverlay {
                overlay: "dlg2".into(),
            },
            100,
        );
        assert!(e.overlays_changed);
        assert_eq!(overlays.len(), 1);
        assert_eq!(overlays[0].frame, "dlg2");
        // swap keeps the anchor position
        assert_eq!(overlays[0].position, OverlayPosition::TopRight);
        let e = fire_action(
            &mut current,
            &mut stack,
            &mut overlays,
            &mut vars,
            &known,
            &Action::CloseOverlay,
            100,
        );
        assert!(e.overlays_changed);
        assert!(overlays.is_empty());
        let e = fire_action(
            &mut current,
            &mut stack,
            &mut overlays,
            &mut vars,
            &known,
            &Action::CloseOverlay,
            100,
        );
        assert!(!e.fired(), "closing nothing is a no-op");

        // swap from a bare frame navigates WITHOUT pushing history, so
        // Back skips it: current moves, the stack does not grow
        let e = fire_action(
            &mut current,
            &mut stack,
            &mut overlays,
            &mut vars,
            &known,
            &Action::SwapOverlay {
                overlay: "dlg".into(),
            },
            100,
        );
        assert_eq!(e.navigated.as_deref(), Some("dlg"));
        assert!(!e.overlays_changed);
        assert_eq!(current, "dlg");
        assert_eq!(stack, vec!["z", "a"]);

        // Back pops history and clears overlays
        let _ = fire_action(
            &mut current,
            &mut stack,
            &mut overlays,
            &mut vars,
            &known,
            &Action::OpenOverlay {
                overlay: "dlg".into(),
                position: OverlayPosition::Center,
            },
            100,
        );
        let e = fire_action(
            &mut current,
            &mut stack,
            &mut overlays,
            &mut vars,
            &known,
            &Action::Back,
            100,
        );
        assert_eq!(e.navigated.as_deref(), Some("a"));
        assert!(e.overlays_changed && overlays.is_empty());

        // open-link only reports the URL: no screen, stack, or overlay
        // changes — the host hands it to the system browser
        let e = fire_action(
            &mut current,
            &mut stack,
            &mut overlays,
            &mut vars,
            &known,
            &Action::OpenLink {
                url: "https://example.com".into(),
            },
            100,
        );
        assert_eq!(e.opened_link.as_deref(), Some("https://example.com"));
        assert!(e.fired());
        assert!(e.navigated.is_none() && !e.overlays_changed);
        assert_eq!(current, "a");
        assert_eq!(stack, vec!["z"]);
    }

    #[test]
    fn engine_setmode_and_scrollto() {
        let mut current = "a".to_string();
        let mut stack = vec![];
        let mut overlays = vec![];
        let mut vars = Variables::default();
        vars.modes.insert("dark".into(), Default::default());
        let known = |id: &str| id == "a" || id == "b";
        let e = fire_action(
            &mut current,
            &mut stack,
            &mut overlays,
            &mut vars,
            &known,
            &Action::SetMode {
                mode: "dark".into(),
            },
            0,
        );
        assert!(e.vars_changed && e.navigated.is_none());
        assert_eq!(vars.active_mode.as_deref(), Some("dark"));
        let e = fire_action(
            &mut current,
            &mut stack,
            &mut overlays,
            &mut vars,
            &known,
            &Action::ScrollTo {
                destination: "b".into(),
            },
            50,
        );
        // scroll-to pans within the screen: no navigation, no history,
        // no overlay changes — the host moves the viewport instead
        assert_eq!(e.scrolled_to.as_deref(), Some("b"));
        assert!(e.fired());
        assert!(e.navigated.is_none() && !e.overlays_changed);
        assert_eq!(e.transition_ms, 50);
        assert_eq!(current, "a");
        assert!(stack.is_empty());
    }

    #[test]
    fn player_hover_press_drag_key() {
        let root = player_doc();
        let mut p = Player::new(&root, "home");
        // home body binds nothing: entering it fires nothing, and staying
        // on the same node takes the early-out
        assert!(!p.hover(Point::new(5.0, 5.0)));
        assert!(!p.hover(Point::new(5.0, 5.0)));
        // hover the "hov" button (90..150, 20..50): navigates on enter
        assert!(p.hover(Point::new(120.0, 35.0)));
        assert_eq!(p.current, "detail");
        p.enter("home");
        // press "prs" (170..230): counts a tap in the preview store
        assert!(p.press(Point::new(200.0, 35.0)));
        assert_eq!(p.vars.numbers.get("taps"), Some(&1.0));
        p.release(Point::new(200.0, 35.0));
        // drag starting on "drg" fires Back once per press-drag cycle
        p.stack.push("detail".into());
        p.press(Point::new(280.0, 35.0));
        assert!(p.drag_to(Point::new(285.0, 40.0)));
        assert_eq!(p.current, "detail");
        assert!(!p.drag_to(Point::new(290.0, 45.0)), "fires once per drag");
        p.release(Point::new(290.0, 45.0));
        p.enter("home");
        p.press(Point::new(280.0, 35.0));
        assert!(!p.drag_to(Point::new(285.0, 40.0)), "stack empty: no-op");
        p.release(Point::new(285.0, 40.0));
        // no key trigger is bound in this doc
        assert_eq!(p.key("a"), None);
    }

    /// Figma's Mouse down is the press itself: permanent and one-way, where
    /// While pressing arms the release that unwinds it (help 360040315773).
    /// The player fires it from `press`, beside `OnPress`; `release` leaves it
    /// standing.
    #[test]
    fn player_mouse_down_navigates_on_press_and_release_keeps_it() {
        let mut md = Node::rect("md", 10.0, 20.0, 60.0, 30.0, Color::WHITE);
        md.interactions = vec![Interaction {
            trigger: Trigger::MouseDown,
            action: Action::Navigate {
                destination: "detail".into(),
            },
            transition_ms: 0,
            animation: Animation::Instant,
            actions: vec![],
            easing: Easing::Linear,
            reset_on_navigate: false,
        }];
        let root = Node::frame("root", 1000.0, 600.0)
            .child(Node::frame("home", 400.0, 300.0).child(md))
            .child(Node::frame("detail", 400.0, 300.0));
        let mut p = Player::new(&root, "home");
        assert!(p.press(Point::new(30.0, 35.0)), "Mouse down fires");
        assert_eq!(p.current, "detail");
        p.release(Point::new(30.0, 35.0));
        assert_eq!(p.current, "detail", "the release keeps it");
    }

    #[test]
    fn player_hover_navigate_autoreverses_on_leave() {
        let root = player_doc();
        let mut p = Player::new(&root, "home");
        // hover "hov": while-hovering navigates to detail, no history yet
        assert!(p.hover(Point::new(120.0, 35.0)));
        assert_eq!(p.current, "detail");
        // moving anywhere — even empty canvas — leaves the hotspot and
        // returns to home WITHOUT pushing history
        assert!(p.hover(Point::new(5.0, 5.0)));
        assert_eq!(p.current, "home");
        assert!(p.stack.is_empty());
    }

    #[test]
    fn player_hover_overlay_autoreverses_on_leave() {
        let screen = Node::frame("screen", 400.0, 300.0).child(
            Node::rect("tip", 10.0, 20.0, 60.0, 30.0, Color::WHITE).interaction(Interaction {
                trigger: Trigger::OnHover,
                action: Action::OpenOverlay {
                    overlay: "dlg".into(),
                    position: OverlayPosition::Center,
                },
                transition_ms: 0,
                animation: Animation::Instant,
                actions: vec![],
                easing: Easing::Linear,
                reset_on_navigate: false,
            }),
        );
        let root = Node::frame("root", 1000.0, 600.0)
            .child(screen)
            .child(Node::frame("dlg", 160.0, 100.0));
        let mut p = Player::new(&root, "screen");
        assert!(p.hover(Point::new(40.0, 35.0)));
        assert_eq!(p.overlays.len(), 1);
        // moving off the hotspot closes the hovered overlay again
        assert!(p.hover(Point::new(350.0, 250.0)));
        assert!(p.overlays.is_empty());
    }

    #[test]
    fn player_press_autoreverses_and_mouseup_fires() {
        let root = player_doc();
        let mut p = Player::new(&root, "home");
        p.click(Point::new(40.0, 35.0)); // go -> detail
        assert_eq!(p.current, "detail");
        // press "hold" (90..150): while-pressing navigates home
        assert!(p.press(Point::new(120.0, 35.0)));
        assert_eq!(p.current, "home");
        // release anywhere: the press span reverts to detail, popping
        // only its own push — the earlier click's history survives
        assert!(p.release(Point::new(5.0, 5.0)));
        assert_eq!(p.current, "detail");
        assert_eq!(p.stack, vec!["home"]);
        // release over "up" (170..230): MouseUp sets n in preview vars
        assert!(p.release(Point::new(200.0, 35.0)));
        assert_eq!(p.vars.numbers.get("n"), Some(&99.0));
    }

    #[test]
    fn player_delay_fires_and_navigation_cancels() {
        let root = player_doc();
        let mut p = Player::new(&root, "home");
        p.click(Point::new(40.0, 35.0)); // go -> detail
        assert_eq!(p.current, "detail");
        assert_eq!(p.delays.len(), 1, "detail arms one delay");
        assert_eq!(p.tick(499), 0, "not yet due");
        assert_eq!(p.tick(500), 1, "AfterDelay(500) fires Back");
        assert_eq!(p.current, "home");
        // navigating away cancels pending timers: re-enter detail, leave
        // before the deadline, come back — the stale timer is gone
        p.click(Point::new(40.0, 35.0));
        p.back();
        assert!(p.delays.is_empty(), "home arms nothing");
        p.click(Point::new(40.0, 35.0));
        assert_eq!(p.tick(10_000), 1);
    }

    #[test]
    fn player_overlays_route_clicks_and_escape_dismisses() {
        let root = player_doc();
        let mut p = Player::new(&root, "home");
        // open the centered dialog (home is 400x300, dlg 160x100 → centered
        // at (120, 100) in home-local coords; home sits at root origin)
        assert_eq!(p.click(Point::new(360.0, 35.0)), Some(120));
        assert_eq!(p.overlays.len(), 1);
        // click the dialog's "shut" button (dlg-local (10,20)-(70,50) →
        // world (130,120)-(190,150)): closes the overlay, stays home
        assert!(p.click(Point::new(140.0, 130.0)).is_some());
        assert!(p.overlays.is_empty());
        assert_eq!(p.current, "home");
        // clicks pass through to the base frame once closed
        assert_eq!(p.click(Point::new(40.0, 35.0)), Some(350));
        assert_eq!(p.current, "detail");
    }

    #[test]
    fn player_escape_order_is_dismiss_then_back_then_exit() {
        let root = player_doc();
        let mut p = Player::new(&root, "home");
        assert_eq!(p.escape(), EscOutcome::Exit, "nothing to dismiss or pop");
        p.overlays.push(Overlay {
            frame: "dlg".into(),
            position: OverlayPosition::Center,
        });
        p.stack.push("detail".into());
        assert_eq!(p.escape(), EscOutcome::Dismissed);
        assert!(p.overlays.is_empty());
        assert_eq!(p.escape(), EscOutcome::Back);
        assert_eq!(p.current, "detail");
        assert_eq!(p.escape(), EscOutcome::Exit);
    }

    #[test]
    fn overlay_hit_testing_uses_rendered_position() {
        let root = player_doc();
        // the dialog is authored at x=600 but renders centered over home:
        // its authored rect must NOT hit, its rendered rect must
        assert!(hit_overlay(&root, "home", &[], Point::new(620.0, 40.0)).is_none());
        let overlays = vec![Overlay {
            frame: "dlg".into(),
            position: OverlayPosition::Center,
        }];
        assert!(hit_overlay(&root, "home", &overlays, Point::new(620.0, 40.0)).is_none());
        let hit = hit_overlay(&root, "home", &overlays, Point::new(140.0, 130.0));
        assert_eq!(
            hit,
            Some(("dlg".to_string(), "shut".to_string())),
            "rendered at home-center (120,100)"
        );
        // top-right anchor: (400-160, 0) = (240, 0), so "shut" renders
        // at (250,20)-(310,50)
        let overlays = vec![Overlay {
            frame: "dlg".into(),
            position: OverlayPosition::TopRight,
        }];
        let hit = hit_overlay(&root, "home", &overlays, Point::new(260.0, 35.0));
        assert_eq!(hit, Some(("dlg".to_string(), "shut".to_string())));
    }

    #[test]
    fn world_origin_accumulates_frame_offsets() {
        let root = player_doc();
        assert_eq!(world_origin(&root, "home"), Some(Point::new(0.0, 0.0)));
        assert_eq!(world_origin(&root, "go"), Some(Point::new(10.0, 20.0)));
        assert!(world_origin(&root, "missing").is_none());
    }
}
