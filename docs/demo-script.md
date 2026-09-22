# Demo script (about 90 seconds of narration)

**Before recording**

- Two browser profiles, each with Phantom switched to **devnet** (Settings → Developer
  settings → Testnet mode → Solana Devnet). Call them **A** (valuation buyer) and **B**
  (holder). They must be different wallets: the program refuses to let a maker take their
  own commitment.
- Both need devnet SOL, mock USDC and mock OPENAI. The wallets `3MAwd5…` and `4SYc8u…` are
  already funded with every mock. A fresh wallet can press **Get test tokens** on the landing
  page, or run `node scripts/fund-tester.ts <address>`.
- Run `bash scripts/wsl/run.sh node scripts/devnet-smoke.ts` to confirm the deployment is
  healthy (12 checks, about two minutes).
- Wallet signing and confirmation add pauses the narration does not cover; trim them in the
  edit rather than rushing the voice-over.

| Time | Screen | Do | Say |
|---|---|---|---|
| 0:00 | Landing | Point at the hero curve, the ticker, then **On chain now** | "Private-market investors think in valuations, not token prices. Rung lets you put capital behind *I'd own OpenAI at a trillion*. Every bar is USDC actually escrowed at that valuation, read live from chain, across all eight PreStocks." |
| 0:15 | OpenAI commit page (wallet **A**) | It opens on **$1.0T** and $100. Point at the Reality Check | "The target becomes a fixed strike: about $807 per token. The OpenAI mint's active multiplier is not in the obvious field; reading the wrong one over-escrows by 48.6%. We pin that with tests." |
| 0:30 | Same page, wallet **A** | Tick the acknowledgement, click **Lock $100.00 USDC**, sign. When it confirms, reload the page | "That's a commitment: the USDC is in a program vault, and it's on the curve." |
| 0:40 | Protect page, wallet **B** | Click **Review** on the **$1.0T floor paying $100.00 with a $4.60 premium**: other $1.0T floors pay $10 or charge $2.50, so match both numbers. Then **Buy protection — pay $4.60**, sign | "A holder takes the other side: locks tokens, pays the premium, and gains the right to swap them for that USDC before expiry. The mint's transfer fee is shown, not hidden." |
| 0:55 | My Positions, wallet **B** | Show the matched card: timeline, P&L, and the escrowed USDC and PreStock | "Both legs sit in program vaults. P&L is zero-sum: the holder shows minus $4.60, the buyer plus $4.60." |
| 1:05 | My Positions, wallet **B** | Click **Exercise protection** to show the confirmation, then **Keep holding** | "Exercise is the holder's choice alone. No oracle sits in settlement, and expiry is permissionless, so no Rung admin switch can trap collateral." |
| 1:15 | Limitations page | Scroll the collateral section | "And we say what's not trustless: the issuer can move, freeze or pause these tokens, or attach a transfer hook. The program refuses new positions if one appears, and caps each position at $1,000 while unaudited." |
| 1:25 | README, Mainnet readiness | Scroll to the section | "It's tested against the real OpenAI and SpaceX mints on a mainnet fork, and rehearsed for mainnet, but deliberately not launched while it's unaudited." |

Do not click **Exercise now** on camera. At today's price a $1.0T floor on OpenAI is out of
the money: exercising would hand over tokens worth more than the $100 it pays, and the P&L
would show that loss.

## If something goes wrong live

- **The new commitment isn't on the curve after reloading**: the server reuses a chain read
  for up to 10 seconds. Wait a few seconds and reload again.
- **Curve says "as of N min ago"**: the public RPC is rate-limiting and the page is showing
  its last good read. Carry on; it refreshes on the next load.
- **"This is your own commitment"** on Protect: wallet B is the same wallet as A. Switch
  profiles.
- **Transaction fails with "not enough"**: the wallet needs funding: **Get test tokens**, or
  `node scripts/fund-tester.ts <address>`.
- **Get test tokens says "funded recently"**: the faucet allows one claim per wallet every
  12 hours; use `fund-tester` instead.
