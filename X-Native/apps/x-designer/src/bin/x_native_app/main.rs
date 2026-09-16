//! X-Native — native Graphite & Signal workspace. The reference HTML audit
//! supplies density and interaction benchmarks; the shipped shell uses the
//! X-Native Compose → Flow → Ship workflow rather than cloning Figma.

mod board_ui;
mod clipboard;
mod command;
mod context_menu;
mod dashboard;
mod editor_ui;
mod fonts;
mod gpu_target;
mod icons;
mod jobs;
mod loading;
mod paint;
mod run;
mod session;
mod state;
mod text_session;
mod theme;

fn main() {
    run::run();
}
