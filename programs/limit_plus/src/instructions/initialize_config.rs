use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::constants::CONFIG_SEED;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    pub quote_mint: InterfaceAccount<'info, Mint>,
    pub quote_token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeConfig>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.quote_mint = ctx.accounts.quote_mint.key();
    config.quote_token_program = ctx.accounts.quote_token_program.key();
    config.paused = false;
    config.bump = ctx.bumps.config;
    Ok(())
}
