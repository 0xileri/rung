# Demo script (about 90 seconds)

Two browser profiles, each with Phantom on **devnet** and a funded wallet: press **Get test
tokens** on the landing page, or run `node scripts/fund-tester.ts <address>` for a larger
balance (SOL, mock USDC and mock OPENAI).
Call them **A** (valuation buyer) and **B** (holder). Before recording, run
`bash scripts/wsl/run.sh node scripts/devnet-smoke.ts` to confirm the deployment is healthy.

| Time | Screen | Do | Say |
|---|---|---|---|
| 0:00 | Landing | Point at the hero curve and **On chain now** | "Private-market investors think in valuations, not token prices. Rung lets you put capital behind *I'd own OpenAI at a trillion*. Every bar is USDC actually escrowed at that valuation, read live from chain." |
| 0:15 | OpenAI asset page | Pick **$1.0T**, $100, show the Reality Check | "The target becomes a fixed strike: about $807 per token. The OpenAI mint's active multiplier is not in the obvious field; reading the wrong one over-escrows by 48.6%. We pin that with tests." |
| 0:30 | Asset page, wallet **A** | Tick the acknowledgement, **Lock $100 USDC**, sign | "That's a commitment. It's on the curve the moment it lands." |
| 0:40 | Protect page, wallet **B** | **Review** the new floor, **Buy protection**, sign | "A holder takes the other side: locks tokens, pays the premium, and gains the right to swap them for that USDC before expiry. The mint's transfer fee is shown, not hidden." |
| 0:55 | My Positions, wallet **B** | Show the matched card: timeline, P&L, proof of collateral | "Both legs sit in program vaults. P&L is exact and zero-sum: my gain is the maker's loss." |
| 1:05 | My Positions | Point at **Exercise** (optionally click it) | "Exercise is the holder's choice alone. No oracle sits in settlement, and expiry is permissionless, so no admin switch can trap collateral." |
| 1:15 | Limitations page | Scroll the collateral section | "And we say what's not trustless: the issuer can move, freeze or pause these tokens, or attach a transfer hook. The program refuses to open positions if one appears, and caps each position at $1,000 while unaudited." |
| 1:25 | README | Mainnet readiness | "It's tested against the real OpenAI and SpaceX mints on a mainnet fork, and one command from mainnet." |

## If something goes wrong live

- **Curve says "as of N min ago"** — the public RPC is rate-limiting; the page is showing
  its last good read. Carry on; it refreshes on the next load.
- **"Not tradable on this devnet deployment"** — only the listed markets are on devnet; go
  back to OpenAI.
- **Transaction fails with "not enough"** — the wallet needs funding: **Get test tokens**, or
  `node scripts/fund-tester.ts <address>`.
- **Get test tokens says "funded recently"** — the faucet allows one claim per wallet every
  12 hours; use `fund-tester` instead.
