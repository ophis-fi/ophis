//! Host-clock harness for the exact two patched source modules; no JS clock is invoked.
#![cfg(feature = "tokio")]

use ::std::{
    cell::Cell,
    future::{pending, ready, Future},
    marker::PhantomPinned,
    pin::Pin,
    rc::Rc,
    task::{Context, Poll},
    time::{Duration, Instant},
};
use futures::{task::noop_waker_ref, FutureExt};

mod std {
    pub use ::std::time::Instant;
}

struct Sleep(Instant);
impl Sleep {
    fn new(duration: Duration) -> Self {
        Self(Instant::now() + duration)
    }
    fn new_at(deadline: Instant) -> Self {
        Self(deadline)
    }
    fn deadline(&self) -> Instant {
        self.0
    }
    fn reset(self: Pin<&mut Self>, deadline: Instant) {
        self.get_mut().0 = deadline;
    }
}
impl ::std::fmt::Debug for Sleep {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        self.0.fmt(f)
    }
}
impl Future for Sleep {
    type Output = ();
    fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<()> {
        if Instant::now() >= self.0 {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }
}

mod tokio {
    pub(crate) use super::Sleep;
    pub mod error {
        #[derive(Debug, PartialEq)]
        pub struct Elapsed;
        impl Elapsed {
            pub(crate) fn new() -> Self {
                Self
            }
        }
    }
    pub mod interval {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/tokio/interval.rs"
        ));
    }
    pub mod timeout {
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/tokio/timeout.rs"));
    }
}

#[test]
fn a_ready_future_wins_even_when_the_delay_has_elapsed() {
    let mut timeout = ::std::pin::pin!(tokio::timeout::timeout(Duration::ZERO, ready(7)));
    assert_eq!(
        timeout
            .as_mut()
            .poll(&mut Context::from_waker(noop_waker_ref())),
        Poll::Ready(Ok(7))
    );
}

#[test]
fn a_pending_future_times_out_and_accessors_still_work() {
    let mut timeout = ::std::pin::pin!(tokio::timeout::timeout(Duration::ZERO, pending::<u8>()));
    assert_eq!(
        timeout
            .as_mut()
            .poll(&mut Context::from_waker(noop_waker_ref())),
        Poll::Ready(Err(tokio::error::Elapsed))
    );
    let mut timeout = tokio::timeout::timeout(Duration::from_secs(3600), ready(7));
    let _ = timeout.get_ref();
    *timeout.get_mut() = ready(8);
    assert_eq!(timeout.into_inner().now_or_never(), Some(8));
    let timeout = tokio::timeout::timeout_at(Instant::now(), ready(11));
    assert_eq!(timeout.now_or_never(), Some(Ok(11)));
}

struct PinnedFuture {
    address: Cell<*const Self>,
    ready: Rc<Cell<bool>>,
    _pinned: PhantomPinned,
}
impl Future for PinnedFuture {
    type Output = u8;
    fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<u8> {
        let this = self.as_ref().get_ref();
        if this.address.get().is_null() {
            this.address.set(this);
        }
        assert_eq!(this.address.get(), this as *const Self);
        if this.ready.get() {
            Poll::Ready(9)
        } else {
            Poll::Pending
        }
    }
}

#[test]
fn a_non_unpin_future_keeps_its_address_across_polls() {
    let ready = Rc::new(Cell::new(false));
    let future = PinnedFuture {
        address: Cell::new(::std::ptr::null()),
        ready: ready.clone(),
        _pinned: PhantomPinned,
    };
    let mut timeout = Box::pin(tokio::timeout::timeout(Duration::from_secs(3600), future));
    let mut cx = Context::from_waker(noop_waker_ref());
    assert_eq!(timeout.as_mut().poll(&mut cx), Poll::Pending);
    ready.set(true);
    assert_eq!(timeout.as_mut().poll(&mut cx), Poll::Ready(Ok(9)));
}

#[test]
fn intervals_keep_their_unpin_and_tick_reset_behavior() {
    fn requires_unpin<T: Unpin>() {}
    requires_unpin::<wasmtimer::tokio::Interval>();
    requires_unpin::<wasmtimer::tokio::Timeout<::std::future::Ready<u8>>>();
    let mut interval = tokio::interval::interval(Duration::from_secs(3600));
    let mut cx = Context::from_waker(noop_waker_ref());
    assert!(interval.tick().now_or_never().is_some());
    assert!(interval.poll_tick(&mut cx).is_pending());
    interval.set_missed_tick_behavior(tokio::interval::MissedTickBehavior::Delay);
    interval.reset();
    assert_eq!(interval.period(), Duration::from_secs(3600));
    assert_eq!(
        interval.missed_tick_behavior(),
        tokio::interval::MissedTickBehavior::Delay
    );
    assert!(interval.poll_tick(&mut cx).is_pending());
    interval.set_missed_tick_behavior(tokio::interval::MissedTickBehavior::Skip);
    assert_eq!(
        interval.missed_tick_behavior(),
        tokio::interval::MissedTickBehavior::Skip
    );
    let mut later = tokio::interval::interval_at(
        Instant::now() + Duration::from_secs(3600),
        Duration::from_secs(3600),
    );
    assert!(later.poll_tick(&mut cx).is_pending());
}

#[test]
fn zero_period_skip_stays_ready_after_a_late_tick_in_both_constructors() {
    let mut cx = Context::from_waker(noop_waker_ref());
    let mut intervals = [
        tokio::interval::interval(Duration::ZERO),
        tokio::interval::interval_at(Instant::now() - Duration::from_secs(1), Duration::ZERO),
    ];
    for interval in &mut intervals {
        interval.set_missed_tick_behavior(tokio::interval::MissedTickBehavior::Skip);
    }
    // Exercise the >5ms missed-tick branch, not just the immediate first tick.
    ::std::thread::sleep(Duration::from_millis(10));
    for interval in &mut intervals {
        assert!(interval.poll_tick(&mut cx).is_ready());
        assert!(interval.poll_tick(&mut cx).is_ready());
        assert_eq!(interval.period(), Duration::ZERO);
    }
}
