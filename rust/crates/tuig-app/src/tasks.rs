//! Git task slots. Each kind of load has one [`Slot`]. Starting a load aborts the previous task in the slot and
//! gives the new one a fresh [`ReqId`]. A result applies only when its id is still the slot's current id, so a
//! result that was already on its way when the slot moved on is dropped. This replaces the TS `AbortController`s
//! and the counters `snapshotRequest`, `diffRequest` and `commitFilesRequest`.

use opentui::app::TaskHandle;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReqId(pub(crate) u64);

#[derive(Default)]
pub struct Slot {
    id: u64,
    task: Option<TaskHandle>,
    /// When the running or last finished request started.
    started_at: Option<Instant>,
}

impl Slot {
    /// Aborts the running task and returns the id for the next one.
    pub fn begin(&mut self) -> ReqId {
        self.cancel();
        self.started_at = Some(Instant::now());
        ReqId(self.id)
    }

    pub fn attach(&mut self, task: TaskHandle) {
        self.task = Some(task);
    }

    /// Aborts the running task. A result that already left the task is dropped when it arrives.
    pub fn cancel(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        self.id += 1;
    }

    /// Whether a result with `id` applies. Marks the slot idle when it does.
    pub fn finish(&mut self, id: ReqId) -> bool {
        if id.0 != self.id || self.task.is_none() {
            return false;
        }
        self.task = None;
        true
    }

    /// The id of the running or last request.
    #[cfg(test)]
    pub fn current(&self) -> ReqId {
        ReqId(self.id)
    }

    pub fn busy(&self) -> bool {
        self.task.is_some()
    }

    pub fn started_at(&self) -> Option<Instant> {
        self.started_at
    }
}

#[derive(Default)]
pub struct Tasks {
    pub snapshot: Slot,
    pub page: Slot,
    pub watch_paths: Slot,
}
