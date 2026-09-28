/**
 * actions.json: tells Blink clients which pages on this site have a Solana Action behind them.
 * A commitment's page, /c/<position>, unfolds into the action that takes the other side of it.
 */
import { actionJson, preflight } from '../../lib/actions';

export const OPTIONS = preflight;

export function GET() {
  return actionJson({
    rules: [
      { pathPattern: '/c/*', apiPath: '/api/actions/take/*' },
      { pathPattern: '/api/actions/**', apiPath: '/api/actions/**' },
    ],
  });
}
