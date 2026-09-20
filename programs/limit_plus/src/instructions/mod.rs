pub mod accept_commitment;
pub mod add_market;
pub mod cancel_commitment;
pub mod create_commitment;
pub mod exercise_position;
pub mod expire_position;
pub mod initialize_config;
pub mod set_market_enabled;
pub mod set_paused;

// Only the Accounts structs are re-exported, so `use instructions::*` in lib.rs brings the
// context types into scope for the #[program] macro without also pulling nine functions all
// named `handler` into one namespace. Glob-exporting the modules wholesale made `handler`
// ambiguous; every call site qualifies it anyway, so nothing here needs the shorter path.
pub use accept_commitment::AcceptCommitment;
pub use add_market::AddMarket;
pub use cancel_commitment::CancelCommitment;
pub use create_commitment::CreateCommitment;
pub use exercise_position::ExercisePosition;
pub use expire_position::ExpirePosition;
pub use initialize_config::InitializeConfig;
pub use set_market_enabled::SetMarketEnabled;
pub use set_paused::SetPaused;
