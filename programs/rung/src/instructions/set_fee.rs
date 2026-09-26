use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::RungError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct SetFee<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ RungError::Unauthorized,
    )]
    pub config: Account<'info, GlobalConfig>,

    /// CHECK: Recorded as the fee recipient; it only ever owns a token account.
    pub fee_treasury: UncheckedAccount<'info>,
}

/// Set the protocol's cut of the premium, and where it goes.
///
/// Capped at `MAX_FEE_BPS` in the program, not in the client: the bound is what makes the
/// admin key unable to take a maker's whole income at the moment a match lands. It applies
/// to matches from here on; fills already agreed keep the split recorded on them.
pub fn set_fee(ctx: Context<SetFee>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, RungError::FeeTooHigh);
    let config = &mut ctx.accounts.config;
    config.fee_bps = fee_bps;
    config.fee_treasury = ctx.accounts.fee_treasury.key();
    Ok(())
}
