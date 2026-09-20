use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, MARKET_SEED};
use crate::errors::LimitPlusError;
use crate::state::{GlobalConfig, Market};

#[derive(Accounts)]
pub struct SetMarketEnabled<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ LimitPlusError::Unauthorized,
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market.stock_mint.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}

/// Wind a market down without stranding anyone.
///
/// Both flags only ever gate *new* activity. Already-matched positions stay exercisable and
/// expirable no matter what is set here — see `exercise_position` and `expire_position`,
/// neither of which loads this account.
pub fn handler(ctx: Context<SetMarketEnabled>, enabled: bool, accept_enabled: bool) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.enabled = enabled;
    market.accept_enabled = accept_enabled;
    Ok(())
}
