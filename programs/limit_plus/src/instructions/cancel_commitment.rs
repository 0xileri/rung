use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::LimitPlusError;
use crate::state::{CommitmentCancelled, Position, PositionStatus};
use crate::utils::transfer_tokens;

#[derive(Accounts)]
pub struct CancelCommitment<'info> {
    pub maker: Signer<'info>,

    #[account(
        mut,
        seeds = [POSITION_SEED, maker.key().as_ref(), &position.nonce.to_le_bytes()],
        bump = position.bump,
        has_one = maker @ LimitPlusError::Unauthorized,
        has_one = quote_mint @ LimitPlusError::InvalidQuoteMint,
    )]
    pub position: Box<Account<'info, Position>>,

    /// CHECK: Vault authority PDA, validated by seeds.
    #[account(
        seeds = [POSITION_AUTHORITY_SEED, position.key().as_ref()],
        bump = position.authority_bump,
    )]
    pub position_authority: UncheckedAccount<'info>,

    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = position_authority,
        associated_token::token_program = quote_token_program,
    )]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = maker,
        token::token_program = quote_token_program,
    )]
    pub maker_quote_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub quote_token_program: Interface<'info, TokenInterface>,
}

/// Withdraw an unmatched commitment.
///
/// Only valid while Open. Once a taker has locked stock against it the maker is committed
/// for the full term: allowing a cancel after that would let the maker walk away from the
/// protection they were paid a premium to provide.
pub fn handler(ctx: Context<CancelCommitment>) -> Result<()> {
    require!(
        ctx.accounts.position.status == PositionStatus::Open,
        LimitPlusError::InvalidState
    );

    let amount = ctx.accounts.position.strike_quote_escrowed;
    let position_key = ctx.accounts.position.key();
    let authority_bump = ctx.accounts.position.authority_bump;
    let seeds: &[&[u8]] = &[
        POSITION_AUTHORITY_SEED,
        position_key.as_ref(),
        &[authority_bump],
    ];

    transfer_tokens(
        ctx.accounts.quote_token_program.to_account_info(),
        ctx.accounts.quote_vault.to_account_info(),
        ctx.accounts.quote_mint.to_account_info(),
        ctx.accounts.maker_quote_account.to_account_info(),
        ctx.accounts.position_authority.to_account_info(),
        amount,
        ctx.accounts.quote_mint.decimals,
        Some(&[seeds]),
    )?;

    let position = &mut ctx.accounts.position;
    position.strike_quote_escrowed = 0;
    position.settled_at = Clock::get()?.unix_timestamp;
    position.status = PositionStatus::Cancelled;

    emit!(CommitmentCancelled {
        position: position_key,
        maker: position.maker,
        quote_returned: amount,
    });
    Ok(())
}
