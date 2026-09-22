use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::RungError;
use crate::state::{Fill, FillStatus, Position};

#[derive(Accounts)]
pub struct CloseFill<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        seeds = [POSITION_SEED, position.maker.as_ref(), &position.nonce.to_le_bytes()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        close = taker,
        seeds = [FILL_SEED, position.key().as_ref(), &fill.index.to_le_bytes()],
        bump = fill.bump,
        has_one = position @ RungError::InvalidState,
        has_one = taker @ RungError::Unauthorized,
    )]
    pub fill: Box<Account<'info, Fill>>,
}

/// Reclaim the rent on a fill that has already settled.
///
/// Settlement deliberately leaves the fill account behind. It is the only on-chain record
/// that a holder ever had this protection and how it ended, and an interface that forgets a
/// position the moment it settles is worse than one that costs a fraction of a cent to keep.
/// So the rent comes back when the taker asks for it, not silently at settlement.
pub fn close_fill(ctx: Context<CloseFill>) -> Result<()> {
    require!(
        ctx.accounts.fill.status != FillStatus::Matched,
        RungError::InvalidState
    );
    Ok(())
}
