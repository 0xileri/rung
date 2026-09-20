# Known limitations

Written plainly rather than buried. Several of these are properties of the PreStocks mints
themselves, verified on mainnet, and they qualify claims a reader would otherwise take at
face value.

## The collateral is not trustless

Every matched position is fully collateralized in the sense that both legs sit in
program-controlled vaults and no Rung key can move them. That is worth something, but it
is not the whole story, and "100% collateralized" on its own would overstate it.

The OpenAI PreStock mint (`PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF`) grants its issuer:

| Power | Consequence for an escrowed position |
|---|---|
| `permanentDelegate` | The issuer can transfer tokens **out of the program's vault** without the program's consent. |
| `freezeAuthority` | The issuer can freeze the vault account, blocking settlement. |
| `pausableConfig` | The issuer can pause all transfers of the mint, so exercise and expiry cannot execute. |

All three are held by `WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc`. No on-chain program can
defend against them, because they are properties of the token, not of this protocol. A
holder of a PreStock is already exposed to these; escrowing it here does not add the risk,
but it does not remove it either.

The UI derives this disclosure list from live chain state (`custodyCaveats` in the SDK)
rather than hardcoding it, so if the issuer ever relinquishes a power the claim tightens
automatically instead of going stale.

The pause case has a sharper edge worth naming: if transfers are paused across a position's
expiry, the holder can lose their exercise window through no fault of their own. The
protocol does not currently extend the deadline to compensate.

## Transfer fees make the round trip lossy

PreStocks mints charge a transfer fee, so an amount sent is never the amount that arrives.
Collateral passes through a vault twice — in on match, out on settlement — and is charged
both times. At the time of writing the fee was 50 bps, stepping to 100 bps at epoch 1039,
giving a round-trip cost of roughly 1% rising to 2%. Against a premium of ~4.6% that is
material, and the Reality Check screen shows it rather than quietly absorbing it.

The protocol does not subsidize or rebate this. It measures what actually arrives and
settles against that.

## Rent is not reclaimed

Each position creates two vault accounts whose rent is never recovered, because closing a
Token-2022 account holding withheld transfer fees first requires harvesting them to the
mint — a path deliberately left out to reduce surface area before the deadline. The cost is
a fixed, small amount of SOL per position, paid by the maker.

## Economic and structural limits

- **No secondary market.** A position cannot be transferred or sold; both sides are
  committed until exercise or expiry.
- **No partial fills.** A $100 commitment is taken whole or not at all.
- **The maker cannot exit after matching.** They have sold protection and are committed for
  the full term. This is deliberate, not an oversight.
- **Open commitments may never match.** Standardized valuation bands and expiries reduce
  fragmentation, but nothing guarantees a counterparty.
- **No automated premium pricing.** The maker names a premium and the taker accepts or does
  not. There is no model claiming a fair value.

## The Commitment Curve is not a valuation

It aggregates capital actually committed at each valuation level. That is a stronger signal
than a poll, because it costs something to express. It is still not an estimate of what a
company is worth:

- premium and expiry both affect willingness independently of conviction
- a single large wallet can dominate a band, so concentration metrics are shown alongside
- participants may be hedging exposure held elsewhere
- committed capital is bounded by who happens to be present, not by the market

It should be read as *where capital is currently willing to buy*, and nothing more.

## Valuation mapping is a creation-time snapshot

Target valuations are converted to a fixed token strike once, using PreStocks mark data at
creation, and then frozen. Later changes to the mark, the implied share count, or the mint's
ScaledUiAmount multiplier do not alter an existing agreement — by design, since an agreement
that silently rewrote itself would be worse. But it does mean an old position's stated
target valuation describes the world at the moment it was created, not today.

## Engineering status

- **Unaudited.** Written for a hackathon under a deadline. Nothing here has had a security
  review, and it should not custody funds anyone cannot afford to lose.
- **Demo runs on devnet against a mock mint.** PreStocks tokens exist only on mainnet, so
  the devnet demo uses a Token-2022 mint reproducing the real transfer-fee behaviour. It is
  labelled as a mock wherever it appears; it is not a real PreStock.
- **Live valuation data is real** in every environment, read from the PreStocks API.
- **Jurisdiction.** PreStocks provide economic exposure to private-company-linked assets and
  may be restricted in some jurisdictions. Rung is experimental software and is not
  investment advice.
