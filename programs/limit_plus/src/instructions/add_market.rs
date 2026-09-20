use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::constants::{CONFIG_SEED, MARKET_SEED, SYMBOL_LEN};
use crate::errors::LimitPlusError;
use crate::state::{GlobalConfig, Market};

#[derive(Accounts)]
pub struct AddMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ LimitPlusError::Unauthorized,
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, stock_mint.key().as_ref()],
        bump,
    )]
    pub market: Account<'info, Market>,

    pub stock_mint: InterfaceAccount<'info, Mint>,
    /// Pinned into the market so this mint can only ever be moved by this program.
    pub stock_token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

/// Admin-gated on purpose: the PreStocks API returning an asset is not consent to escrow it.
pub fn handler(ctx: Context<AddMarket>, symbol: String) -> Result<()> {
    require!(
        symbol.len() <= SYMBOL_LEN,
        LimitPlusError::SymbolTooLong
    );

    let mut padded = [0u8; SYMBOL_LEN];
    padded[..symbol.len()].copy_from_slice(symbol.as_bytes());

    let market = &mut ctx.accounts.market;
    market.stock_mint = ctx.accounts.stock_mint.key();
    market.token_program = ctx.accounts.stock_token_program.key();
    market.symbol = padded;
    market.enabled = true;
    market.accept_enabled = true;
    market.bump = ctx.bumps.market;
    Ok(())
}
