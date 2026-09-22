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

## For judges: two minutes

**Live on devnet:** https://rung.up.railway.app

1. **Look.** The landing page's Commitment Curve and *On chain now* figures are read live
   from Position accounts, including a live matched position and both sides' P&L.
2. **Get tokens.** Switch Phantom to devnet, connect, and press **Get test tokens** for devnet
   SOL, mock USDC and mock OPENAI.
3. **Try both sides.** Commit at a valuation on OpenAI; from a second wallet, take the other
   side on Protect. My Positions shows each side's dates, collateral and P&L, and lets the
   holder exercise.

Worth checking:

- **No oracle in settlement.** Exercise is the holder's contractual right; expiry is
  permissionless, so no admin switch or absent counterparty can trap collateral.
- **The real mints, handled honestly.** The 48.6% multiplier trap, the epoch-scheduled
  transfer fee, and the issuer's powers (permanent delegate, freeze, pause, transfer hook)
  are dealt with in code and disclosed on screen, not ignored.
- **Tested against the real thing.** 24 program tests, 26 checks against the real OpenAI and
  SpaceX mints on a mainnet fork, and 12 against the live devnet deployment.
- **Guardrails on chain.** A $1,000 cap per position, a transfer-hook guard, and no
  self-matching, all enforced by the program.

A 90-second walkthrough is in [docs/demo-script.md](docs/demo-script.md).

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
bash scripts/wsl/test-local.sh        # 24 tests against a local validator
bash scripts/wsl/fork-test.sh         # every instruction against the REAL mints, on a mainnet fork
node scripts/devnet-smoke.ts          # every instruction and guardrail against the live devnet deployment
node scripts/verify-chain.ts          # re-check the mint against live mainnet
```

The fork test is the one that matters before touching mainnet. It loads the live OpenAI and
SpaceX mint accounts (every extension intact), mainnet's Token-2022 program and feature set,
and warps past the epoch where the 1% fee took effect, then runs create, accept, exercise,
cancel and expire with quantities computed by the SDK exactly as the web app computes them.
Nothing is sent to mainnet.

`verify-chain.ts` is worth running before any demo: the transfer fee is on an epoch schedule,
so yesterday's numbers are not evidence.

## Status

**Live:** https://rung.up.railway.app

- Program: **24/24** tests — full lifecycle, both settlement paths, every refusal in the
  state machine, and the launch guardrails below
- Mainnet fork: **26/26** checks against the real OpenAI and SpaceX mints
- SDK: **35/35** tests, pinned against live mainnet values
- Every instruction has a UI: commit, take the other side, exercise, cancel, settle expiry

### Launch guardrails

Enforced by the program, not just the interface:

- **$1,000 cap per position.** Unaudited code should not be able to lose more than that on
  one position. Raising it takes a program upgrade, not an admin toggle.
- **Transfer-hook guard.** Every PreStocks mint carries an empty transfer-hook slot the
  issuer can fill at any time. Rung does not pass hook accounts, so it refuses to list, open
  or match against a mint with a hook set, rather than take collateral it could not settle.
- **No self-matching.** A maker cannot take their own commitment, so a "matched" position
  always has two parties.

### Deployed on devnet

| | |
|---|---|
| Program | [`6kqka5NWofo1cm6bm5JMhWbQgHeR6YT23qTvwnusSwpM`](https://explorer.solana.com/address/6kqka5NWofo1cm6bm5JMhWbQgHeR6YT23qTvwnusSwpM?cluster=devnet) |
| Config | [`81keCkSZRierBmcXgcNBqqNTfYszRDvvgviwg4YTg8jo`](https://explorer.solana.com/address/81keCkSZRierBmcXgcNBqqNTfYszRDvvgviwg4YTg8jo?cluster=devnet) |
| OPENAI market | [`8igHstCvuXTDbP7aJKA2CDtLhejMA18aXMmDMwd1JDtD`](https://explorer.solana.com/address/8igHstCvuXTDbP7aJKA2CDtLhejMA18aXMmDMwd1JDtD?cluster=devnet) |
| Mock OPENAI mint | [`3Q43N1W6s77VTn2g9Tzp56p6WshVBUzRWknQeh3TVwR6`](https://explorer.solana.com/address/3Q43N1W6s77VTn2g9Tzp56p6WshVBUzRWknQeh3TVwR6?cluster=devnet) |
| Mock USDC | [`CRUjjjByxTpUfeAhR377RTdpmravXXgSX6eTk93XxBov`](https://explorer.solana.com/address/CRUjjjByxTpUfeAhR377RTdpmravXXgSX6eTk93XxBov?cluster=devnet) |

PreStocks exist only on mainnet, so the escrowed token on devnet is a **mock**. It carries
the extensions that change the program's arithmetic: 9 decimals, a transfer fee and the
real OpenAI PreStock's 1.4861347 scaled-amount multiplier. It is not a full replica: it
charges 0.5% where the real mint now charges 1%, and it lacks the real mints' transfer-hook
slot, pause switch and confidential-transfer extensions, which is why the fork test above
exists. It is labelled as a mock on every screen it appears on, and **valuation data is live
from the real PreStocks API throughout**.

### Mainnet readiness

Rung runs on devnet for judging, where anyone can try both sides for free. Mainnet is one
command away and has been rehearsed, but it is deliberately not live: the code is unaudited,
and trying it there would need real PreStocks and USDC.

What has been verified against mainnet itself:

- **The real mints.** `scripts/wsl/fork-test.sh` runs every instruction against the live
  OpenAI and SpaceX mint accounts on a local fork (26/26 checks), covering the extensions the
  devnet mock lacks and SpaceX's 5x multiplier.
- **Listing.** `node scripts/setup-mainnet.ts --dry-run` reads all 8 live PreStocks mints
  and confirms each one can be listed against real USDC.
- **Deploying.** `scripts/wsl/deploy-program.sh` has been rehearsed on devnet, which caught
  two failures before they could cost real SOL.
- **The interface.** On a real mint, the app refuses to quote without live mint data, shows
  wallet-scaled quantities, and enforces the cap.

Launching takes about 3.6 SOL at the peak of the deploy (about 3.0 with a size-optimized
build, `opt-level = "z"`, which shrinks the binary from 349 KB to 294 KB). About half comes
back when the upload finishes, and the rest is a refundable storage deposit. Then:

```bash
bash scripts/wsl/deploy-program.sh "$MAINNET_RPC_URL"
node scripts/setup-mainnet.ts
```

This is **unaudited** hackathon software.

---

Built for the [Stocklana](https://hackathons.solana.com/hackathons/stocklana) hackathon,
PreStocks track. PreStocks-only by design — no other pre-IPO token issuer is integrated.
