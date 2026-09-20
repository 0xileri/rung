use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, TransferChecked};

/// `transfer_checked` against either SPL Token or Token-2022, optionally PDA-signed.
///
/// Always the checked variant: it validates the mint and decimals on-chain, which is what
/// makes substituting a lookalike mint fail rather than silently settle.
///
/// The caller must treat `amount` as the amount *debited from the source*, not the amount
/// credited to the destination. Under a Token-2022 transfer fee those differ, and every
/// caller that escrows collateral measures the destination's balance delta instead of
/// assuming they are equal.
#[allow(clippy::too_many_arguments)]
pub fn transfer_tokens<'info>(
    token_program: AccountInfo<'info>,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<()> {
    let accounts = TransferChecked {
        from,
        mint,
        to,
        authority,
    };
    match signer_seeds {
        Some(seeds) => transfer_checked(
            CpiContext::new_with_signer(token_program, accounts, seeds),
            amount,
            decimals,
        ),
        None => transfer_checked(CpiContext::new(token_program, accounts), amount, decimals),
    }
}
