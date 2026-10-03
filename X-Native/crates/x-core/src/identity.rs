//! Opaque identities: unrelated to display names or the number of live nodes.
//! An epoch/process prefix prevents normal cross-session reuse; the monotonic
//! sequence also makes allocation safe across threads. Not a security token.
use std::sync::{
    atomic::{AtomicU64, Ordering},
    OnceLock,
};

pub fn fresh_id(prefix: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    static EPOCH: OnceLock<u128> = OnceLock::new();
    let epoch = EPOCH.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    });
    format!(
        "{prefix}-{epoch:x}-{:x}-{:x}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// Allocate identities for a whole forest carrier, then remap internal node
/// references. Display names are not identities and are deliberately untouched.
pub fn remap_node_ids(
    root: &mut crate::Node,
    mut allocate: impl FnMut(&str) -> String,
) -> std::collections::HashMap<String, String> {
    use std::collections::HashMap;
    fn ids(
        n: &mut crate::Node,
        allocate: &mut impl FnMut(&str) -> String,
        map: &mut HashMap<String, String>,
    ) {
        let old = std::mem::take(&mut n.id);
        n.id = allocate(&old);
        map.insert(old, n.id.clone());
        for c in &mut n.children {
            ids(c, allocate, map);
        }
    }
    fn reference(value: &mut String, map: &HashMap<String, String>) {
        if let Some(v) = map.get(value) {
            *value = v.clone();
        }
    }
    fn action(a: &mut crate::prototype::Action, map: &HashMap<String, String>) {
        use crate::prototype::Action::*;
        match a {
            Navigate { destination } | ScrollTo { destination } => reference(destination, map),
            OpenOverlay { overlay, .. } | SwapOverlay { overlay } => reference(overlay, map),
            Cond { then, els, .. } => {
                action(then, map);
                if let Some(e) = els {
                    action(e, map);
                }
            }
            _ => {}
        }
    }
    fn refs(n: &mut crate::Node, map: &HashMap<String, String>) {
        if let Some(p) = &mut n.prototype {
            reference(&mut p.destination, map);
        }
        for i in &mut n.interactions {
            action(&mut i.action, map);
        }
        for prop in &mut n.props {
            use crate::ComponentProp::*;
            let target = match prop {
                Text { target, .. }
                | Bool { target, .. }
                | Swap { target, .. }
                | Number { target, .. }
                | Color { target, .. }
                | Slot { target, .. } => target,
            };
            reference(target, map);
        }
        n.overrides = std::mem::take(&mut n.overrides)
            .into_iter()
            .map(|(mut k, v)| {
                reference(&mut k, map);
                (k, v)
            })
            .collect();
        for c in &mut n.children {
            refs(c, map);
        }
    }
    let mut map = HashMap::new();
    ids(root, &mut allocate, &mut map);
    refs(root, &map);
    map
}

#[cfg(test)]
mod tests {
    #[test]
    fn allocations_do_not_depend_on_deleted_objects() {
        let ids: std::collections::HashSet<_> =
            (0..10000).map(|_| super::fresh_id("node")).collect();
        assert_eq!(ids.len(), 10000);
    }
}
