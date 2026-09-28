'use client';

import { useEffect, useState } from 'react';

/**
 * "Share on X" and "Copy link" for a page on this site. The link a person shares unfolds into
 * that page's live card (see lib/og.tsx), so the post carries the numbers with it.
 *
 * The absolute URL needs the browser's origin, which the server cannot know for whichever domain
 * the page was opened on, so it is filled in after mount; until then the links are relative.
 */
export function ShareLinks({ path, text, size = 'normal' }: { path: string; text: string; size?: 'normal' | 'small' }) {
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);

  const url = origin + path;
  const intent = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  const style = size === 'small' ? { fontSize: 12, padding: '6px 12px' } : { fontSize: 13 };

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // No clipboard permission: the link is still one tap away through "Share on X".
    }
  }

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <a className="btn btn-quiet" style={{ ...style, textDecoration: 'none' }} href={intent} target="_blank" rel="noreferrer">
        Share on X
      </a>
      <button type="button" className="btn btn-quiet" style={style} onClick={copy}>
        {copied ? 'Link copied' : 'Copy link'}
      </button>
    </div>
  );
}
