use {
    anyhow::Result,
    ethrpc::block_stream::BlockNumberHash,
    event_indexing::{
        block_retriever::BlockRetrieving,
        event_handler::{EventHandler, EventRetrieving, EventStoring},
        maintenance::Maintaining,
    },
    std::sync::Arc,
    tokio::sync::Mutex,
};

pub struct EventUpdater<DB, W>(Mutex<EventHandler<W, DB, W::Event>>, bool)
where
    DB: EventStoring<W::Event>,
    W: EventRetrieving + Send + Sync;

impl<DB, W> EventUpdater<DB, W>
where
    DB: EventStoring<W::Event>,
    W: EventRetrieving + Send + Sync,
{
    /// Creates a new event updater.
    ///
    /// If a start sync block is specified, it will always resync events from
    /// this poing on creation, regardless of them being already available
    /// in the database.
    pub fn new(
        contract: W,
        db: DB,
        block_retriever: Arc<dyn BlockRetrieving>,
        start_sync_at_block: Option<BlockNumberHash>,
    ) -> Self {
        Self(
            Mutex::new(EventHandler::new(
                block_retriever,
                contract,
                db,
                start_sync_at_block,
            )),
            false,
        )
    }

    /// Arc finalizes each block; other chains retain the reorg-aware indexer.
    pub fn with_deterministic_finality(mut self) -> Self {
        self.1 = true;
        self
    }

    /// Creates a new event updater.
    ///
    /// Similar to [`Self::new()`]: the main different is that the required
    /// starting sync point specifies a value before which events should not
    /// be indexed. If there are no events available in the database (or
    /// only older events) it starts indexing from this point. If
    /// there are more recent events available, then the sync start is ignored.
    pub async fn new_skip_blocks_before(
        contract: W,
        db: DB,
        block_retriever: Arc<dyn BlockRetrieving>,
        start_sync_at_block: BlockNumberHash,
    ) -> Result<Self> {
        let handler = EventHandler::new_skip_blocks_before(
            block_retriever,
            contract,
            db,
            start_sync_at_block,
        )
        .await?;
        Ok(Self(Mutex::new(handler), false))
    }
}

#[async_trait::async_trait]
impl<DB, W> Maintaining for EventUpdater<DB, W>
where
    DB: EventStoring<W::Event> + Send + Sync,
    W: EventRetrieving + Send + Sync,
    W::Event: Send + Sync,
{
    async fn run_maintenance(&self) -> Result<()> {
        if self.1 {
            self.0.lock().await.update_events_deterministic().await
        } else {
            self.0.run_maintenance().await
        }
    }

    fn name(&self) -> &str {
        "EventUpdater"
    }
}
