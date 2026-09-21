use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const MARKET_SEED: &[u8] = b"market";
#[constant]
pub const POSITION_SEED: &[u8] = b"position";
#[constant]
pub const POSITION_AUTHORITY_SEED: &[u8] = b"position_authority";

/// Upper bound on how far out a commitment may expire.
///
/// Private-company tokens are exposed to financing rounds, migrations and redemptions
/// (spec §49). Nothing here models those events, so the horizon is capped instead: a
/// contract that cannot be rewritten should not be allowed to run for years.
pub const MAX_EXPIRY_HORIZON_SECS: i64 = 365 * 24 * 60 * 60;

/// Rejects an expiry so close that it could lapse before the taker's accept lands.
pub const MIN_EXPIRY_HORIZON_SECS: i64 = 60;

/// Fixed width for the indexing symbol carried on `Market`.
pub const SYMBOL_LEN: usize = 16;

/// Launch guardrail: the most quote currency, in whole units (dollars, for USDC), that one
/// position may lock.
///
/// The program is unaudited and holds real funds on mainnet. A cap does not make a bug less
/// likely, it bounds what any one position can lose to one. Scaled by the quote mint's own
/// decimals at runtime, so it means the same thing whatever that mint is. Raising it is a
/// program upgrade on purpose: a limit an admin key could lift quietly is not much of one.
#[constant]
pub const MAX_STRIKE_WHOLE_UNITS: u64 = 1_000;
