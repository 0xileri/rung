# Partial fills

A commitment is an offer of capital at a valuation. Until this change it could only be taken
whole, by one holder, in one transaction. That made the book look deeper than it was usable:
a holder with a third of the size a maker offered had to walk past it.

Partial fills split the *taking*, never the *offer*. The maker's terms — strike, premium rate,
expiry, valuation — are fixed at creation and every fill inherits them pro rata. What changes
is that several holders can each take a slice, and the unmatched remainder stays open.

## Shape

One `Position` is the maker's commitment and owns the two vaults, as before. Each taker gets
their own `Fill` account recording what they locked and what they may claim. Collateral stays
in the commitment's vaults; a fill is a claim on part of it.

```
Position (maker's offer, owns quote_vault + stock_vault)
 ├─ Fill #0  taker A   strike 40 USDC   stock 0.05 OPENAI
 ├─ Fill #1  taker B   strike 35 USDC   stock 0.043 OPENAI
 └─ open remainder     strike 25 USDC
```

The alternative — splitting the position into a child account per fill, each with its own pair
of vaults — costs two extra token accounts in rent per fill and moves escrowed money between
vaults on every match. Fills avoid both: nothing moves on a match except the incoming stock.

## Pro rata, and which way rounding goes

A fill is sized by the quote it claims, `fill_strike`, against `strike_quote_escrowed`, the
USDC actually measured into the vault at creation. Everything else follows:

```
stock_required = ceil(stock_raw_required   × fill_strike / strike_quote_escrowed)
premium        = ceil(premium_quote_amount × fill_strike / strike_quote_escrowed)
```

Both round **up**, so a taker never obtains a claim on the vault more cheaply by splitting it
into many small fills than by taking it whole. Rounding up is the direction that cannot be
farmed: the sum of any partition of a commitment is at least the whole.

The denominator is the *measured* escrow, not the requested `strike_quote_amount`, so claims
are always denominated in money that is actually in the vault.

## Dust

Two rules keep the book from filling with unusable crumbs, both against
`config.min_fill_quote`:

1. a fill must be at least `min_fill_quote`, unless it takes the entire remaining open amount;
2. what it leaves behind must be zero or at least `min_fill_quote`.

Together they mean every open commitment on the curve is takeable, and a taker can always
clear a commitment completely no matter how small the remainder is.

## Settlement

Settlement is per fill and unchanged in character: `exercise_fill` swaps that fill's escrowed
stock for that fill's claim on the quote vault, and `expire_fill` returns each side its own.
No oracle, no admin, and expiry stays permissionless. One taker exercising says nothing about
another: fills are independent claims that happen to share a vault.

The invariant the program maintains, and the tests assert, is:

```
quote_vault.amount  ≥  strike_quote_open + Σ (open fills' strike_quote_amount)
stock_vault.amount  ≥  Σ (open fills' stock_raw_escrowed)
```

Settling a fill decreases both sides of its line by exactly the amounts recorded on that fill,
so no fill can be paid with another fill's collateral, and the last one out cannot be short.

## Cancelling

`cancel_commitment` now withdraws the open remainder rather than requiring an untouched
commitment. Unmatched capital was never promised to anyone, so a maker may pull it at any
time; capital already matched to a fill stays locked for the term, exactly as before.

## Fees

`config.fee_bps` takes a cut of the **premium** at match, capped at `MAX_FEE_BPS`, and sends
it to the fee treasury's token account. The taker's cost is unchanged; the maker receives
`premium − fee`. The fee never touches escrowed collateral, so a fee misconfiguration cannot
make a position unsettleable — the worst it can do is pay a maker less than they expected,
which they can see before they commit.

## Status

`Position.status` now carries the filling state:

| status            | meaning                                          |
| ----------------- | ------------------------------------------------ |
| `Open`            | nothing taken yet                                |
| `PartiallyMatched`| some taken, some still open                      |
| `Matched`         | fully taken, fills outstanding                   |
| `Settled`         | nothing open, every fill settled                 |
| `Cancelled`       | withdrawn before any fill                        |

`Fill.status` is `Matched`, `Exercised` or `Expired`, and a settled fill's account is closed,
returning its rent to the taker who paid it.
