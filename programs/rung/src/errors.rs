use anchor_lang::prelude::*;

#[error_code]
pub enum RungError {
    #[msg("Market is not registered for this stock mint")]
    InvalidMarket,
    #[msg("Market is disabled for new commitments")]
    MarketDisabled,
    #[msg("Market is disabled for new matches")]
    MarketAcceptDisabled,
    #[msg("Position is not in the required state for this action")]
    InvalidState,
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Expiry must be between the minimum and maximum horizon")]
    InvalidExpiry,
    #[msg("Position has passed its expiry")]
    PositionExpired,
    #[msg("Position has not yet reached its expiry")]
    PositionNotExpired,
    #[msg("Stock mint does not match the position")]
    InvalidStockMint,
    #[msg("Quote mint does not match the protocol quote mint")]
    InvalidQuoteMint,
    #[msg("Token program does not match the one registered for this market")]
    InvalidTokenProgram,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Vault received less collateral than the position requires")]
    InsufficientCollateral,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Protocol is paused for new commitments and matches")]
    GlobalPause,
    #[msg("Symbol exceeds the maximum length")]
    SymbolTooLong,
    // New variants go last: codes are positional, and clients already map the ones above.
    #[msg("Strike exceeds the per-position cap")]
    StrikeAboveCap,
    #[msg("Stock mint has a transfer hook set, which this program cannot yet settle through")]
    TransferHookSet,
    #[msg("A maker cannot take the other side of their own commitment")]
    SelfMatch,
}
