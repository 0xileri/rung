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
