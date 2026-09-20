use anchor_lang::prelude::*;

use crate::constants::SYMBOL_LEN;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PositionStatus {
    Open,
    Matched,
    Exercised,
    Expired,
    Cancelled,
}

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    /// The single settlement currency. Every strike and premium is denominated in it.
    pub quote_mint: Pubkey,
    pub quote_token_program: Pubkey,
    /// Halts new commitments and new matches. Deliberately does NOT halt settlement —
    /// see `exercise_position` for why pausing must never strand escrowed collateral.
    pub paused: bool,
    pub bump: u8,
}

/// Allowlist entry for one PreStock.
///
/// The PreStocks API is discovery, not authorization (spec §48): anything it returns is a
/// suggestion, and only a `Market` created by the admin makes a mint eligible for escrow.
/// This is what stops a lookalike mint from being passed off as the real token.
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub stock_mint: Pubkey,
    /// Pinned at registration. PreStocks are Token-2022, but binding it explicitly means a
    /// mint cannot later be serviced by an unexpected program.
    pub token_program: Pubkey,
    /// Right-padded ticker, carried purely so indexers can group without a side table.
    pub symbol: [u8; SYMBOL_LEN],
    /// Gates `create_commitment`.
    pub enabled: bool,
    /// Gates `accept_commitment` independently, so a market can be wound down by letting
    /// open commitments drain rather than stranding them (spec §50).
    pub accept_enabled: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub maker: Pubkey,
    /// `Pubkey::default()` until matched.
    pub taker: Pubkey,
    pub stock_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub stock_token_program: Pubkey,
    pub quote_token_program: Pubkey,
    /// Maker-chosen, making the position PDA collision-free without a global counter.
    pub nonce: u64,

    /// Minimum raw stock the vault must hold for a match to be valid.
    ///
    /// Raw base units, never UI amounts: a ScaledUiAmount multiplier change rescales what a
    /// UI amount means, while the raw figure stays a fixed claim on the vault.
    pub stock_raw_required: u64,
    /// Raw stock the vault actually received. This is what settlement pays out.
    ///
    /// It is measured rather than assumed because the Token-2022 transfer fee makes the
    /// amount that arrives strictly smaller than the amount sent, by a rate that can change
    /// at an epoch boundary.
    pub stock_raw_escrowed: u64,

    pub strike_quote_amount: u64,
    pub strike_quote_escrowed: u64,
    pub premium_quote_amount: u64,

    pub expiry_ts: i64,
    pub created_at: i64,
    /// Zero until the corresponding transition occurs.
    pub matched_at: i64,
    pub settled_at: i64,

    /// Company valuation, in whole USD, that the maker was targeting at creation.
    ///
    /// Metadata only, and never consulted during settlement (spec §13). It is kept on-chain
    /// so the Commitment Curve can be rebuilt from chain state alone rather than trusting an
    /// indexer's private notion of what each position meant.
    pub target_valuation_usd: u64,

    pub status: PositionStatus,
    pub bump: u8,
    pub authority_bump: u8,
}

impl Position {
    pub fn is_expired(&self, now: i64) -> bool {
        now > self.expiry_ts
    }
}

#[event]
pub struct CommitmentCreated {
    pub position: Pubkey,
    pub maker: Pubkey,
    pub stock_mint: Pubkey,
    pub stock_raw_required: u64,
    pub strike_quote_escrowed: u64,
    pub premium_quote_amount: u64,
    pub target_valuation_usd: u64,
    pub expiry_ts: i64,
}

#[event]
pub struct CommitmentCancelled {
    pub position: Pubkey,
    pub maker: Pubkey,
    pub quote_returned: u64,
}

#[event]
pub struct CommitmentMatched {
    pub position: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub stock_raw_sent: u64,
    /// Smaller than `stock_raw_sent` whenever a transfer fee applies.
    pub stock_raw_escrowed: u64,
    pub premium_paid: u64,
    pub matched_at: i64,
}

#[event]
pub struct PositionExercised {
    pub position: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub quote_to_taker: u64,
    pub stock_to_maker: u64,
    pub settled_at: i64,
}

#[event]
pub struct PositionExpiredEvent {
    pub position: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub quote_to_maker: u64,
    pub stock_to_taker: u64,
    pub settled_at: i64,
}
