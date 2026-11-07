use futures::task::{self, ArcWake};
use parking_lot::Mutex;
use std::cell::{Cell, RefCell};
use std::convert::TryFrom;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::Context;
use std::time::Duration;
use wasm_bindgen::{closure::Closure, JsCast, JsValue};

use crate::js::{clear_timeout, set_timeout};
use crate::std::Instant;
use crate::timer::{Timer, TimerHandle};

const MAX_CALLBACKS: usize = 20;

// JS handles and owned closures stay on their event-loop thread, outside the
// Send + Sync timer/waker. Cancellation drops captures without once_into_js leaks.
thread_local! {
    static CALLBACKS: RefCell<Vec<Callback>> = const { RefCell::new(Vec::new()) };
    static NEXT_ID: Cell<usize> = const { Cell::new(0) };
}

struct Callback {
    id: usize,
    timer: usize,
    deadline: Instant,
    handle: JsValue,
    _closure: Closure<dyn FnMut()>,
}

/// Starts the timer driver and returns its thread-safe handle.
pub(crate) fn run() -> TimerHandle {
    let timer = Timer::new();
    let handle = timer.handle();
    schedule_callback(Arc::new(Mutex::new(timer)), Duration::ZERO);
    handle
}

fn paused() -> bool {
    #[cfg(feature = "tokio-test-util")]
    return super::clock::clock().paused();
    #[cfg(not(feature = "tokio-test-util"))]
    false
}

fn reserve_callback(timer: usize, deadline: Instant) -> Option<usize> {
    let evicted = CALLBACKS
        .with(|callbacks| {
            let mut callbacks = callbacks.borrow_mut();
            let pending = callbacks.iter().filter(|callback| callback.timer == timer);
            if pending.clone().count() < MAX_CALLBACKS {
                return Ok(None);
            }
            if pending
                .clone()
                .any(|callback| callback.deadline <= deadline)
            {
                return Err(());
            }
            let index = callbacks
                .iter()
                .enumerate()
                .filter(|(_, callback)| callback.timer == timer)
                .max_by_key(|(_, callback)| callback.deadline)
                .unwrap()
                .0;
            Ok(Some(callbacks.swap_remove(index)))
        })
        .ok()?;
    // No RefCell borrow is held while JS is called or the owned closure drops.
    if let Some(callback) = evicted {
        clear_timeout(&callback.handle);
        drop(callback);
    }
    Some(NEXT_ID.with(|next| loop {
        let id = next.get();
        next.set(id.wrapping_add(1));
        if CALLBACKS.with(|callbacks| callbacks.borrow().iter().all(|callback| callback.id != id)) {
            break id;
        }
    }))
}

/// Schedule on this JS event loop. A full queue coalesces later wakes; an
/// earlier wake cancels an obsolete later callback before replacing it.
fn schedule_callback(timer: Arc<Mutex<Timer>>, when: Duration) {
    let delay = i32::try_from(when.as_millis()).unwrap_or(i32::MAX);
    let deadline = Instant::now() + Duration::from_millis(delay as u64);
    let key = Arc::as_ptr(&timer) as usize;
    let synchronous = paused();
    let id = if synchronous {
        None
    } else {
        match reserve_callback(key, deadline) {
            Some(id) => Some(id),
            None => return,
        }
    };
    let cb = move || {
        // Keep the current closure alive through execution, but remove its ID
        // before scheduling a successor. Never remove that successor on return.
        let _active = id.map(|id| {
            CALLBACKS.with(|callbacks| {
                let mut callbacks = callbacks.borrow_mut();
                let index = callbacks
                    .iter()
                    .position(|callback| callback.id == id)
                    .unwrap();
                callbacks.swap_remove(index)
            })
        });
        let mut timer_lock = timer.lock();
        let waker = task::waker(Arc::new(Waker {
            timer: timer.clone(),
        }));
        let _ = Future::poll(Pin::new(&mut *timer_lock), &mut Context::from_waker(&waker));
        let now = Instant::now();
        timer_lock.advance_to(now);
        if synchronous && Arc::strong_count(&timer) > MAX_CALLBACKS {
            return;
        }
        let sleep = timer_lock
            .next_event()
            .map(|next| next.saturating_duration_since(now));
        drop(timer_lock);
        if let Some(sleep) = sleep {
            schedule_callback(timer, sleep);
        }
    };
    if synchronous {
        cb();
    } else {
        let callback: Closure<dyn FnMut()> = Closure::once(cb);
        let handle = set_timeout(callback.as_ref().unchecked_ref(), delay).unwrap();
        CALLBACKS.with(|callbacks| {
            callbacks.borrow_mut().push(Callback {
                id: id.unwrap(),
                timer: key,
                deadline,
                handle,
                _closure: callback,
            })
        });
    }
}

struct Waker {
    timer: Arc<Mutex<Timer>>,
}

impl ArcWake for Waker {
    fn wake_by_ref(arc_self: &Arc<Self>) {
        schedule_callback(arc_self.timer.clone(), Duration::ZERO);
    }
}
