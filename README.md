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
   SOL, mock USDC and a mock of every PreStock (all eight are listed on devnet).
3. **Try both sides.** Commit at a valuation on any PreStock; from a second wallet, take the other
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

Solana program ──►  lock · match (whole or in slices) · exercise · expire
                    PDA vaults hold both legs, one claim per taker

Chain state    ──►  the Commitment Curve, rebuilt by anyone
```

**No oracle sits in the settlement path.** The holder bought a contractual right, not a bet on
a price feed, so the program never asks what anything is worth. That removes stale marks, thin
prints and feed manipulation from settlement entirely.

**Valuations are metadata; raw amounts are the contract.** A target valuation is converted to
a fixed strike once, at creation, and then frozen. A later change to the mark, the share count
or the multiplier cannot rewrite an agreement already in force.

**Settlement cannot be blocked.** `exercise_fill` and `expire_fill` read neither the
pause flag nor the market flags, and expiry is permissionless — so no admin switch and no
absent counterparty can trap collateral that is owed back.

## Layout

| Path | |
|---|---|
| `programs/rung/` | Anchor program — 12 instructions, PDA vaults |
| `packages/sdk/` | Token-2022 math, valuation→strike, Commitment Curve |
| `apps/web/` | Next.js app — Commitment Curve, commit, protect, positions |
| `docs/limitations.md` | What this does not do, stated plainly |
| `scripts/` | Chain preflight, WSL toolchain, deploy |

## Running it

```bash
npm install
npm run test:sdk                      # 91 tests, no chain needed
bash scripts/wsl/test-local.sh        # 37 tests against a local validator, one of them a random walk
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

### The keeper

```bash
node scripts/keeper.ts --once --dry-run   # what is past its deadline, sending nothing
node scripts/keeper.ts --once             # settle it: one pass, for a cron job
node scripts/keeper.ts --watch 60         # or loop, backing off if the RPC does
```

Settling a claim after its deadline is permissionless, so nobody depends on a counterparty
coming back — and nobody depends on the keeper either. It just saves people the trouble: the
maker's USDC and the holder's tokens come home without either of them lifting a finger. It
sends one instruction, `expire_fill`, which the program refuses before the deadline and which
pays each side only what that claim records, so a keeper with a bug can waste its own fees
and nothing else. It reads the cluster's clock rather than its own, settles the longest-waiting
collateral first, and batches settlements by measured transaction size; if a batch fails
because something changed under it, the claims are retried one at a time.

`--rpc`, `--keypair` and `--limit` (settlements per cycle, default 50) are flags, or
`KEEPER_RPC_URL` and `KEEPER_KEYPAIR` in the environment. The keypair pays fees, plus rent
if a recipient no longer has a token account to receive into.

On devnet it runs as a Railway cron job: one pass every ten minutes, paid for by a wallet of
its own that holds devnet SOL and nothing else. Railway applies the root `railway.json` to every
service built from this repository, so on this branch it only picks the builder; each service
carries its own commands (the site: `npm run build`, `npm start`, health check on `/`). The
`keeper` service's settings. A redeploy from the dashboard builds with Railpack instead,
which would read the root `Cargo.toml` as a Rust project and ship an image without Node, so
`railpack.json` pins its provider to Node and either builder produces a working image.

| Setting | Value |
|---|---|
| Source | this repository, branch `feat/partial-fills` |
| Build command | a no-op: the keeper runs as TypeScript directly on Node 24 |
| Start command | `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/keeper.ts --once` |
| Cron schedule | `*/10 * * * *` |
| Restart policy | never: the next pass is ten minutes away anyway |
| Watch paths | `scripts/keeper.ts`, `packages/sdk/**`, `package.json`, `package-lock.json`, `railway.json`, `railpack.json` |
| Variables | `KEEPER_RPC_URL`, `NPM_CONFIG_PRODUCTION=false`, `KEEPER_SECRET_KEY` |

A host has no key file to point at, so `KEEPER_SECRET_KEY` carries the key itself, as the
keypair file's JSON array. It was set from stdin and appears nowhere in this repository.

Claims last a month, so on an ordinary book the keeper has nothing to do for weeks. To watch
it work, `scripts/keeper-demo.ts` puts one on devnet that is due in minutes:

```bash
node scripts/keeper-demo.ts <maker.json> <taker.json> --watch
```

The maker commits $20 at $1.00T on OPENAI and the taker takes all of it, with the deadline
two minutes before a keeper pass, so the maker's book shows the claim waiting to settle before
the keeper settles it. `--watch` then reports the settling transaction and who paid for it:
the keeper's wallet, not either party's.

### A local stack

Devnet is shared, so changes to the program are exercised here first:

```bash
bash scripts/wsl/local-stack-up.sh <tester-address>   # validator, program, market, floors, a funded tester
NEXT_PUBLIC_CLUSTER=localnet bash scripts/wsl/dev.sh  # the web app, against it
node scripts/local-book-scenario.ts maker.json taker.json --expiring 5
bash scripts/wsl/local-stack.sh --stop
```

`local-book-scenario.ts` puts one maker's book into every state the app has to show —
untouched, partly taken, partly withdrawn, expired and waiting — which is also what the keeper
is tested against.

## Status

**Live:** https://rung.up.railway.app

- Program: **37/37** tests — full lifecycle, partial fills, both settlement paths, every refusal in the
  state machine, and the launch guardrails below. One of them is a seeded random walk of takes, refused sizes, exercises,
  withdrawals and expiries that checks every vault is exactly balanced after every step
  (`FUZZ_SEED=<n>` replays a run)
- Mainnet fork: **33/33** checks against the real OpenAI and SpaceX mints, including partial fills and the protocol fee
- SDK: **91/91** tests, pinned against live mainnet values
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
| Mock USDC | [`CRUjjjByxTpUfeAhR377RTdpmravXXgSX6eTk93XxBov`](https://explorer.solana.com/address/CRUjjjByxTpUfeAhR377RTdpmravXXgSX6eTk93XxBov?cluster=devnet) |

Every PreStock is listed, each against its own mock (full addresses in [`devnet.json`](devnet.json)):

| Market | Market account | Mock mint | Multiplier | Fee |
|---|---|---|---|---|
| OPENAI | [`8igHst…JDtD`](https://explorer.solana.com/address/8igHstCvuXTDbP7aJKA2CDtLhejMA18aXMmDMwd1JDtD?cluster=devnet) | [`3Q43N1…VwR6`](https://explorer.solana.com/address/3Q43N1W6s77VTn2g9Tzp56p6WshVBUzRWknQeh3TVwR6?cluster=devnet) | 1.4861347 | 0.5% |
| SPACEX | [`9wCPPb…qHVC`](https://explorer.solana.com/address/9wCPPbEj2JarSfXhNnHmZ49iRrwP3iJo6cRtMMMyqHVC?cluster=devnet) | [`3NS9XJ…gfZD`](https://explorer.solana.com/address/3NS9XJR5GbNo6XGQhZBVgCDtfiPY6T1DjcDjX4rrgfZD?cluster=devnet) | 5 | 1% |
| ANDURIL | [`996ige…hsS5`](https://explorer.solana.com/address/996igeohhSof5hYDENavXJEBzYkCr7FgAVhoBT17hsS5?cluster=devnet) | [`BJyL2P…Yfjf`](https://explorer.solana.com/address/BJyL2P1v4kENE3uHCkxRuxAG3Qjv5KaLMTQVwqJDYfjf?cluster=devnet) | 1 | 1% |
| ANTHROPIC | [`31ZDAv…BceX`](https://explorer.solana.com/address/31ZDAvmu9qU5AosXWVo4UU9KH1e1kXWAevwcgsoFBceX?cluster=devnet) | [`GzN2PP…QUn1`](https://explorer.solana.com/address/GzN2PPFzagbixukwGL5kLUo2F1k1t7EVa8spaicYQUn1?cluster=devnet) | 1 | 1% |
| FIGUREAI | [`EWqjJR…TU3q`](https://explorer.solana.com/address/EWqjJRazJGYYhJcBowwLHCFu3X8f91XHyYHqzATXTU3q?cluster=devnet) | [`8TCxon…3SGg`](https://explorer.solana.com/address/8TCxonhUAPsPG7AJyzuQzZfa43jGXVgeoMgN7xQq3SGg?cluster=devnet) | 1 | 1% |
| KALSHI | [`WvCgNQ…jM7r`](https://explorer.solana.com/address/WvCgNQkENYeD5FvTEqUF2ADbfuCQ7hcW8fxFCBPjM7r?cluster=devnet) | [`DqX88Z…LwkG`](https://explorer.solana.com/address/DqX88Z5P39MRAeFrFsEucAc5CfLTHJgaKA6CKLcDLwkG?cluster=devnet) | 1 | 1% |
| NEURALINK | [`9KGfao…9gR4`](https://explorer.solana.com/address/9KGfaozx5cVgmNTp2TiJjm4jp6Dby5TpXiKZUwtR9gR4?cluster=devnet) | [`BZC1uG…sxqd`](https://explorer.solana.com/address/BZC1uGbbwXof8HW8CALPvwjvGTr8WqtArCcs8df4sxqd?cluster=devnet) | 1 | 1% |
| POLYMARKET | [`CY6cnY…7AdS`](https://explorer.solana.com/address/CY6cnY73b6WhC2Dvz3aNzpMLUTUmRLjQ2yAsdC7A7AdS?cluster=devnet) | [`4PLS8f…RtQK`](https://explorer.solana.com/address/4PLS8fCUi5xgREWbVUCByPBUyCQHX6ANVJLauituRtQK?cluster=devnet) | 1 | 1% |

PreStocks exist only on mainnet, so each devnet market escrows a **mock**. Each carries the
extensions that change the program's arithmetic: 9 decimals, a transfer fee and its real
counterpart's scaled-amount multiplier (1.4861347 for OpenAI, 5 for SpaceX, 1 for the rest).
Every mock but OpenAI's was built from its live mint by `scripts/add-devnet-market.ts`, so
those also have the real 1% fee and an empty transfer-hook slot; the older OpenAI mock
charges 0.5%. Neither has the
pause switch or confidential-transfer extensions, which is why the fork test above exists.
Mocks are labelled on every screen they appear on, and **valuation data is live from the
real PreStocks API throughout**.

### Mainnet readiness

Rung runs on devnet for judging, where anyone can try both sides for free. Mainnet has been
rehearsed, but it is deliberately not live: the code is unaudited, and trying it there would
need real PreStocks and USDC.

What has been verified against mainnet itself:

- **The real mints.** `scripts/wsl/fork-test.sh` runs every instruction against the live
  OpenAI and SpaceX mint accounts on a local fork (33/33 checks), covering the extensions the
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
