use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::RungError;
use crate::state::{CommitmentCreated, GlobalConfig, Market, Position, PositionStatus};
use crate::utils::{has_transfer_hook, transfer_tokens};

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateCommitment<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        seeds = [MARKET_SEED, stock_mint.key().as_ref()],
        bump = market.bump,
        constraint = market.stock_mint == stock_mint.key() @ RungError::InvalidMarket,
        constraint = market.token_program == stock_token_program.key() @ RungError::InvalidTokenProgram,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = maker,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, maker.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub position: Box<Account<'info, Position>>,

    /// CHECK: Vault authority PDA. Carries no data; it exists so the vaults are owned by a
    /// program-derived authority rather than any keypair a human could hold.
    #[account(
        seeds = [POSITION_AUTHORITY_SEED, position.key().as_ref()],
        bump,
    )]
    pub position_authority: UncheckedAccount<'info>,

    pub stock_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(constraint = quote_mint.key() == config.quote_mint @ RungError::InvalidQuoteMint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = maker,
        token::token_program = quote_token_program,
    )]
    pub maker_quote_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = maker,
        associated_token::mint = quote_mint,
        associated_token::authority = position_authority,
        associated_token::token_program = quote_token_program,
    )]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Created now, while the maker is already paying rent, so accepting is a single
    /// transfer for the taker and cannot fail on a missing vault.
    #[account(
        init,
        payer = maker,
        associated_token::mint = stock_mint,
        associated_token::authority = position_authority,
        associated_token::token_program = stock_token_program,
    )]
    pub stock_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub stock_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_commitment(
    ctx: Context<CreateCommitment>,
    nonce: u64,
    stock_raw_required: u64,
    strike_quote_amount: u64,
    premium_quote_amount: u64,
    expiry_ts: i64,
    target_valuation_usd: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, RungError::GlobalPause);
    require!(ctx.accounts.market.enabled, RungError::MarketDisabled);
    require!(stock_raw_required > 0, RungError::InvalidAmount);
    require!(strike_quote_amount > 0, RungError::InvalidAmount);

    let cap = 10u64
        .checked_pow(u32::from(ctx.accounts.quote_mint.decimals))
        .and_then(|unit| unit.checked_mul(MAX_STRIKE_WHOLE_UNITS))
        .ok_or(RungError::MathOverflow)?;
    require!(strike_quote_amount <= cap, RungError::StrikeAboveCap);
    require!(
        !has_transfer_hook(&ctx.accounts.stock_mint.to_account_info())?,
        RungError::TransferHookSet
    );

    // Clock, not a client-supplied timestamp: expiry decides who ends up owning the
    // collateral, so it must be measured against something the caller cannot influence.
    let now = Clock::get()?.unix_timestamp;
    let horizon = expiry_ts
        .checked_sub(now)
        .ok_or(RungError::MathOverflow)?;
    require!(
        (MIN_EXPIRY_HORIZON_SECS..=MAX_EXPIRY_HORIZON_SECS).contains(&horizon),
        RungError::InvalidExpiry
    );

    // Measure rather than assume. USDC carries no transfer fee today, but reading the
    // balance delta means a quote mint that ever gains one cannot quietly under-fund a
    // position, and it keeps both collateral paths identical.
    let before = ctx.accounts.quote_vault.amount;
    transfer_tokens(
        ctx.accounts.quote_token_program.to_account_info(),
        ctx.accounts.maker_quote_account.to_account_info(),
        ctx.accounts.quote_mint.to_account_info(),
        ctx.accounts.quote_vault.to_account_info(),
        ctx.accounts.maker.to_account_info(),
        strike_quote_amount,
        ctx.accounts.quote_mint.decimals,
        None,
    )?;
    ctx.accounts.quote_vault.reload()?;
    let escrowed = ctx
        .accounts
        .quote_vault
        .amount
        .checked_sub(before)
        .ok_or(RungError::MathOverflow)?;
    require!(
        escrowed >= strike_quote_amount,
        RungError::InsufficientCollateral
    );

    let position = &mut ctx.accounts.position;
    position.maker = ctx.accounts.maker.key();
    position.stock_mint = ctx.accounts.stock_mint.key();
    position.quote_mint = ctx.accounts.quote_mint.key();
    position.stock_token_program = ctx.accounts.stock_token_program.key();
    position.quote_token_program = ctx.accounts.quote_token_program.key();
    position.nonce = nonce;
    position.stock_raw_required = stock_raw_required;
    position.stock_raw_escrowed = 0;
    position.strike_quote_amount = strike_quote_amount;
    position.strike_quote_escrowed = escrowed;
    // Every fill is sized against what actually arrived, so the open amount starts there too.
    position.strike_quote_open = escrowed;
    position.premium_quote_amount = premium_quote_amount;
    position.expiry_ts = expiry_ts;
    position.created_at = now;
    position.first_matched_at = 0;
    position.settled_at = 0;
    position.target_valuation_usd = target_valuation_usd;
    position.fills_created = 0;
    position.fills_open = 0;
    position.status = PositionStatus::Open;
    position.bump = ctx.bumps.position;
    position.authority_bump = ctx.bumps.position_authority;

    emit!(CommitmentCreated {
        position: position.key(),
        maker: position.maker,
        stock_mint: position.stock_mint,
        stock_raw_required,
        strike_quote_escrowed: escrowed,
        premium_quote_amount,
        target_valuation_usd,
        expiry_ts,
    });
    Ok(())
}
