use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::LimitPlusError;
use crate::state::{Position, PositionExpiredEvent, PositionStatus};
use crate::utils::transfer_tokens;

#[derive(Accounts)]
pub struct ExpirePosition<'info> {
    /// Anyone. They pay the transaction fee and any rent for the receiving accounts.
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [POSITION_SEED, position.maker.as_ref(), &position.nonce.to_le_bytes()],
        bump = position.bump,
        has_one = stock_mint @ LimitPlusError::InvalidStockMint,
        has_one = quote_mint @ LimitPlusError::InvalidQuoteMint,
    )]
    pub position: Account<'info, Position>,

    /// CHECK: Receives the returned USDC; ownership enforced by the ATA constraint below.
    #[account(address = position.maker)]
    pub maker: UncheckedAccount<'info>,

    /// CHECK: Receives the returned stock; ownership enforced by the ATA constraint below.
    #[account(address = position.taker)]
    pub taker: UncheckedAccount<'info>,

    /// CHECK: Vault authority PDA, validated by seeds.
    #[account(
        seeds = [POSITION_AUTHORITY_SEED, position.key().as_ref()],
        bump = position.authority_bump,
    )]
    pub position_authority: UncheckedAccount<'info>,

    pub stock_mint: InterfaceAccount<'info, Mint>,
    pub quote_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = position_authority,
        associated_token::token_program = quote_token_program,
    )]
    pub quote_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = stock_mint,
        associated_token::authority = position_authority,
        associated_token::token_program = stock_token_program,
    )]
    pub stock_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = quote_mint,
        associated_token::authority = maker,
        associated_token::token_program = quote_token_program,
    )]
    pub maker_quote_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = stock_mint,
        associated_token::authority = taker,
        associated_token::token_program = stock_token_program,
    )]
    pub taker_stock_account: InterfaceAccount<'info, TokenAccount>,

    pub stock_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Unwind a position whose protection window has closed, returning both sides their own
/// collateral. The maker keeps the premium either way.
///
/// Permissionless by design. If only the counterparties could trigger it, recovering your
/// own collateral would depend on someone else staying reachable and willing; anyone can
/// crank this, so neither side can strand the other by disappearing. Like exercise, it
/// ignores the pause and market flags: an administrative switch must never be able to trap
/// collateral that is already owed back.
pub fn handler(ctx: Context<ExpirePosition>) -> Result<()> {
    require!(
        ctx.accounts.position.status == PositionStatus::Matched,
        LimitPlusError::InvalidState
    );

    let now = Clock::get()?.unix_timestamp;
    require!(
        ctx.accounts.position.is_expired(now),
        LimitPlusError::PositionNotExpired
    );

    let quote_amount = ctx.accounts.position.strike_quote_escrowed;
    let stock_amount = ctx.accounts.position.stock_raw_escrowed;
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
        quote_amount,
        ctx.accounts.quote_mint.decimals,
        Some(&[seeds]),
    )?;

    transfer_tokens(
        ctx.accounts.stock_token_program.to_account_info(),
        ctx.accounts.stock_vault.to_account_info(),
        ctx.accounts.stock_mint.to_account_info(),
        ctx.accounts.taker_stock_account.to_account_info(),
        ctx.accounts.position_authority.to_account_info(),
        stock_amount,
        ctx.accounts.stock_mint.decimals,
        Some(&[seeds]),
    )?;

    let position = &mut ctx.accounts.position;
    position.strike_quote_escrowed = 0;
    position.stock_raw_escrowed = 0;
    position.settled_at = now;
    position.status = PositionStatus::Expired;

    emit!(PositionExpiredEvent {
        position: position_key,
        maker: position.maker,
        taker: position.taker,
        quote_to_maker: quote_amount,
        stock_to_taker: stock_amount,
        settled_at: now,
    });
    Ok(())
}
