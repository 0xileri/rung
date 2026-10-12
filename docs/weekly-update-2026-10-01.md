# Rung weekly update — October 1, 2026

Rung has progressed from the original Limit+ whole-position prototype into a usable
devnet valuation market for all eight PreStocks. The public demo is available at
https://rung.up.railway.app.

## Delivered in the current release

- Partial fills give each holder a collateralized claim while the maker's remaining
  capital stays available.
- Sweeps take protection across several floors, and ladders let makers commit across a
  range of valuations.
- The maker's book shows open and matched capital, premium received, and capital charts.
- Share cards and Solana Actions make individual commitments easier to distribute and take.
- An activity feed records book events. Capital's median floor summarizes demand weighted
  by available escrowed capital, with open data at `/api/curve`.
- The scheduled permissionless expiry keeper is verified against a real devnet claim.
- Holder premium wording and partial-fill disclosures are corrected on the live website.

## Verified on October 1

- SDK: **106/106 tests passing**.
- Frontend: TypeScript check and optimized production build pass.
- Program interface: the JS client's Borsh coder successfully constructs the current IDL,
  round-trips an instruction, and resolves all four account layouts and 12 instructions.
- Public homepage and curve API both return HTTP 200. The API reports devnet and a fresh
  October 1 timestamp, with eight assets.
- Live devnet lifecycle: **12/12 checks passing** against the deployed program. Create,
  accept, exercise, cancel and permissionless expiry all succeed; collateral and fee math,
  the position cap and the self-match guard also pass. The suite exits successfully after
  settling or cancelling its test positions.

The README also records 37 local program tests and 33 mainnet-fork checks. Those counts
are prior recorded results, not fresh reruns from this verification pass.

## Operational verification and walkthrough

Railway's keeper runs every ten minutes from `main`. Its October 1 scheduled pass
settled the demo claim at 12:41:00 UTC (13:41 Lagos), 475 seconds after expiry.
The successful transaction's fee payer is the keeper wallet, distinct from both parties.
Token balances confirm $20 mock USDC returned to the maker and stock returned to the holder.
[View the settlement](https://explorer.solana.com/tx/5qyj5VzUYs75QZC66CZ3gN4TTp7Pgd2gVadkBsJNX6ZjRyx86kTXi55SrcxVPrCVRbyqRYDMfrt6ooM4pgEzawL6?cluster=devnet).
Public verification evidence is saved in `artifacts/keeper-settlement.json`.

The two-wallet CLI rehearsal passed: two commitments, two $10 partial fills,
withdrawal of unmatched capital, and exercise of both matched claims. It checked
that withdrawals preserved claim backing and that settlement cleared open fills.
Results are saved in `artifacts/two-wallet-rehearsal.json`. This does not establish
browser wallet signing or execution of ladder, sweep, or share Action transactions.

The walkthrough is now a **60-second actual browser navigation recording** of the
deployed website, replacing the earlier screenshot preview. It shows navigation,
scrolling, changing commitment inputs, both ladder allocation shapes, a $300 sweep
preview, a $50 partial-fill quote, and the activity feed's link to the keeper-settled
claim. It uses Higgsfield's Arthur voice through ElevenLabs and covers what was
built, what was learned, and what comes next. Devnet mock assets and seeded capital
remain labelled. No wallet connection is simulated and no UI transaction is submitted.

[Download the narrated live demo](https://d2ol7oe51mr4n9.cloudfront.net/user_38ylnF64UtS6dh2VeeOFs6EQzLz/bee84aa6-cf38-43df-8295-fff3ef2968b3.mp4).
The final export is H264 at 1600×900 with AAC narration; full video/audio decoding
passed. Public provenance and the editable source bundle are recorded in
`artifacts/walkthrough/live-navigation.json`.

Web deployment `ddd9a5d1-fa80-44f0-a2e6-d4d8d60906c2` succeeded. The production build
passed after the copy fixes, and the live pages show the corrected holder premium
wording and partial-fill limitations.

## Scope and limitations

The demo escrows mock assets on devnet and reads real PreStocks valuation data. Seeded
demo capital must not be presented as organic adoption. Mainnet remains a separate launch
decision; no mainnet deployment was performed during this update. Issuer delegate, freeze,
pause and transfer-hook powers continue to qualify collateral and settlement claims.

The build uses a pure JavaScript bigint fallback when native bindings are unavailable.
That warning did not prevent compilation or the checks above.
