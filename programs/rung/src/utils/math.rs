use anchor_lang::prelude::*;

use crate::errors::RungError;

/// `ceil(value × numerator / denominator)` in u128, back down to u64.
///
/// Used for every pro-rata figure a fill owes: rounding up is the direction a taker cannot
/// farm, because the sum over any partition of a commitment is then at least the whole.
pub fn mul_div_ceil(value: u64, numerator: u64, denominator: u64) -> Result<u64> {
    require!(denominator > 0, RungError::MathOverflow);
    let product = (value as u128)
        .checked_mul(numerator as u128)
        .ok_or(RungError::MathOverflow)?;
    let ceiled = product
        .checked_add(denominator as u128 - 1)
        .ok_or(RungError::MathOverflow)?
        / denominator as u128;
    u64::try_from(ceiled).map_err(|_| RungError::MathOverflow.into())
}

/// `floor(value × numerator / denominator)` in u128, back down to u64.
///
/// The protocol's own cut rounds down, so rounding never invents a fee the premium cannot
/// cover.
pub fn mul_div_floor(value: u64, numerator: u64, denominator: u64) -> Result<u64> {
    require!(denominator > 0, RungError::MathOverflow);
    let product = (value as u128)
        .checked_mul(numerator as u128)
        .ok_or(RungError::MathOverflow)?;
    u64::try_from(product / denominator as u128).map_err(|_| RungError::MathOverflow.into())
}
