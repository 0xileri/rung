/**
 * Soft mesh wash behind hero sections (Stripe-inspired).
 * Replaces the previous particle / fragment aesthetic.
 * Fully suppressed under prefers-reduced-motion (static gradient still OK).
 */
export function Fragments(_props?: { density?: number; className?: string; cssOnly?: boolean }) {
  return <div className="mesh-wash" aria-hidden />;
}

export function MeshWash({ className = '' }: { className?: string }) {
  return <div className={`mesh-wash ${className}`.trim()} aria-hidden />;
}
