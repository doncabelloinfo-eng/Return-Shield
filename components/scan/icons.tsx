/**
 * The Scanner's icons, inline.
 *
 * Inline rather than an icon package: the whole set is five arrows, a tick, a
 * cross and a torch, and the phone that loads them is on warehouse wifi. They
 * are all `aria-hidden` because every one of them sits next to its own words —
 * an icon that needs a label is a label with a picture on it.
 */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
};

export function OutgoingIcon({ size = 26, width = 2 }: { size?: number; width?: number }) {
  return (
    <svg {...stroke} strokeWidth={width} width={size} height={size} viewBox="0 0 24 24">
      <path d="M7 17L17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

export function IncomingIcon({ size = 26, width = 2 }: { size?: number; width?: number }) {
  return (
    <svg {...stroke} strokeWidth={width} width={size} height={size} viewBox="0 0 24 24">
      <path d="M17 7L7 17" />
      <path d="M16 17H7V8" />
    </svg>
  );
}

export function ChevronRight({ size = 22 }: { size?: number }) {
  return (
    <svg {...stroke} width={size} height={size} viewBox="0 0 24 24">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function ChevronDown({ size = 14 }: { size?: number }) {
  return (
    <svg {...stroke} strokeWidth={2.4} width={size} height={size} viewBox="0 0 24 24">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function TickIcon({ size = 18, width = 3 }: { size?: number; width?: number }) {
  return (
    <svg {...stroke} strokeWidth={width} width={size} height={size} viewBox="0 0 24 24">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function CrossIcon({ size = 18 }: { size?: number }) {
  return (
    <svg {...stroke} width={size} height={size} viewBox="0 0 24 24">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function WarnIcon({ size = 20 }: { size?: number }) {
  return (
    <svg {...stroke} width={size} height={size} viewBox="0 0 24 24">
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17v.5" />
    </svg>
  );
}

export function TorchIcon({ size = 20 }: { size?: number }) {
  return (
    <svg {...stroke} width={size} height={size} viewBox="0 0 24 24">
      <path d="M8 2h8l-1 6H9z" />
      <path d="M9 8v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V8" />
      <path d="M12 13v3" />
    </svg>
  );
}

export function KeypadIcon({ size = 18 }: { size?: number }) {
  return (
    <svg {...stroke} width={size} height={size} viewBox="0 0 24 24">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </svg>
  );
}

/** The barcode stripe the design uses as decoration, at any size. */
export function BarcodeStripe({
  className,
  colour = 'var(--ink)',
}: {
  className?: string;
  colour?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        background:
          `repeating-linear-gradient(90deg, ${colour} 0 3px, transparent 3px 5px, `
          + `${colour} 5px 6px, transparent 6px 9px, ${colour} 9px 13px, transparent 13px 14px, `
          + `${colour} 14px 15px, transparent 15px 19px, ${colour} 19px 21px, transparent 21px 22px)`,
      }}
    />
  );
}
