use anchor_lang::prelude::*;

use crate::constants::CONFIG_SEED;
use crate::errors::LimitPlusError;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ LimitPlusError::Unauthorized,
    )]
    pub config: Box<Account<'info, GlobalConfig>>,
}

/// Halt new commitments and new matches protocol-wide.
///
/// Settlement is intentionally out of scope for this switch: `exercise_position` and
/// `expire_position` never read the config, so pausing can stop the protocol from taking on
/// new risk without touching collateral that is already escrowed.
pub fn handler(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}
