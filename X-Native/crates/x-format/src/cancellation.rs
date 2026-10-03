//! Cooperative cancellation for background file work. A write's publication
//! barrier is explicit: cancellation either wins BEFORE rename, or reports that
//! the commit is already finishing. It never promises to undo a published file.
use std::{
    cell::RefCell,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
};
const RUNNING: u8 = 0;
const CANCELLED: u8 = 1;
const COMMITTING: u8 = 2;
const COMMITTED: u8 = 3;

#[derive(Clone, Default)]
pub struct Cancellation(Arc<AtomicU8>);
impl Cancellation {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) -> bool {
        match self
            .0
            .compare_exchange(RUNNING, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => true,
            Err(state) => state == CANCELLED,
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire) == CANCELLED
    }
    pub fn can_cancel(&self) -> bool {
        self.0.load(Ordering::Acquire) == RUNNING
    }
    pub fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err("operation cancelled".into())
        } else {
            Ok(())
        }
    }
}
thread_local! { static ACTIVE: RefCell<Option<Cancellation>> = const { RefCell::new(None) }; }
struct Scope(Option<Cancellation>);
impl Drop for Scope {
    fn drop(&mut self) {
        ACTIVE.with(|slot| *slot.borrow_mut() = self.0.take());
    }
}
pub fn with_cancellation<T>(token: &Cancellation, work: impl FnOnce() -> T) -> T {
    let _scope = Scope(ACTIVE.with(|slot| slot.replace(Some(token.clone()))));
    work()
}
pub fn is_cancelled() -> bool {
    ACTIVE.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(Cancellation::is_cancelled)
    })
}
pub fn checkpoint() -> Result<(), String> {
    if is_cancelled() {
        Err("operation cancelled".into())
    } else {
        Ok(())
    }
}

pub(crate) fn commit<T>(work: impl FnOnce() -> std::io::Result<T>) -> std::io::Result<T> {
    let token = ACTIVE.with(|slot| slot.borrow().clone());
    if let Some(token) = &token {
        match token
            .0
            .compare_exchange(RUNNING, COMMITTING, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) | Err(COMMITTED) => {}
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "operation cancelled before file publication",
                ))
            }
        }
    }
    let result = work();
    if let Some(token) = token {
        token.0.store(COMMITTED, Ordering::Release);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelled_scope_is_local_and_nested_scopes_restore_previous_token() {
        let a = Cancellation::new();
        a.cancel();
        let b = Cancellation::new();
        assert!(!is_cancelled());
        with_cancellation(&a, || {
            assert!(is_cancelled());
            with_cancellation(&b, || assert!(!is_cancelled()));
            assert!(is_cancelled());
        });
        assert!(!is_cancelled());
    }
    #[test]
    fn publication_has_an_unambiguous_cancellation_boundary() {
        let token = Cancellation::new();
        with_cancellation(&token, || {
            commit(|| {
                assert!(!token.cancel());
                Ok(())
            })
        })
        .unwrap();
        assert!(!token.cancel());
        let token = Cancellation::new();
        assert!(token.cancel());
        assert!(
            with_cancellation(&token, || commit(|| -> std::io::Result<()> {
                panic!("must not publish")
            }))
            .is_err()
        );
    }
}

#[cfg(test)]
mod parser_tests {
    use super::*;
    #[test]
    fn cancellation_reaches_parser_svg_and_file_publication() {
        let token = Cancellation::new();
        token.cancel();
        let p = std::env::temp_dir().join(format!("{}-cancelled.x", x_core::fresh_id("job")));
        std::fs::write(&p, b"keep").unwrap();
        with_cancellation(&token, || {
            assert!(crate::json::parse("[1,2,3]").is_err());
            assert!(crate::import_svg("<svg width=\"10\" height=\"10\"/>").is_err());
            assert!(crate::atomic_write_path(&p, b"replace").is_err());
        });
        assert_eq!(std::fs::read(&p).unwrap(), b"keep");
        let _ = std::fs::remove_file(p);
    }
    #[test]
    fn supported_depth_fits_a_normal_thread_stack() {
        let json = format!("{}0{}", "[".repeat(512), "]".repeat(512));
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(move || assert!(crate::json::parse(&json).is_ok()))
            .unwrap()
            .join()
            .unwrap();
    }
}
