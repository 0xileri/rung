<div align="center">

<img src="apps/web/public/logo.svg" alt="Rung" width="200">

**A capital-backed valuation market for PreStocks on Solana.**

</div>

---

Private-market investors do not think in token prices. They think in valuations:

> Would I own OpenAI at $1.2T? At $1.0T? At $900B?

Spot markets cannot answer that. They show where an asset trades now, not where capital is
actually willing to buy, and they give an existing holder no way to set a floor.

**Rung** turns those two intentions into one fully collateralized agreement.

A **valuation buyer** locks USDC at the private-company valuation where they would genuinely
own exposure. A **PreStocks holder** locks the matching tokens, pays a premium, and receives
the right to exchange those tokens for that USDC at any point before expiry. If they never
exercise, both sides take back their own collateral and the buyer keeps the premium.

Every open commitment joins a live **Commitment Curve**: how much real capital sits at each
valuation level. Not a poll — capital that has already been escrowed.

The name is the mark. Every bar in the logo is a rung: a valuation someone has committed at,
stepping out from the line where the asset currently trades.

---

## What we found in the mints

Rung is built on the actual OpenAI PreStock
([`PreweJ…Q3rpgF`](https://explorer.solana.com/address/PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF)),
and three of its properties break the obvious implementation. Each was verified against
mainnet before a line of the program was written, and each is pinned by a test.

**1. The multiplier that is a 48.6% bug.** The mint carries a `ScaledUiAmount` extension with
*two* values — `multiplier` (1) and `newMultiplier` (1.4861347) — and the effective timestamp
for the second one has already passed. So the live multiplier is the one that is *not* in the
obvious field. PreStocks quotes prices in scaled units, proven by reconciling the API's
reported supply against raw supply × multiplier to nine decimal places. Read the wrong field
and every position over-escrows by 48.6%.

```
$100 at a $1.00T target  →  83,365,949 raw units     ✅ multiplier-correct
                            123,893,030 raw units    ❌ the naive answer
```

**2. A transfer fee on an epoch schedule.** `transferFeeConfig` holds two slots and steps from
50 bps to 100 bps at epoch 1039. A vault therefore *never* receives what was sent, and the
rate can change between quoting and signing.

Two halves to the answer. On chain, the program measures the vault's balance delta and
escrows what actually arrived, then requires it to clear the maker's floor — equality is
unachievable under a fee, a floor is both achievable and sufficient. Off chain, the client
sizes transfers against the **worse** of the two slots rather than the live one, so a
transaction still clears if the rate steps up before it is signed. A test asserts that sizing
against the *active* slot fails once the fee moves, so the reasoning cannot be quietly
simplified away later.

**3. The collateral is not trustless, and we say so.** The issuer holds `permanentDelegate`,
`freezeAuthority` and a pause switch over the mint — they can move tokens out of a
program-controlled vault, freeze it, or halt settlement entirely. No program can defend
against that, because it is a property of the token. The UI derives this disclosure from live
chain state rather than hardcoding it, so the claim tightens automatically if the issuer ever
gives a power up. See [docs/limitations.md](docs/limitations.md).

---

## How it works

```
PreStocks API  ──►  valuation context, mark price, implied valuation
                    (never authorizes a transfer)

Solana program ──►  lock · match · exercise · expire
                    PDA vaults hold both legs

Chain state    ──►  the Commitment Curve, rebuilt by anyone
```

**No oracle sits in the settlement path.** The holder bought a contractual right, not a bet on
a price feed, so the program never asks what anything is worth. That removes stale marks, thin
prints and feed manipulation from settlement entirely.

**Valuations are metadata; raw amounts are the contract.** A target valuation is converted to
a fixed strike once, at creation, and then frozen. A later change to the mark, the share count
or the multiplier cannot rewrite an agreement already in force.

**Settlement cannot be blocked.** `exercise_position` and `expire_position` read neither the
pause flag nor the market flags, and expiry is permissionless — so no admin switch and no
absent counterparty can trap collateral that is owed back.

## Layout

| Path | |
|---|---|
| `programs/rung/` | Anchor program — 9 instructions, PDA vaults |
| `packages/sdk/` | Token-2022 math, valuation→strike, Commitment Curve |
| `apps/web/` | Next.js app — Commitment Curve, commit, protect, positions |
| `docs/limitations.md` | What this does not do, stated plainly |
| `scripts/` | Chain preflight, WSL toolchain, deploy |

## Running it

```bash
npm install
npm run test:sdk                      # 35 tests, no chain needed
bash scripts/wsl/test-local.sh        # 18 tests against a local validator
node scripts/verify-chain.ts          # re-check the mint against live mainnet
```

`verify-chain.ts` is worth running before any demo: the transfer fee is on an epoch schedule,
so yesterday's numbers are not evidence.

## Status

- Program: **18/18** tests — full lifecycle, both settlement paths, and every refusal in the
  state machine
- SDK: **35/35** tests, pinned against live mainnet values
- Web: production build green across seven routes; live PreStocks data end to end
- Every instruction has a UI: commit, take the other side, exercise, cancel, settle expiry
- Program ID: `6kqka5NWofo1cm6bm5JMhWbQgHeR6YT23qTvwnusSwpM`

**Not yet deployed to devnet.** The public devnet RPC rate-limits hard enough that a 337 KB
program upload fails partway; the deploy resumes from the buffer it left behind once a
dedicated endpoint is configured. Until then the app runs against a local validator, where
the full lifecycle works end to end.

This is **unaudited** hackathon software. The devnet demo uses a Token-2022 mint reproducing
the real transfer-fee behaviour, labelled as a mock wherever it appears; it is not a real
PreStock. Valuation data is live and real in every environment.

---

Built for the [Stocklana](https://hackathons.solana.com/hackathons/stocklana) hackathon,
PreStocks track. PreStocks-only by design — no other pre-IPO token issuer is integrated.
