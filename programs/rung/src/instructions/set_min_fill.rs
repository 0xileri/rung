use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::RungError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct SetMinFill<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ RungError::Unauthorized,
    )]
    pub config: Account<'info, GlobalConfig>,
}

/// Set the smallest fill, in raw quote units.
///
/// It bounds dust in both directions: how small a slice a taker may carve out, and how small
/// a remainder they may leave behind (docs/fills.md). It never blocks a taker from clearing
/// a commitment completely, so raising it cannot strand an open remainder below the new
/// minimum.
pub fn set_min_fill(ctx: Context<SetMinFill>, min_fill_quote: u64) -> Result<()> {
    ctx.accounts.config.min_fill_quote = min_fill_quote;
    Ok(())
}
