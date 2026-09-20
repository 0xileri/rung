//! Limit+ — a capital-backed valuation market for PreStocks on Solana.
//!
//! A valuation buyer locks USDC at the private-company valuation where they would actually
//! be willing to own exposure. A PreStock holder locks the matching tokens, pays a premium,
//! and receives the right to exchange those tokens for that USDC at any point before expiry.
//! If they never exercise, both sides take back their own collateral and the maker keeps the
//! premium.
//!
//! Two properties are worth stating up front, because they are what the design is built
//! around:
//!
//! 1. **No oracle decides anything.** The holder bought a right, not a bet on a price feed,
//!    so the program never asks what the asset is worth. That removes stale marks, thin-market
//!    prints and feed manipulation from the settlement path entirely.
//!
//! 2. **Valuations are metadata; raw amounts are the contract.** Company valuations are how
//!    the position is *chosen*, and they are recorded for that purpose, but settlement is
//!    defined purely by fixed raw token amounts and a fixed USDC amount. A later change to a
//!    mark, a share count or a ScaledUiAmount multiplier cannot rewrite an agreement that is
//!    already in force.
//!
//! PreStocks mints are Token-2022 and charge a transfer fee, so an amount sent is never the
//! amount that arrives. Every escrow path here measures the vault's balance delta rather than
//! assuming the two are equal. See `accept_commitment` for the full reasoning.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::*;

declare_id!("6kqka5NWofo1cm6bm5JMhWbQgHeR6YT23qTvwnusSwpM");

#[program]
pub mod limit_plus {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        instructions::initialize_config::handler(ctx)
    }

    /// Allowlist a PreStock mint. Admin-only: the PreStocks API is discovery, not consent.
    pub fn add_market(ctx: Context<AddMarket>, symbol: String) -> Result<()> {
        instructions::add_market::handler(ctx, symbol)
    }

    pub fn set_market_enabled(
        ctx: Context<SetMarketEnabled>,
        enabled: bool,
        accept_enabled: bool,
    ) -> Result<()> {
        instructions::set_market_enabled::handler(ctx, enabled, accept_enabled)
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::set_paused::handler(ctx, paused)
    }

    /// Maker (valuation buyer) locks USDC against a target valuation.
    pub fn create_commitment(
        ctx: Context<CreateCommitment>,
        nonce: u64,
        stock_raw_required: u64,
        strike_quote_amount: u64,
        premium_quote_amount: u64,
        expiry_ts: i64,
        target_valuation_usd: u64,
    ) -> Result<()> {
        instructions::create_commitment::handler(
            ctx,
            nonce,
            stock_raw_required,
            strike_quote_amount,
            premium_quote_amount,
            expiry_ts,
            target_valuation_usd,
        )
    }

    pub fn cancel_commitment(ctx: Context<CancelCommitment>) -> Result<()> {
        instructions::cancel_commitment::handler(ctx)
    }

    /// Taker (protection buyer) locks stock and pays the premium.
    pub fn accept_commitment(ctx: Context<AcceptCommitment>, stock_raw_to_send: u64) -> Result<()> {
        instructions::accept_commitment::handler(ctx, stock_raw_to_send)
    }

    /// Taker swaps the escrowed stock for the escrowed USDC. Only they may call it.
    pub fn exercise_position(ctx: Context<ExercisePosition>) -> Result<()> {
        instructions::exercise_position::handler(ctx)
    }

    /// Return both collaterals after expiry. Permissionless.
    pub fn expire_position(ctx: Context<ExpirePosition>) -> Result<()> {
        instructions::expire_position::handler(ctx)
    }
}
