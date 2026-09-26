use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::RungError;
use crate::state::{Fill, FillStatus, Position, PositionExpiredEvent};
use crate::utils::transfer_tokens;

#[derive(Accounts)]
pub struct ExpireFill<'info> {
    /// Anyone. They pay the transaction fee and any rent for the receiving accounts.
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [POSITION_SEED, position.maker.as_ref(), &position.nonce.to_le_bytes()],
        bump = position.bump,
        has_one = stock_mint @ RungError::InvalidStockMint,
        has_one = quote_mint @ RungError::InvalidQuoteMint,
    )]
    pub position: Box<Account<'info, Position>>,

    /// Left in place once settled, as the record of how this fill ended. Its rent goes back
    /// to the taker through `close_fill`, never to whoever happened to crank the expiry.
    #[account(
        mut,
        seeds = [FILL_SEED, position.key().as_ref(), &fill.index.to_le_bytes()],
        bump = fill.bump,
        has_one = position @ RungError::InvalidState,
        has_one = taker @ RungError::Unauthorized,
    )]
    pub fill: Box<Account<'info, Fill>>,

    /// CHECK: Receives the returned USDC; ownership enforced by the ATA constraint below.
    #[account(mut, address = position.maker)]
    pub maker: UncheckedAccount<'info>,

    /// CHECK: Receives the returned stock and the fill's rent; ownership enforced below.
    #[account(mut, address = fill.taker)]
    pub taker: UncheckedAccount<'info>,

    /// CHECK: Vault authority PDA, validated by seeds.
    #[account(
        seeds = [POSITION_AUTHORITY_SEED, position.key().as_ref()],
        bump = position.authority_bump,
    )]
    pub position_authority: UncheckedAccount<'info>,

    pub stock_mint: Box<InterfaceAccount<'info, Mint>>,
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
        associated_token::mint = stock_mint,
        associated_token::authority = position_authority,
        associated_token::token_program = stock_token_program,
    )]
    pub stock_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = quote_mint,
        associated_token::authority = maker,
        associated_token::token_program = quote_token_program,
    )]
    pub maker_quote_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = stock_mint,
        associated_token::authority = taker,
        associated_token::token_program = stock_token_program,
    )]
    pub taker_stock_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub stock_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Unwind one fill whose protection window has closed, returning both sides their own
/// collateral. The maker keeps the premium either way.
///
/// Permissionless by design. If only the counterparties could trigger it, recovering your
/// own collateral would depend on someone else staying reachable and willing; anyone can
/// crank this, so neither side can strand the other by disappearing. Like exercise, it
/// ignores the pause and market flags: an administrative switch must never be able to trap
/// collateral that is already owed back.
///
/// The maker's unmatched remainder is not touched here. That capital was never claimed by a
/// taker, and `cancel_commitment` returns it whenever the maker asks.
pub fn expire_fill(ctx: Context<ExpireFill>) -> Result<()> {
    require!(
        ctx.accounts.fill.status == FillStatus::Matched,
        RungError::InvalidState
    );

    let now = Clock::get()?.unix_timestamp;
    require!(
        ctx.accounts.position.is_expired(now),
        RungError::PositionNotExpired
    );

    let quote_amount = ctx.accounts.fill.strike_quote_amount;
    let stock_amount = ctx.accounts.fill.stock_raw_escrowed;
    let position_key = ctx.accounts.position.key();
    let fill_key = ctx.accounts.fill.key();
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

    let taker = ctx.accounts.fill.taker;
    let fill = &mut ctx.accounts.fill;
    fill.settled_at = now;
    fill.status = FillStatus::Expired;

    let position = &mut ctx.accounts.position;
    position.stock_raw_escrowed = position
        .stock_raw_escrowed
        .checked_sub(stock_amount)
        .ok_or(RungError::MathOverflow)?;
    position.fills_open = position
        .fills_open
        .checked_sub(1)
        .ok_or(RungError::MathOverflow)?;
    position.settled_at = now;
    position.status = position.derive_status();

    emit!(PositionExpiredEvent {
        position: position_key,
        fill: fill_key,
        maker: position.maker,
        taker,
        quote_to_maker: quote_amount,
        stock_to_taker: stock_amount,
        settled_at: now,
    });
    Ok(())
}
