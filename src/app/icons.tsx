/**
 * The interface icons.
 *
 * Path data from Lucide (ISC licence, © Lucide Contributors), copied rather
 * than depended on: this is about a kilobyte of geometry, and a package plus a
 * bundler plugin plus a version to track is a poor trade for that.
 *
 * `sliders-horizontal` for the style control rather than a wand or sparkles.
 * it opens parameter controls, and nothing here is magic. `mouse-pointer-click`
 * for object selection for the same reason: it is a click that selects a thing,
 * not a spell.
 */
import type { JSX } from 'preact';

type IconProps = { readonly title?: string } & JSX.SVGAttributes<SVGSVGElement>;

function Icon({ children, ...props }: IconProps & { children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function BrushIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
      <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
    </Icon>
  );
}

export function EraserIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </Icon>
  );
}

export function PointerClickIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M14 4.1 12 6" />
      <path d="m5.1 8-2.9-.8" />
      <path d="m6 12-1.9 2" />
      <path d="M7.2 2.2 8 5.1" />
      <path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z" />
    </Icon>
  );
}

/**
 * `square-dashed`. A marquee is what the gesture draws, so the icon is the
 * marquee rather than a metaphor for one.
 */
export function BoxSelectIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M5 3a2 2 0 0 0-2 2" />
      <path d="M19 3a2 2 0 0 1 2 2" />
      <path d="M21 19a2 2 0 0 1-2 2" />
      <path d="M5 21a2 2 0 0 1-2-2" />
      <path d="M9 3h1" />
      <path d="M9 21h1" />
      <path d="M14 3h1" />
      <path d="M14 21h1" />
      <path d="M3 9v1" />
      <path d="M21 9v1" />
      <path d="M3 14v1" />
      <path d="M21 14v1" />
    </Icon>
  );
}

export function TrashIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </Icon>
  );
}

export function ContrastIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 18a6 6 0 0 0 0-12v12z" />
    </Icon>
  );
}

export function SlidersIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <line x1="21" x2="14" y1="4" y2="4" />
      <line x1="10" x2="3" y1="4" y2="4" />
      <line x1="21" x2="12" y1="12" y2="12" />
      <line x1="8" x2="3" y1="12" y2="12" />
      <line x1="21" x2="16" y1="20" y2="20" />
      <line x1="12" x2="3" y1="20" y2="20" />
      <line x1="14" x2="14" y1="2" y2="6" />
      <line x1="8" x2="8" y1="10" y2="14" />
      <line x1="16" x2="16" y1="18" y2="22" />
    </Icon>
  );
}

/** The shelf opens upward, so its disclosure mark names that direction. */
export function ChevronUpIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m18 15-6-6-6 6" />
    </Icon>
  );
}

/** A selected menu item, kept as geometry rather than a text glyph. */
export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m20 6-11 11-5-5" />
    </Icon>
  );
}

export function DownloadIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </Icon>
  );
}

export function SaveIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
      <path d="M7 3v4a1 1 0 0 0 1 1h7" />
    </Icon>
  );
}

export function UndoIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
    </Icon>
  );
}

export function RedoIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" />
    </Icon>
  );
}

/** A solid square, against BoxSelect's dashed one: a shape, not a hint. */
export function SquareIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <polygon points="6 3 20 12 6 21 6 3" />
    </Icon>
  );
}

export function PauseIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="14" y="4" width="4" height="16" rx="1" />
      <rect x="6" y="4" width="4" height="16" rx="1" />
    </Icon>
  );
}

/**
 * `route` for tracking: a path from one point to another, which is what a run
 * produces. Not a crosshair, which says aiming, and not a target, which says
 * the thing rather than its journey.
 */
export function RouteIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="6" cy="19" r="3" />
      <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
      <circle cx="18" cy="5" r="3" />
    </Icon>
  );
}

/** A filled square, for stopping a run. The universal one, and unmistakable. */
export function StopIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </Icon>
  );
}
