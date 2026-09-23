use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::RungError;
use crate::state::{CommitmentMatched, Fill, FillStatus, GlobalConfig, Market, Position};
use crate::utils::{has_transfer_hook, mul_div_ceil, mul_div_floor, transfer_tokens};

#[derive(Accounts)]
pub struct AcceptCommitment<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        seeds = [MARKET_SEED, position.stock_mint.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [POSITION_SEED, position.maker.as_ref(), &position.nonce.to_le_bytes()],
        bump = position.bump,
        has_one = stock_mint @ RungError::InvalidStockMint,
        has_one = quote_mint @ RungError::InvalidQuoteMint,
    )]
    pub position: Box<Account<'info, Position>>,

    /// This taker's claim on the commitment. Indexed by `position.fills_created`, which only
    /// ever increases, so a settled fill's address is never handed out again.
    #[account(
        init,
        payer = taker,
        space = 8 + Fill::INIT_SPACE,
        seeds = [FILL_SEED, position.key().as_ref(), &position.fills_created.to_le_bytes()],
        bump,
    )]
    pub fill: Box<Account<'info, Fill>>,

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
        token::mint = stock_mint,
        token::authority = taker,
        token::token_program = stock_token_program,
    )]
    pub taker_stock_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = taker,
        token::token_program = quote_token_program,
    )]
    pub taker_quote_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The premium lands here directly. The protocol never takes custody of it, so there is
    /// no path by which a matched maker fails to be paid.
    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = position.maker,
        token::token_program = quote_token_program,
    )]
    pub maker_quote_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The protocol's cut of the premium. Created on demand so a treasury that has never
    /// held the quote mint cannot make matching fail.
    ///
    /// `dup`, because the treasury can legitimately be one of the parties: an admin who
    /// makes markets from the treasury wallet makes this the same account as
    /// `maker_quote_account`, and Anchor would otherwise refuse every match against their
    /// commitments. The refusal exists to stop two copies of one program-owned account being
    /// written back on exit; a token account is owned by the token program and never written
    /// back here, and both credits go through its CPI, which handles a repeated destination.
    #[account(
        init_if_needed,
        dup,
        payer = taker,
        associated_token::mint = quote_mint,
        associated_token::authority = fee_treasury,
        associated_token::token_program = quote_token_program,
    )]
    pub fee_treasury_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Fee recipient, pinned to the configured treasury; it only owns the account above.
    #[account(address = config.fee_treasury)]
    pub fee_treasury: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = stock_mint,
        associated_token::authority = position_authority,
        associated_token::token_program = stock_token_program,
    )]
    pub stock_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        constraint = stock_token_program.key() == market.token_program @ RungError::InvalidTokenProgram,
    )]
    pub stock_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Take part or all of a commitment: lock stock, pay the premium, start the protection term.
///
/// `fill_strike_quote` is how much of the maker's escrowed USDC this taker claims. Everything
/// else about the fill is that fraction of the maker's terms, rounded in the maker's favour
/// (docs/fills.md). Passing the whole open amount is the ordinary full take.
///
/// `stock_raw_to_send` is what leaves the taker's account, which under a Token-2022 transfer
/// fee is strictly more than what arrives. The protocol refuses to guess the difference:
/// it measures the vault's balance delta and requires the result to clear this fill's
/// requirement. Equality is unachievable with a fee, but a floor is both achievable and
/// sufficient, and it is the check that makes under-collateralization impossible.
///
/// Because the fee rate can step at an epoch boundary between quoting and signing, clients
/// should gross up against the *higher* of the mint's two fee slots. The transfer then
/// clears on either side of the rollover, and any excess simply rides along with the stock.
pub fn accept_commitment(
    ctx: Context<AcceptCommitment>,
    stock_raw_to_send: u64,
    fill_strike_quote: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, RungError::GlobalPause);
    require!(
        ctx.accounts.market.accept_enabled,
        RungError::MarketAcceptDisabled
    );
    // Harmless to the maker's funds, but it would print a "matched" position that no second
    // party ever agreed to, which is exactly what the curve must not be able to show.
    require!(
        ctx.accounts.taker.key() != ctx.accounts.position.maker,
        RungError::SelfMatch
    );
    require!(
        !has_transfer_hook(&ctx.accounts.stock_mint.to_account_info())?,
        RungError::TransferHookSet
    );

    let now = Clock::get()?.unix_timestamp;
    require!(
        !ctx.accounts.position.is_expired(now),
        RungError::PositionExpired
    );

    let open = ctx.accounts.position.strike_quote_open;
    require!(open > 0, RungError::NothingOpen);
    require!(fill_strike_quote > 0, RungError::InvalidAmount);
    require!(fill_strike_quote <= open, RungError::FillExceedsOpen);

    // Dust rules: a fill is either large enough to be worth settling, or it clears the
    // commitment entirely; and what it leaves behind must itself be takeable.
    let remainder = open - fill_strike_quote;
    let min_fill = ctx.accounts.config.min_fill_quote;
    require!(
        fill_strike_quote >= min_fill || remainder == 0,
        RungError::FillTooSmall
    );
    require!(
        remainder == 0 || remainder >= min_fill,
        RungError::FillRemainderTooSmall
    );

    let total_quote = ctx.accounts.position.strike_quote_escrowed;
    let required = mul_div_ceil(
        ctx.accounts.position.stock_raw_required,
        fill_strike_quote,
        total_quote,
    )?;
    let premium = mul_div_ceil(
        ctx.accounts.position.premium_quote_amount,
        fill_strike_quote,
        total_quote,
    )?;

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
        .ok_or(RungError::MathOverflow)?;
    require!(escrowed >= required, RungError::InsufficientCollateral);

    // The fee comes out of the premium, never out of collateral: a misconfigured fee can pay
    // a maker less than they hoped, but it can never leave a position unable to settle.
    let fee = mul_div_floor(
        premium,
        u64::from(ctx.accounts.config.fee_bps),
        BPS_DENOMINATOR,
    )?;
    let to_maker = premium.checked_sub(fee).ok_or(RungError::MathOverflow)?;

    if to_maker > 0 {
        transfer_tokens(
            ctx.accounts.quote_token_program.to_account_info(),
            ctx.accounts.taker_quote_account.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.maker_quote_account.to_account_info(),
            ctx.accounts.taker.to_account_info(),
            to_maker,
            ctx.accounts.quote_mint.decimals,
            None,
        )?;
    }
    if fee > 0 {
        transfer_tokens(
            ctx.accounts.quote_token_program.to_account_info(),
            ctx.accounts.taker_quote_account.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.fee_treasury_account.to_account_info(),
            ctx.accounts.taker.to_account_info(),
            fee,
            ctx.accounts.quote_mint.decimals,
            None,
        )?;
    }

    let position_key = ctx.accounts.position.key();
    let fill_key = ctx.accounts.fill.key();
    let index = ctx.accounts.position.fills_created;

    let fill = &mut ctx.accounts.fill;
    fill.position = position_key;
    fill.taker = ctx.accounts.taker.key();
    fill.index = index;
    fill.strike_quote_amount = fill_strike_quote;
    fill.stock_raw_required = required;
    fill.stock_raw_escrowed = escrowed;
    fill.premium_paid = premium;
    fill.fee_paid = fee;
    fill.matched_at = now;
    fill.settled_at = 0;
    fill.status = FillStatus::Matched;
    fill.bump = ctx.bumps.fill;

    let position = &mut ctx.accounts.position;
    position.strike_quote_open = remainder;
    position.stock_raw_escrowed = position
        .stock_raw_escrowed
        .checked_add(escrowed)
        .ok_or(RungError::MathOverflow)?;
    position.fills_created = position
        .fills_created
        .checked_add(1)
        .ok_or(RungError::MathOverflow)?;
    position.fills_open = position
        .fills_open
        .checked_add(1)
        .ok_or(RungError::MathOverflow)?;
    if position.first_matched_at == 0 {
        position.first_matched_at = now;
    }
    position.status = position.derive_status();

    emit!(CommitmentMatched {
        position: position_key,
        fill: fill_key,
        maker: position.maker,
        taker: ctx.accounts.taker.key(),
        fill_index: index,
        strike_quote_amount: fill_strike_quote,
        stock_raw_sent: stock_raw_to_send,
        stock_raw_escrowed: escrowed,
        premium_paid: premium,
        fee_paid: fee,
        strike_quote_open: remainder,
        matched_at: now,
    });
    Ok(())
}
