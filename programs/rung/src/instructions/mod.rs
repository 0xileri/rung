pub mod accept_commitment;
pub mod add_market;
pub mod cancel_commitment;
pub mod create_commitment;
pub mod exercise_fill;
pub mod expire_fill;
pub mod initialize_config;
pub mod set_fee;
pub mod set_market_enabled;
pub mod set_min_fill;
pub mod set_paused;

// Glob re-exports, not explicit struct exports. The #[program] macro resolves the
// __client_accounts_* modules that #[derive(Accounts)] generates through the crate
// root, and narrowing these to just the Accounts structs breaks that resolution with
// an opaque "unresolved import `crate`". Each handler is named after its instruction
// instead, so the globs no longer collide on a shared `handler` symbol.
pub use accept_commitment::*;
pub use add_market::*;
pub use cancel_commitment::*;
pub use create_commitment::*;
pub use exercise_fill::*;
pub use expire_fill::*;
pub use initialize_config::*;
pub use set_fee::*;
pub use set_market_enabled::*;
pub use set_min_fill::*;
pub use set_paused::*;
