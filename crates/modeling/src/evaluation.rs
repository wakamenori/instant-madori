use solidcraft_doc::EvalCache;
use solidcraft_engine::{Session, schema::ParamCheck};
use std::{
    ops::{Deref, DerefMut},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicUsize, Ordering},
    },
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Evaluation {
    pub recomputed: usize,
    pub restored: usize,
}

#[derive(Clone)]
pub(crate) struct Scope {
    cache: Arc<Mutex<EvalCache>>,
    retired: Arc<AtomicUsize>,
}

impl Scope {
    pub(crate) fn new() -> Self {
        Self {
            cache: Arc::new(Mutex::new(EvalCache::default())),
            retired: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub(crate) fn session(&self, name: &str) -> Counted {
        let mut session = crate::new_session(name);
        session.param_check = ParamCheck::Strict;
        session.model.cache = self.cache.clone();
        Counted {
            session,
            base: 0,
            retired: self.retired.clone(),
        }
    }

    pub(crate) fn scratch(&self, source: &Session) -> Counted {
        Counted {
            session: source.scratch(),
            base: source.model.recomputed,
            retired: self.retired.clone(),
        }
    }

    pub(crate) fn evaluation(&self, live: &Session) -> Evaluation {
        Evaluation {
            recomputed: self.retired.load(Ordering::Relaxed) + live.model.recomputed,
            restored: self
                .cache
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .hits,
        }
    }
}

pub(crate) struct Counted {
    session: Session,
    base: usize,
    retired: Arc<AtomicUsize>,
}

impl Deref for Counted {
    type Target = Session;
    fn deref(&self) -> &Session {
        &self.session
    }
}
impl DerefMut for Counted {
    fn deref_mut(&mut self) -> &mut Session {
        &mut self.session
    }
}
impl Drop for Counted {
    fn drop(&mut self) {
        self.retired.fetch_add(
            self.session.model.recomputed.saturating_sub(self.base),
            Ordering::Relaxed,
        );
    }
}
