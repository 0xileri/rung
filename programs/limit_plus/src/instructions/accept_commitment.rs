use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::LimitPlusError;
use crate::state::{CommitmentMatched, GlobalConfig, Market, Position, PositionStatus};
use crate::utils::transfer_tokens;

#[derive(Accounts)]
pub struct AcceptCommitment<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        seeds = [MARKET_SEED, position.stock_mint.as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [POSITION_SEED, position.maker.as_ref(), &position.nonce.to_le_bytes()],
        bump = position.bump,
        has_one = stock_mint @ LimitPlusError::InvalidStockMint,
        has_one = quote_mint @ LimitPlusError::InvalidQuoteMint,
    )]
    pub position: Account<'info, Position>,

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
        token::mint = stock_mint,
        token::authority = taker,
        token::token_program = stock_token_program,
    )]
    pub taker_stock_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = taker,
        token::token_program = quote_token_program,
    )]
    pub taker_quote_account: InterfaceAccount<'info, TokenAccount>,

    /// Premium lands here directly. The protocol never takes custody of it, so there is no
    /// path by which a matched maker fails to be paid.
    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = position.maker,
        token::token_program = quote_token_program,
    )]
    pub maker_quote_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = stock_mint,
        associated_token::authority = position_authority,
        associated_token::token_program = stock_token_program,
    )]
    pub stock_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = stock_token_program.key() == market.token_program @ LimitPlusError::InvalidTokenProgram,
    )]
    pub stock_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

/// Take the other side: lock stock, pay the premium, and start the protection term.
///
/// `stock_raw_to_send` is what leaves the taker's account, which under a Token-2022 transfer
/// fee is strictly more than what arrives. The protocol refuses to guess the difference:
/// it measures the vault's balance delta and requires the result to clear
/// `stock_raw_required`. Equality is unachievable with a fee, but a floor is both achievable
/// and sufficient, and it is the check that makes under-collateralization impossible.
///
/// Because the fee rate can step at an epoch boundary between quoting and signing, clients
/// should gross up against the *higher* of the mint's two fee slots. The transfer then
/// clears on either side of the rollover, and any excess simply rides along with the stock.
pub fn handler(ctx: Context<AcceptCommitment>, stock_raw_to_send: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, LimitPlusError::GlobalPause);
    require!(
        ctx.accounts.market.accept_enabled,
        LimitPlusError::MarketAcceptDisabled
    );
    require!(
        ctx.accounts.position.status == PositionStatus::Open,
        LimitPlusError::InvalidState
    );

    let now = Clock::get()?.unix_timestamp;
    require!(
        !ctx.accounts.position.is_expired(now),
        LimitPlusError::PositionExpired
    );

    let required = ctx.accounts.position.stock_raw_required;
    let before = ctx.accounts.stock_vault.amount;
    transfer_tokens(
        ctx.accounts.stock_token_program.to_account_info(),
        ctx.accounts.taker_stock_account.to_account_info(),
        ctx.accounts.stock_mint.to_account_info(),
        ctx.accounts.stock_vault.to_account_info(),
        ctx.accounts.taker.to_account_info(),
        stock_raw_to_send,
        ctx.accounts.stock_mint.decimals,
        None,
    )?;
    ctx.accounts.stock_vault.reload()?;
    let escrowed = ctx
        .accounts
        .stock_vault
        .amount
        .checked_sub(before)
        .ok_or(LimitPlusError::MathOverflow)?;
    require!(escrowed >= required, LimitPlusError::InsufficientCollateral);

    let premium = ctx.accounts.position.premium_quote_amount;
    if premium > 0 {
        transfer_tokens(
            ctx.accounts.quote_token_program.to_account_info(),
            ctx.accounts.taker_quote_account.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.maker_quote_account.to_account_info(),
            ctx.accounts.taker.to_account_info(),
            premium,
            ctx.accounts.quote_mint.decimals,
            None,
        )?;
    }

    let position_key = ctx.accounts.position.key();
    let position = &mut ctx.accounts.position;
    position.taker = ctx.accounts.taker.key();
    position.stock_raw_escrowed = escrowed;
    position.matched_at = now;
    position.status = PositionStatus::Matched;

    emit!(CommitmentMatched {
        position: position_key,
        maker: position.maker,
        taker: position.taker,
        stock_raw_sent: stock_raw_to_send,
        stock_raw_escrowed: escrowed,
        premium_paid: premium,
        matched_at: now,
    });
    Ok(())
}
