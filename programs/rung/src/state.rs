use anchor_lang::prelude::*;

use crate::constants::SYMBOL_LEN;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PositionStatus {
    Open,
    /// Some of the commitment has been taken; the rest is still open.
    PartiallyMatched,
    /// Nothing open, and at least one fill has yet to settle.
    Matched,
    /// Nothing open, and every fill has settled.
    Settled,
    /// Withdrawn by the maker before any fill.
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum FillStatus {
    Matched,
    Exercised,
    Expired,
}

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    /// The single settlement currency. Every strike and premium is denominated in it.
    pub quote_mint: Pubkey,
    pub quote_token_program: Pubkey,
    /// Halts new commitments and new matches. Deliberately does NOT halt settlement —
    /// see `exercise_fill` for why pausing must never strand escrowed collateral.
    pub paused: bool,
    pub bump: u8,
    /// Protocol cut of the premium at match, in basis points, capped at `MAX_FEE_BPS`.
    pub fee_bps: u16,
    /// Owner of the token account the fee is paid into.
    pub fee_treasury: Pubkey,
    /// Smallest fill, in raw quote units, except when a fill takes the whole remainder.
    /// Also the smallest remainder a fill may leave behind. Zero disables both checks.
    pub min_fill_quote: u64,
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

/// A maker's offer of capital at a valuation, and the owner of both vaults.
///
/// The terms are fixed at creation. Takers claim slices of it through `Fill` accounts, each
/// inheriting these terms pro rata; see docs/fills.md.
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub maker: Pubkey,
    pub stock_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub stock_token_program: Pubkey,
    pub quote_token_program: Pubkey,
    /// Maker-chosen, making the position PDA collision-free without a global counter.
    pub nonce: u64,

    /// Stock the vault must hold for the commitment to be taken in full.
    ///
    /// Raw base units, never UI amounts: a ScaledUiAmount multiplier change rescales what a
    /// UI amount means, while the raw figure stays a fixed claim on the vault.
    pub stock_raw_required: u64,
    /// Raw stock the vault actually holds across every open fill. This is what settlement
    /// pays out.
    ///
    /// It is measured rather than assumed because the Token-2022 transfer fee makes the
    /// amount that arrives strictly smaller than the amount sent, by a rate that can change
    /// at an epoch boundary.
    pub stock_raw_escrowed: u64,

    pub strike_quote_amount: u64,
    /// Quote measured into the vault at creation. Every fill is sized against this, so a
    /// claim is always denominated in money that is actually there.
    pub strike_quote_escrowed: u64,
    /// The part of `strike_quote_escrowed` no taker has claimed yet.
    pub strike_quote_open: u64,
    pub premium_quote_amount: u64,

    pub expiry_ts: i64,
    pub created_at: i64,
    /// Zero until the corresponding transition occurs.
    pub first_matched_at: i64,
    pub settled_at: i64,

    /// Company valuation, in whole USD, that the maker was targeting at creation.
    ///
    /// Metadata only, and never consulted during settlement (spec §13). It is kept on-chain
    /// so the Commitment Curve can be rebuilt from chain state alone rather than trusting an
    /// indexer's private notion of what each position meant.
    pub target_valuation_usd: u64,

    /// Monotonic, and the fill PDAs' index. Never decremented, so a closed fill's address is
    /// never reused.
    pub fills_created: u32,
    /// Fills that have not settled yet.
    pub fills_open: u32,

    pub status: PositionStatus,
    pub bump: u8,
    pub authority_bump: u8,
}

impl Position {
    pub fn is_expired(&self, now: i64) -> bool {
        now > self.expiry_ts
    }

    /// The status implied by what is open and what is still outstanding.
    ///
    /// Derived rather than assigned in each instruction, so the five states cannot drift
    /// apart from the amounts they describe.
    pub fn derive_status(&self) -> PositionStatus {
        match (self.strike_quote_open, self.fills_open, self.fills_created) {
            (0, 0, 0) => PositionStatus::Cancelled,
            (0, 0, _) => PositionStatus::Settled,
            (0, _, _) => PositionStatus::Matched,
            (_, _, 0) => PositionStatus::Open,
            _ => PositionStatus::PartiallyMatched,
        }
    }
}

/// One taker's claim on part of a commitment.
#[account]
#[derive(InitSpace)]
pub struct Fill {
    pub position: Pubkey,
    pub taker: Pubkey,
    /// Index within the position, from `Position.fills_created`.
    pub index: u32,

    /// This fill's claim on the quote vault if it is exercised.
    pub strike_quote_amount: u64,
    /// Stock this fill had to deliver, before the mint's transfer fee.
    pub stock_raw_required: u64,
    /// Stock the vault actually received for it. This is what settlement pays out.
    pub stock_raw_escrowed: u64,
    /// Premium the taker paid, before the protocol fee was taken out of it.
    pub premium_paid: u64,
    pub fee_paid: u64,

    pub matched_at: i64,
    pub settled_at: i64,
    pub status: FillStatus,
    pub bump: u8,
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
    pub fill: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub fill_index: u32,
    pub strike_quote_amount: u64,
    pub stock_raw_sent: u64,
    /// Smaller than `stock_raw_sent` whenever a transfer fee applies.
    pub stock_raw_escrowed: u64,
    pub premium_paid: u64,
    pub fee_paid: u64,
    /// What is left open on the commitment after this fill.
    pub strike_quote_open: u64,
    pub matched_at: i64,
}

#[event]
pub struct PositionExercised {
    pub position: Pubkey,
    pub fill: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub quote_to_taker: u64,
    pub stock_to_maker: u64,
    pub settled_at: i64,
}

#[event]
pub struct PositionExpiredEvent {
    pub position: Pubkey,
    pub fill: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub quote_to_maker: u64,
    pub stock_to_taker: u64,
    pub settled_at: i64,
}
