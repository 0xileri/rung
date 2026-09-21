import Link from 'next/link';
import { MAX_STRIKE_USD } from '../../lib/program';

export const metadata = { title: 'Limitations — Rung' };

/**
 * The limitations page, stated plainly rather than buried in a footer.
 *
 * Several of these are properties of the PreStocks mints themselves and qualify claims a
 * reader would otherwise take at face value. Keeping them on their own page, linked from
 * every screen that makes a collateral claim, is the point.
 */

const section = (title: string, body: React.ReactNode, id?: string) => (
  <section id={id} style={{ marginBottom: 34, scrollMarginTop: 80 }}>
    <h2 style={{ fontSize: 24, marginBottom: 10 }}>{title}</h2>
    <div style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--text-muted)' }}>{body}</div>
  </section>
);

export default function Limitations() {
  return (
    <div className="wrap enter" style={{ paddingTop: 48, paddingBottom: 56, maxWidth: 760 }}>
      <h1 style={{ fontSize: 44, marginBottom: 12 }}>Known limitations</h1>
      <p style={{ fontSize: 16, color: 'var(--text-faint)', marginTop: 0, marginBottom: 40 }}>
        Written plainly, because several of these qualify claims you would otherwise take at
        face value.
      </p>

      {section(
        'The collateral is not trustless',
        <>
          <p style={{ marginTop: 0 }}>
            Every matched position is collateralized in the sense that both legs sit in
            program-controlled vaults and no Rung key can move them. That is worth something.
            It is not the whole story.
          </p>
          <p>
            The PreStocks mint grants its issuer a <strong>permanent delegate</strong> (they can
            move tokens out of the program&rsquo;s vault), <strong>freeze authority</strong> (they
            can freeze the vault), and a <strong>pause switch</strong> (they can halt all
            transfers, so exercise and expiry cannot settle). No on-chain program can defend
            against these, because they are properties of the token rather than of this protocol.
          </p>
          <p>
            A sharper case worth naming: if transfers are paused across a position&rsquo;s expiry,
            the holder can lose their exercise window through no fault of their own. Rung does
            not extend the deadline to compensate.
          </p>
          <p>
            Every PreStocks mint also carries an empty <strong>transfer hook</strong> slot the
            issuer can fill at any time. Rung does not pass a hook&rsquo;s accounts, so if one is
            set the program refuses new positions on that PreStock, and positions already
            matched cannot settle until Rung is upgraded to support it.
          </p>
        </>,
      )}

      {section(
        'Transfer fees make the round trip lossy',
        <p style={{ marginTop: 0 }}>
          PreStocks mints charge a transfer fee, so the amount sent is never the amount that
          arrives. Collateral passes through a vault twice &mdash; in on match, out on settlement
          &mdash; and is charged both times. Each transfer currently costs 1%, so the round trip
          costs about 2%, and the issuer can change the rate. Against a premium of a few percent
          that is material, so the Reality Check shows it rather than absorbing it quietly.
          Rung does not subsidise or rebate it.
        </p>,
      )}

      {section(
        'The Commitment Curve is not a valuation',
        <>
          <p style={{ marginTop: 0 }}>
            It shows capital actually committed at each valuation level. That is a stronger
            signal than a poll, because expressing it costs something. It is still not an
            estimate of what a company is worth:
          </p>
          <ul style={{ paddingLeft: 18 }}>
            <li>premium and expiry affect willingness independently of conviction</li>
            <li>a single large wallet can dominate a band, so concentration is shown alongside</li>
            <li>participants may be hedging exposure held elsewhere</li>
            <li>committed capital is bounded by who happens to be present</li>
          </ul>
        </>,
      )}

      {section(
        'Valuation mapping is a creation-time snapshot',
        <p style={{ marginTop: 0 }}>
          A target valuation is converted to a fixed token strike once, using PreStocks mark data
          at creation, and then frozen. Later changes to the mark, the implied share count or the
          mint&rsquo;s scaled-amount multiplier do not alter an existing agreement &mdash; by
          design, since an agreement that silently rewrote itself would be worse. But an old
          position&rsquo;s stated target describes the world at the moment it was created.
        </p>,
      )}

      {section(
        'P&L is a measure, not a valuation',
        <>
          <p style={{ marginTop: 0 }}>
            A matched position is a put, so P&amp;L is measured against letting it expire, when
            each side simply takes back its own collateral. Only two things move value between
            the parties: the premium, and on exercise the swap of the vault&rsquo;s tokens for
            the strike. The two sides&rsquo; figures are therefore exact opposites.
          </p>
          <ul style={{ paddingLeft: 18 }}>
            <li>
              A <strong>live</strong> position counts the swap only when exercising would pay the
              holder, at today&rsquo;s market price. That is intrinsic value; no time value is
              modelled, because that would be a claim about fair price, which Rung does not make.
            </li>
            <li>
              An <strong>exercised</strong> position values the delivered tokens at today&rsquo;s
              market price. The program clears its escrow record at settlement, so the delivered
              quantity is taken from the required amount, which the escrow was sized to hit.
            </li>
            <li>An <strong>expired</strong> position is final: only the premium changed hands.</li>
            <li>
              <strong>Transfer fees are excluded.</strong> They go to the token issuer, not to
              the counterparty, and are shown separately wherever they apply.
            </li>
          </ul>
        </>,
        'pnl',
      )}

      {section(
        'Economic and structural limits',
        <ul style={{ paddingLeft: 18, marginTop: 0 }}>
          <li>No secondary market: a position cannot be transferred or sold.</li>
          <li>No partial fills: a commitment is taken whole or not at all.</li>
          <li>
            The maker cannot exit after matching. They sold protection and are committed for the
            full term. This is deliberate.
          </li>
          <li>Open commitments may never match.</li>
          <li>No automated premium pricing. Nothing here claims a fair value.</li>
          <li>Rent on the two vault accounts is not reclaimed.</li>
        </ul>,
      )}

      {section(
        'Engineering status',
        <ul style={{ paddingLeft: 18, marginTop: 0 }}>
          <li>
            <strong>Unaudited.</strong> Built for a hackathon under a deadline. It should not
            custody funds anyone cannot afford to lose.
          </li>
          <li>
            <strong>Capped at ${MAX_STRIKE_USD.toLocaleString()} per position.</strong> The
            program itself refuses a larger strike, which bounds what any one position can lose
            to a bug. Raising the cap takes a program upgrade.
          </li>
          <li>
            <strong>Upgradeable by one key.</strong> The program&rsquo;s upgrade authority is a
            single key held by its developer, which could change the code that controls the
            vaults. Treat that as part of the trust you extend.
          </li>
          <li>
            The devnet demo uses a Token-2022 mint reproducing the real transfer-fee behaviour. It
            is labelled as a mock wherever it appears; it is not a real PreStock.
          </li>
          <li>Valuation data is live and real in every environment.</li>
          <li>
            PreStocks may be restricted in some jurisdictions. Rung is experimental software and
            is not investment advice.
          </li>
        </ul>,
      )}

      <Link href="/" style={{ fontSize: 14 }}>
        &larr; Back to markets
      </Link>
    </div>
  );
}
