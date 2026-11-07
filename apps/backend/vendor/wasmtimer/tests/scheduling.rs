//! Exact timer/heap/global sources with a deterministic clock and JS timeout queue.
#![cfg(feature = "tokio")]
#![allow(dead_code)]

extern crate self as wasm_bindgen;

use ::std::{
    cell::{Cell, RefCell},
    marker::PhantomData,
    rc::Rc,
    sync::Arc,
    time::Duration,
};
use futures::task::AtomicWaker;

thread_local! {
    static NOW: RefCell<Duration> = const { RefCell::new(Duration::ZERO) };
    static CALLBACKS: RefCell<Vec<(Duration, usize, JsValue)>> = const { RefCell::new(Vec::new()) };
    static DELAYS: RefCell<Vec<i32>> = const { RefCell::new(Vec::new()) };
    static NEXT_HANDLE: Cell<usize> = const { Cell::new(0) };
    static LIVE_CLOSURES: Cell<usize> = const { Cell::new(0) };
}

mod std {
    use ::std::{
        ops::{Add, AddAssign, Sub},
        time::Duration,
    };

    #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
    pub struct Instant(pub Duration);
    impl Instant {
        pub fn now() -> Self {
            Self(super::NOW.with(|now| *now.borrow()))
        }
        pub fn now_js() -> Self {
            Self::now()
        }
        pub fn saturating_duration_since(self, earlier: Self) -> Duration {
            self.0.saturating_sub(earlier.0)
        }
    }
    impl Add<Duration> for Instant {
        type Output = Self;
        fn add(self, duration: Duration) -> Self {
            Self(self.0 + duration)
        }
    }
    impl AddAssign<Duration> for Instant {
        fn add_assign(&mut self, duration: Duration) {
            self.0 += duration;
        }
    }
    impl Sub<Instant> for Instant {
        type Output = Duration;
        fn sub(self, other: Self) -> Duration {
            self.0 - other.0
        }
    }
    impl Sub<Duration> for Instant {
        type Output = Self;
        fn sub(self, duration: Duration) -> Self {
            Self(self.0 - duration)
        }
    }
}

pub mod closure {
    use super::*;

    #[derive(Clone)]
    pub struct Callback(Rc<RefCell<Option<Box<dyn FnOnce()>>>>);
    pub struct Closure<T: ?Sized = ()> {
        callback: JsValue,
        marker: PhantomData<T>,
    }
    impl Closure<()> {
        // Retained for baseline controls of the previous unowned driver.
        pub fn once_into_js(callback: impl FnOnce() + 'static) -> JsValue {
            let callback = Callback(Rc::new(RefCell::new(Some(Box::new(callback)))));
            JsValue::Function(callback)
        }
    }
    impl Closure<dyn FnMut()> {
        pub fn once(callback: impl FnOnce() + 'static) -> Self {
            LIVE_CLOSURES.with(|count| count.set(count.get() + 1));
            Self {
                callback: Closure::once_into_js(callback),
                marker: PhantomData,
            }
        }
    }
    impl<T: ?Sized> AsRef<JsValue> for Closure<T> {
        fn as_ref(&self) -> &JsValue {
            &self.callback
        }
    }
    impl<T: ?Sized> Drop for Closure<T> {
        fn drop(&mut self) {
            let _ = LIVE_CLOSURES.try_with(|count| count.set(count.get() - 1));
            if let JsValue::Function(callback) = &self.callback {
                callback.0.borrow_mut().take();
            }
        }
    }
    impl Callback {
        pub fn run(self) {
            let callback = self.0.borrow_mut().take().unwrap();
            callback();
        }
    }
}

#[derive(Clone)]
pub enum JsValue {
    Function(closure::Callback),
    Handle(usize),
}

impl JsValue {
    fn run(self) {
        match self {
            Self::Function(callback) => callback.run(),
            Self::Handle(_) => panic!("expected function"),
        }
    }
}

pub trait JsCast {
    fn unchecked_ref(&self) -> &Self {
        self
    }
}
impl JsCast for JsValue {}

mod js {
    use super::*;

    pub fn set_timeout(callback: &JsValue, delay: i32) -> Result<JsValue, ()> {
        assert!(delay >= 0);
        DELAYS.with(|delays| delays.borrow_mut().push(delay));
        let at = NOW.with(|now| *now.borrow() + Duration::from_millis(delay as u64));
        let id = NEXT_HANDLE.with(|next| {
            let id = next.get();
            next.set(id + 1);
            id
        });
        CALLBACKS.with(|callbacks| callbacks.borrow_mut().push((at, id, callback.clone())));
        Ok(JsValue::Handle(id))
    }

    pub fn clear_timeout(handle: &JsValue) {
        let JsValue::Handle(id) = handle else {
            panic!("expected timeout handle")
        };
        CALLBACKS.with(|callbacks| {
            callbacks
                .borrow_mut()
                .retain(|(_, pending, _)| pending != id)
        });
    }
}

#[path = "../src/timer/mod.rs"]
mod timer;
#[cfg(feature = "tokio-test-util")]
use timer::clock;
// Expose the exact private driver to this integration harness without changing runtime visibility.
#[path = "../src/timer/global.rs"]
mod driver;

fn reset() {
    CALLBACKS.with(|callbacks| callbacks.borrow_mut().clear());
    NOW.with(|now| *now.borrow_mut() = Duration::ZERO);
    DELAYS.with(|delays| delays.borrow_mut().clear());
}

fn drive_until(until: Duration) {
    for _ in 0..1000 {
        let callback = CALLBACKS.with(|callbacks| {
            let mut callbacks = callbacks.borrow_mut();
            let index = callbacks
                .iter()
                .enumerate()
                .min_by_key(|(_, (at, _, _))| *at)
                .filter(|(_, (at, _, _))| *at <= until)
                .map(|(index, _)| index);
            index.map(|index| callbacks.swap_remove(index))
        });
        let Some((at, _, callback)) = callback else {
            NOW.with(|now| *now.borrow_mut() = until);
            return;
        };
        NOW.with(|now| *now.borrow_mut() = at);
        callback.run();
    }
    panic!("timer repeatedly scheduled callbacks without advancing time");
}

fn register(
    handle: &timer::TimerHandle,
    deadline: Duration,
) -> Arc<timer::arc_list::Node<timer::ScheduledTimer>> {
    let inner = handle.inner.upgrade().unwrap();
    let node = Arc::new(timer::arc_list::Node::new(timer::ScheduledTimer {
        waker: AtomicWaker::new(),
        state: ::std::sync::atomic::AtomicUsize::new(0),
        inner: Arc::downgrade(&inner),
        at: ::std::sync::Mutex::new(Some(std::Instant(deadline))),
        slot: ::std::sync::Mutex::new(None),
    }));
    inner.list.push(&node).unwrap();
    inner.waker.wake();
    node
}

#[test]
fn saturated_late_callbacks_cannot_postpone_a_new_earlier_timer() {
    reset();
    let handle = driver::run();
    drive_until(Duration::ZERO);
    let mut timers = Vec::new();
    // Retain enough long callbacks to exercise the actual pending-callback cap.
    for _ in 0..40 {
        timers.push(register(&handle, Duration::from_secs(60)));
        drive_until(Duration::ZERO);
    }
    let before = CALLBACKS.with(|callbacks| callbacks.borrow().len());
    assert!(
        before >= 18,
        "the saturation branch must actually be reached"
    );
    timers.push(register(&handle, Duration::from_secs(120)));
    drive_until(Duration::ZERO);
    assert_eq!(
        CALLBACKS.with(|callbacks| callbacks.borrow().len()),
        before,
        "later callbacks must still be throttled"
    );
    let early = register(&handle, Duration::from_secs(1));
    drive_until(Duration::ZERO);
    assert!(CALLBACKS.with(|callbacks| callbacks
        .borrow()
        .iter()
        .any(|(at, _, _)| *at == Duration::from_secs(1))));
    drive_until(Duration::from_secs(1));
    assert_eq!(
        early.state.load(::std::sync::atomic::Ordering::SeqCst) & 1,
        1
    );
    assert_eq!(
        timers[0].state.load(::std::sync::atomic::Ordering::SeqCst) & 1,
        0
    );
}

#[test]
fn long_deadlines_use_maximum_delay_and_recheck_without_zero_delay_spin() {
    reset();
    let handle = driver::run();
    drive_until(Duration::ZERO);
    DELAYS.with(|delays| delays.borrow_mut().clear());
    let maximum = Duration::from_millis(i32::MAX as u64);
    let node = register(&handle, maximum + Duration::from_millis(1000));
    drive_until(Duration::ZERO);
    assert_eq!(DELAYS.with(|delays| delays.borrow().clone()), [0, i32::MAX]);
    drive_until(maximum);
    assert_eq!(
        node.state.load(::std::sync::atomic::Ordering::SeqCst) & 1,
        0
    );
    assert_eq!(DELAYS.with(|delays| *delays.borrow().last().unwrap()), 1000);
    drive_until(maximum + Duration::from_millis(1000));
    assert_eq!(
        node.state.load(::std::sync::atomic::Ordering::SeqCst) & 1,
        1
    );
}

#[test]
fn ordinary_and_maximum_delays_keep_their_existing_values() {
    for millis in [1_u64, 250, i32::MAX as u64] {
        reset();
        let handle = driver::run();
        drive_until(Duration::ZERO);
        let node = register(&handle, Duration::from_millis(millis));
        drive_until(Duration::ZERO);
        assert_eq!(
            DELAYS.with(|delays| *delays.borrow().last().unwrap()),
            millis as i32
        );
        drive_until(Duration::from_millis(millis));
        assert_eq!(
            node.state.load(::std::sync::atomic::Ordering::SeqCst) & 1,
            1
        );
    }
}

#[cfg(feature = "tokio-test-util")]
#[test]
fn paused_clock_keeps_its_recursion_bound_and_can_wake_again() {
    reset();
    let handle = driver::run();
    drive_until(Duration::ZERO);
    timer::clock::clock().pause();
    let node = register(&handle, Duration::from_secs(1));
    // A paused callback runs synchronously: it must return instead of recursing forever.
    assert!(CALLBACKS.with(|callbacks| callbacks.borrow().is_empty()));
    assert_eq!(
        node.state.load(::std::sync::atomic::Ordering::SeqCst) & 1,
        0
    );
    timer::clock::clock().resume();
    NOW.with(|now| *now.borrow_mut() = Duration::from_secs(1));
    handle.inner.upgrade().unwrap().waker.wake();
    drive_until(Duration::from_secs(1));
    assert_eq!(
        node.state.load(::std::sync::atomic::Ordering::SeqCst) & 1,
        1
    );
}

#[test]
fn repeated_earlier_resets_bound_callbacks_and_release_canceled_closures() {
    reset();
    let handle = driver::run();
    drive_until(Duration::ZERO);
    let node = register(&handle, Duration::from_secs(3600));
    drive_until(Duration::ZERO);
    let inner = handle.inner.upgrade().unwrap();
    for earlier in 1..=1000 {
        *node.at.lock().unwrap() = Some(std::Instant(Duration::from_secs(3600 - earlier)));
        inner.list.push(&node).unwrap();
        inner.waker.wake();
        drive_until(Duration::ZERO);
        assert!(CALLBACKS.with(|callbacks| callbacks.borrow().len()) <= 20);
        assert!(LIVE_CLOSURES.with(|count| count.get()) <= 20);
    }
    drive_until(Duration::from_secs(2599));
    assert_eq!(
        node.state.load(::std::sync::atomic::Ordering::SeqCst) & 1,
        0
    );
    drive_until(Duration::from_secs(2600));
    assert_eq!(
        node.state.load(::std::sync::atomic::Ordering::SeqCst) & 1,
        1
    );
    drive_until(Duration::from_secs(3600));
    assert!(CALLBACKS.with(|callbacks| callbacks.borrow().is_empty()));
    assert_eq!(LIVE_CLOSURES.with(|count| count.get()), 0);
}
