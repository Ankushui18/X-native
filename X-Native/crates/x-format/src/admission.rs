//! Product-owned input budgets, independent of untrusted file metadata.
use std::{collections::HashSet, io::Read, path::Path};
use x_core::document::LegacyStyle;
use x_core::*;
pub const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_NODES: usize = 100_000;
const MAX_COORDINATE: f64 = 1_000_000_000.0;

pub fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    crate::cancellation::checkpoint()?;
    if !std::fs::metadata(path)
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err("only regular files can be opened".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    // O_NONBLOCK prevents a metadata/open race from hanging on a swapped FIFO.
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("only regular files can be opened".into());
    }
    if meta.len() > MAX_INPUT_BYTES as u64 {
        return Err("file exceeds the 64 MiB input budget".into());
    }
    let mut bytes = Vec::with_capacity((meta.len() as usize).min(MAX_INPUT_BYTES));
    let mut buffer = [0u8; 64 * 1024];
    loop {
        crate::cancellation::checkpoint()?;
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        if bytes.len().saturating_add(count) > MAX_INPUT_BYTES {
            return Err("file grew beyond input budget".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok(bytes)
}
/// Ensure our output fits the exact parser budgets before replacing a file.
pub fn validate_encoded(text: &str) -> Result<(), String> {
    crate::json::parse(text).map(|_| ())
}

fn numbers(values: &[f64]) -> Result<(), String> {
    if values
        .iter()
        .any(|v| !v.is_finite() || v.abs() > MAX_COORDINATE)
    {
        Err("non-finite/out-of-range numeric property".into())
    } else {
        Ok(())
    }
}
fn alpha(a: f32) -> Result<(), String> {
    if a.is_finite() && (0.0..=1.0).contains(&a) {
        Ok(())
    } else {
        Err("invalid opacity".into())
    }
}
fn color(c: &Color) -> Result<(), String> {
    if c.components.iter().any(|c| !c.is_finite()) {
        Err("non-finite color".into())
    } else {
        Ok(())
    }
}
fn paint(p: &Paint) -> Result<(), String> {
    let stops = match p {
        Paint::Solid(c) => {
            return color(c);
        }
        Paint::Variable(_) | Paint::Pattern { .. } => return Ok(()),
        Paint::LinearGradient {
            start, end, stops, ..
        } => {
            numbers(&[start.0, start.1, end.0, end.1])?;
            stops
        }
        Paint::RadialGradient {
            center,
            radius,
            stops,
            ..
        } => {
            numbers(&[center.0, center.1, *radius])?;
            if *radius < 0.0 {
                return Err("negative gradient radius".into());
            }
            stops
        }
        Paint::AngularGradient {
            center,
            start_angle,
            end_angle,
            stops,
            ..
        } => {
            numbers(&[center.0, center.1, *start_angle, *end_angle])?;
            stops
        }
        Paint::DiamondGradient {
            center,
            width,
            height,
            stops,
            ..
        } => {
            numbers(&[center.0, center.1, *width, *height])?;
            if *width < 0.0 || *height < 0.0 {
                return Err("negative diamond gradient radius".into());
            }
            stops
        }
    };
    if stops.len() > 1024 {
        return Err("gradient stop budget exceeded".into());
    }
    for (t, c) in stops {
        alpha(*t)?;
        color(c)?;
    }
    Ok(())
}
fn effect(e: &Effect) -> Result<(), String> {
    match e {
        Effect::DropShadow {
            dx,
            dy,
            blur,
            color: c,
        }
        | Effect::InnerShadow {
            dx,
            dy,
            blur,
            color: c,
        } => {
            numbers(&[*dx, *dy, *blur])?;
            color(c)?;
            if *blur < 0.0 {
                return Err("negative blur".into());
            }
        }
        Effect::LayerBlur { radius } | Effect::BackgroundBlur { radius } => {
            numbers(&[*radius])?;
            if *radius < 0.0 {
                return Err("negative blur".into());
            }
        }
        Effect::Noise { amount, .. } => {
            if *amount < 0.0 || *amount > 1.0 {
                return Err("noise amount must be between 0.0 and 1.0".into());
            }
        }
    }
    Ok(())
}
fn layout(l: &AutoLayout) -> Result<(), String> {
    numbers(&l.padding)?;
    numbers(&[l.gap])?;
    for n in [l.min_width, l.max_width, l.min_height, l.max_height]
        .into_iter()
        .flatten()
    {
        numbers(&[n])?;
    }
    if let Some(g) = &l.grid {
        if g.rows.len() + g.columns.len() > 1024 {
            return Err("grid track budget exceeded".into());
        }
        numbers(&g.padding)?;
        numbers(&[g.row_gap, g.column_gap])?;
        for track in g.rows.iter().chain(&g.columns) {
            if let GridTrack::Fixed(v) | GridTrack::Fr(v) = track {
                numbers(&[*v])?;
                if *v < 0.0 {
                    return Err("negative grid track".into());
                }
            }
        }
    }
    Ok(())
}

/// Geometry/identity admission is separate from the advisory reference
/// validator: inline typography literals are legitimate binding values.
pub fn validate_admission(doc: &Document) -> Result<(), String> {
    crate::cancellation::checkpoint()?;
    let mut count = 0usize;
    let mut cost = 0usize;
    let mut page_ids = HashSet::new();
    let mut trees: Vec<&Node> = doc.pages.iter().collect();
    for page in &doc.pages {
        if !page_ids.insert(&page.id) {
            return Err("duplicate page id".into());
        }
    }
    for library in doc.library_snapshots.values() {
        trees.extend(&library.components);
    }
    for root in trees {
        let mut seen = HashSet::new();
        let mut stack = vec![(root, 0usize, Affine::IDENTITY)];
        while let Some((n, depth, parent)) = stack.pop() {
            count += 1;
            if count.is_multiple_of(256) {
                crate::cancellation::checkpoint()?;
            }
            if count > MAX_NODES || depth > 256 {
                return Err("document exceeds node/depth budget".into());
            }
            if n.id.is_empty() || !seen.insert(&n.id) {
                return Err(format!("duplicate/empty node id: {}", n.id));
            }
            if n.id.len() > 1024
                || n.name.len() > 1024
                || n.bindings
                    .iter()
                    .any(|(k, v)| k.len() > 1024 || v.len() > 4096)
            {
                return Err("node metadata string budget exceeded".into());
            }
            let t = n.transform;
            numbers(&[
                n.w, n.h, t.x, t.y, t.rotation, t.scale_x, t.scale_y, t.skew_x, t.skew_y,
                t.origin_x, t.origin_y, n.scroll.0, n.scroll.1,
            ])?;
            if n.w < 0.0 || n.h < 0.0 {
                return Err("negative node size".into());
            }
            alpha(n.opacity)?;
            let world = parent * t.matrix(n.w, n.h);
            if world
                .as_coeffs()
                .iter()
                .any(|v| !v.is_finite() || v.abs() > 1e12)
            {
                return Err("composed transform exceeds world-coordinate budget".into());
            }
            if let Some(radii) = &n.corner_radii {
                numbers(radii)?;
            }
            numbers(&[n.constraints.grow, n.constraints.shrink])?;
            if let Some(n) = n.constraints.basis {
                numbers(&[n])?;
            }
            if n.constraints.grid_col.unwrap_or(0) > 1024
                || n.constraints.grid_row.unwrap_or(0) > MAX_NODES
                || n.constraints.grid_col_span > 1024
                || n.constraints.grid_row_span > MAX_NODES
            {
                return Err("grid placement budget exceeded".into());
            }
            if let Some(baseline) = n.baseline {
                numbers(&[baseline])?;
            }
            for key in [
                "fs", "ls", "lh", "lh_value", "lhv", "fw", "opsz", "wdth", "ws", "ps", "bs",
            ] {
                if let Some(value) = n.bindings.get(key).and_then(|s| s.parse::<f64>().ok()) {
                    numbers(&[value])?;
                }
            }
            for run in &n.text_runs {
                if run.start > 10_000
                    || run.len > 10_000
                    || run.start.checked_add(run.len).is_none()
                    || run.font.as_ref().is_some_and(|s| s.len() > 1024)
                {
                    return Err("text range/font budget exceeded".into());
                }
                for v in [run.size, run.ls].into_iter().flatten() {
                    numbers(&[v])?;
                }
                if let Some(c) = &run.color {
                    color(c)?;
                }
            }
            let units = match &n.kind {
                NodeKind::Text { text } => {
                    let len = text.chars().count();
                    if len > 10_000 {
                        return Err("text node exceeds 10,000-character budget".into());
                    }
                    len.max(1)
                }
                NodeKind::Vector { path } => {
                    for p in path {
                        match p {
                            PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => numbers(&[*x, *y])?,
                            PathCmd::CurveTo(a, b, c, d, e, f) => {
                                numbers(&[*a, *b, *c, *d, *e, *f])?
                            }
                            PathCmd::Close => {}
                        }
                    }
                    path.len().max(1)
                }
                NodeKind::Frame { layout: Some(l) } => {
                    layout(l)?;
                    if let Some(g) = &l.grid {
                        let cols = g.columns.len().max(1);
                        let rows = n
                            .children
                            .iter()
                            .map(|c| {
                                c.constraints
                                    .grid_row
                                    .unwrap_or(0)
                                    .saturating_add(c.constraints.grid_row_span)
                            })
                            .max()
                            .unwrap_or(1)
                            .max(g.rows.len())
                            .max(n.children.len().div_ceil(cols));
                        rows.saturating_mul(cols).max(1)
                    } else {
                        1
                    }
                }
                NodeKind::Rect { radius } => {
                    numbers(&[*radius])?;
                    1
                }
                NodeKind::Arc { start, end } => {
                    numbers(&[*start, *end])?;
                    1
                }
                NodeKind::Image {
                    placement,
                    asset,
                    fit,
                } => {
                    if asset.len() > 2048 {
                        return Err("image reference string budget exceeded".into());
                    }
                    numbers(&[placement.scale, placement.focal.0, placement.focal.1])?;
                    if *fit == ImageFit::Tile {
                        tile_budget(doc, asset, n.w, n.h, placement.scale)?;
                    }
                    1
                }
                NodeKind::Component { name } | NodeKind::Instance { component: name } => {
                    if name.len() > 1024 {
                        return Err("component name budget exceeded".into());
                    }
                    1
                }
                _ => 1,
            };
            if n.fill_layers.len() + n.stroke_layers.len() + n.effect_layers.len() > 64 {
                return Err("visual stack budget exceeded".into());
            }
            paint(&n.fill)?;
            paint(&n.stroke.paint)?;
            numbers(&[n.stroke.width])?;
            for f in n.active_fills() {
                alpha(f.opacity)?;
                paint(&f.paint)?;
                if let Paint::Pattern {
                    asset,
                    fit: ImageFit::Tile,
                } = &f.paint
                {
                    tile_budget(doc, asset, n.w, n.h, 1.0)?;
                }
            }
            for s in n.active_strokes() {
                alpha(s.opacity)?;
                paint(&s.stroke.paint)?;
                numbers(&[s.stroke.width, s.options.dash_offset, s.options.miter_limit])?;
                numbers(&s.options.dash)?;
                if s.stroke.width < 0.0
                    || s.options.dash.len() > 128
                    || s.options.dash.iter().any(|d| *d < 0.0)
                {
                    return Err("invalid stroke".into());
                }
                if !s.options.dash.is_empty() {
                    let period: f64 = s.options.dash.iter().sum();
                    let perimeter = (n.w + n.h).max(1.0) * 4.0 * units as f64;
                    if period <= 0.0 || perimeter / period * s.options.dash.len() as f64 > 100_000.0
                    {
                        return Err("stroke dash expansion exceeds budget".into());
                    }
                }
            }
            for e in &n.effects {
                effect(e)?;
            }
            for e in n.active_effects() {
                alpha(e.opacity)?;
                effect(&e.effect)?;
            }
            let layers = n.active_fills().len() + n.active_strokes().len();
            cost = cost.saturating_add(
                units
                    .saturating_mul(layers.max(1))
                    .saturating_mul(1 + n.active_effects().len() * 37),
            );
            if cost > 1_000_000 {
                return Err("document exceeds render-complexity budget".into());
            }
            stack.extend(n.children.iter().map(|c| (c, depth + 1, world)));
        }
    }
    for page in &doc.pages {
        component_expansion_budget(page)?;
    }
    let mut asset_bytes = 0usize;
    let mut pixels = 0u64;
    let mut hashes = HashSet::new();
    for store in
        std::iter::once(&doc.assets).chain(doc.library_snapshots.values().map(|l| &l.assets))
    {
        for a in store.iter_sorted() {
            if a.name.len() > 1024 {
                return Err("asset name budget exceeded".into());
            }
            if !hashes.insert(&a.id) {
                continue;
            }
            asset_bytes = asset_bytes.saturating_add(a.bytes.len());
            if let Some((w, h)) = a.dimensions {
                let size = u64::from(w) * u64::from(h);
                if size > 16_777_216 {
                    return Err("image exceeds 16-megapixel budget".into());
                }
                pixels = pixels.saturating_add(size);
            }
        }
    }
    if asset_bytes > 48 * 1024 * 1024 || pixels > 32 * 1024 * 1024 {
        return Err("aggregate asset budget exceeded".into());
    }
    for n in doc
        .variables
        .numbers
        .values()
        .chain(doc.variables.num_modes.values().flat_map(|m| m.values()))
    {
        numbers(&[*n])?;
    }
    for c in doc
        .variables
        .colors
        .values()
        .chain(doc.variables.modes.values().flat_map(|m| m.values()))
    {
        color(c)?;
    }
    for style in doc.styles.values() {
        match style {
            LegacyStyle::Paint { fill } => paint(fill)?,
            LegacyStyle::Text(data) => {
                numbers(&[
                    data.font_size,
                    data.letter_spacing,
                    data.paragraph_spacing,
                    data.paragraph_indent,
                    data.line_height.value(),
                ])?;
                if data.font_family.len() > 1024 {
                    return Err("text style font family budget exceeded".into());
                }
            }
            LegacyStyle::Effect { effects } => {
                for e in effects {
                    effect(e)?;
                }
            }
        }
    }
    let mut comment_ids = HashSet::new();
    for c in &doc.comments {
        if c.text.len() > 40_000 || c.author.len() > 1024 || c.id.len() > 1024 {
            return Err("comment string budget exceeded".into());
        }
        if c.id.is_empty() || !comment_ids.insert(&c.id) || c.page >= doc.pages.len() {
            return Err("invalid comment identity/page".into());
        }
        numbers(&[c.x, c.y])?;
    }
    Ok(())
}
fn tile_budget(doc: &Document, asset: &str, w: f64, h: f64, scale: f64) -> Result<(), String> {
    if let Some((iw, ih)) = doc.assets.get(asset).and_then(|a| a.dimensions) {
        let draws = (w / (f64::from(iw) * scale.max(0.05))).ceil()
            * (h / (f64::from(ih) * scale.max(0.05))).ceil();
        if !draws.is_finite() || draws > 16_384.0 {
            return Err("image tiling exceeds 16,384 draw budget".into());
        }
    }
    Ok(())
}

// Reject recursive component graphs and exponential DAG expansion BEFORE
// the renderer's depth fallback could expand millions of instances.
fn component_expansion_budget(root: &Node) -> Result<(), String> {
    use std::collections::HashMap;
    fn collect<'a>(n: &'a Node, r: &mut HashMap<&'a str, &'a Node>) {
        if let NodeKind::Component { name } = &n.kind {
            r.insert(name, n);
        }
        for c in &n.children {
            collect(c, r);
        }
    }
    fn cost(
        n: &Node,
        registry: &HashMap<&str, &Node>,
        visiting: &mut HashSet<String>,
        memo: &mut HashMap<String, usize>,
        depth: usize,
    ) -> Result<usize, String> {
        if depth > 256 {
            return Err("component expansion depth exceeded".into());
        }
        let mut count = match &n.kind {
            NodeKind::Text { text } => text.chars().count().max(1),
            NodeKind::Vector { path } => path.len().max(1),
            _ => 1,
        };
        for v in n.overrides.values() {
            if v.len() > 40_005 {
                return Err("override string budget exceeded".into());
            }
            if let Some(text) = v.strip_prefix("text:") {
                count += text.chars().count();
            }
        }
        if let NodeKind::Instance { component } = &n.kind {
            if let Some(master) = registry.get(component.as_str()) {
                let expansion = if let Some(count) = memo.get(component) {
                    *count
                } else {
                    if !visiting.insert(component.clone()) {
                        return Err("recursive component reference".into());
                    }
                    let count = cost(master, registry, visiting, memo, depth + 1)?;
                    visiting.remove(component);
                    memo.insert(component.clone(), count);
                    count
                };
                count = count.saturating_add(expansion);
            }
        }
        for child in &n.children {
            count = count.saturating_add(cost(child, registry, visiting, memo, depth + 1)?);
        }
        count = count.saturating_mul(1 + n.active_effects().len() * 37);
        if count > 1_000_000 {
            return Err("component expansion exceeds render budget".into());
        }
        Ok(count)
    }
    let mut registry = HashMap::new();
    collect(root, &mut registry);
    cost(root, &registry, &mut HashSet::new(), &mut HashMap::new(), 0)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_geometry_and_duplicate_ids_are_rejected() {
        let mut d = Document::new();
        d.pages.push(Node::frame("p", f64::INFINITY, 1.0));
        assert!(validate_admission(&d).is_err());
        d.pages[0].w = 100.0;
        d.pages[0].children.push(Node::frame("p", 2.0, 2.0));
        assert!(validate_admission(&d).is_err());
    }
    #[test]
    fn paths_paints_layout_and_composed_transforms_are_checked() {
        let mut d = Document {
            pages: vec![Node::frame("p", 100.0, 100.0)],
            ..Default::default()
        };
        d.pages[0].children.push(Node::vector(
            "v",
            0.0,
            0.0,
            1.0,
            1.0,
            vec![PathCmd::MoveTo(f64::NAN, 0.0)],
        ));
        assert!(validate_admission(&d).is_err());
        d.pages[0].children.clear();
        d.pages[0].transform.scale_x = 1e9;
        let mut c = Node::frame("c", 1.0, 1.0);
        c.transform.scale_x = 1e9;
        d.pages[0].children.push(c);
        assert!(validate_admission(&d).is_err());
    }
}
