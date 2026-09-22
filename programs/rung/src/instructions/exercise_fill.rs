use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::RungError;
use crate::state::{Fill, FillStatus, Position, PositionExercised};
use crate::utils::transfer_tokens;

#[derive(Accounts)]
pub struct ExerciseFill<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        mut,
        seeds = [POSITION_SEED, position.maker.as_ref(), &position.nonce.to_le_bytes()],
        bump = position.bump,
        has_one = stock_mint @ RungError::InvalidStockMint,
        has_one = quote_mint @ RungError::InvalidQuoteMint,
    )]
    pub position: Box<Account<'info, Position>>,

    /// Left in place once settled, as the record that this holder held this protection and
    /// how it ended. `close_fill` returns its rent whenever the taker asks.
    #[account(
        mut,
        seeds = [FILL_SEED, position.key().as_ref(), &fill.index.to_le_bytes()],
        bump = fill.bump,
        has_one = position @ RungError::InvalidState,
        has_one = taker @ RungError::Unauthorized,
    )]
    pub fill: Box<Account<'info, Fill>>,

    /// CHECK: Vault authority PDA, validated by seeds.
    #[account(
        seeds = [POSITION_AUTHORITY_SEED, position.key().as_ref()],
        bump = position.authority_bump,
    )]
    pub position_authority: UncheckedAccount<'info>,

    /// CHECK: Read only to receive stock; ownership is enforced by the ATA constraint below.
    #[account(address = position.maker)]
    pub maker: UncheckedAccount<'info>,

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
        mut,
        token::mint = quote_mint,
        token::authority = taker,
        token::token_program = quote_token_program,
    )]
    pub taker_quote_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The maker may never have held this PreStock before, so the receiving account is
    /// created on demand rather than making exercise fail on a missing account.
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = stock_mint,
        associated_token::authority = maker,
        associated_token::token_program = stock_token_program,
    )]
    pub maker_stock_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub stock_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Exchange this fill's escrowed stock for this fill's claim on the escrowed USDC, atomically.
///
/// Note what this instruction does not consult: no oracle, no price feed, no backend
/// authorization, and no market or pause flag. The holder bought a contractual right to
/// this exchange and only they decide whether taking it is rational, so the program has no
/// judgement to make and nothing to look up. Loading the market here would also mean an
/// admin could block a settlement the counterparty already paid for.
///
/// Both legs move in one instruction, so there is no intermediate state in which one side
/// has been paid and the other has not. Fills sharing a vault stay independent: this pays
/// only the amounts recorded on this fill, so one taker's exercise can never reach another's
/// collateral.
pub fn exercise_fill(ctx: Context<ExerciseFill>) -> Result<()> {
    require!(
        ctx.accounts.fill.status == FillStatus::Matched,
        RungError::InvalidState
    );

    let now = Clock::get()?.unix_timestamp;
    require!(
        !ctx.accounts.position.is_expired(now),
        RungError::PositionExpired
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
        ctx.accounts.taker_quote_account.to_account_info(),
        ctx.accounts.position_authority.to_account_info(),
        quote_amount,
        ctx.accounts.quote_mint.decimals,
        Some(&[seeds]),
    )?;

    transfer_tokens(
        ctx.accounts.stock_token_program.to_account_info(),
        ctx.accounts.stock_vault.to_account_info(),
        ctx.accounts.stock_mint.to_account_info(),
        ctx.accounts.maker_stock_account.to_account_info(),
        ctx.accounts.position_authority.to_account_info(),
        stock_amount,
        ctx.accounts.stock_mint.decimals,
        Some(&[seeds]),
    )?;

    let taker = ctx.accounts.fill.taker;
    let fill = &mut ctx.accounts.fill;
    fill.settled_at = now;
    fill.status = FillStatus::Exercised;

    let position = &mut ctx.accounts.position;
    position.stock_raw_escrowed = position
        .stock_raw_escrowed
        .checked_sub(stock_amount)
        .ok_or(RungError::MathOverflow)?;
    // `strike_quote_escrowed` is deliberately left alone: it is the fixed denominator every
    // fill was sized against, not a running balance. Shrinking it here would silently
    // re-price the fills that come after this one.
    position.fills_open = position
        .fills_open
        .checked_sub(1)
        .ok_or(RungError::MathOverflow)?;
    position.settled_at = now;
    position.status = position.derive_status();

    emit!(PositionExercised {
        position: position_key,
        fill: fill_key,
        maker: position.maker,
        taker,
        quote_to_taker: quote_amount,
        stock_to_maker: stock_amount,
        settled_at: now,
    });
    Ok(())
}
