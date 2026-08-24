import type { JSX } from 'preact';
import type { Tool } from './tool.ts';
import {
  BoxSelectIcon,
  BrushIcon,
  ContrastIcon,
  EraserIcon,
  PointerClickIcon,
  RouteIcon,
  SlidersIcon,
  SquareIcon,
  StopIcon,
  TrashIcon,
} from './icons.tsx';

export interface ToolbarProps {
  readonly tool: Tool;
  readonly onToolChange: (tool: Tool) => void;
  readonly onClear: () => void;
  readonly onInvert: () => void;
  readonly styleShelfOpen: boolean;
  readonly onToggleStyleShelf: () => void;
  /**
   * Following the selection forward, when there is a clip to follow it through
   * and a selection to follow.
   *
   * ABSENT RATHER THAN DISABLED for a photograph, which has no later frames. A
   * greyed button there would promise something the document cannot have.
   */
  readonly tracking?: {
    readonly running: boolean;
    readonly disabled: boolean;
    /**
     * What pressing it will do, which is now a question with more than one
     * answer: a selection made of three model answers is three objects to
     * follow, and the label cannot say so without becoming a sentence.
     */
    readonly title: string;
    readonly onTrack: () => void;
    readonly onStop: () => void;
  };
}

interface ToolButtonProps {
  readonly label: string;
  /** What pressing it does, where that is more than the label can carry. */
  readonly title?: string;
  readonly icon: JSX.Element;
  readonly onClick: () => void;
  readonly className?: string;
  readonly pressed?: boolean;
  readonly expanded?: boolean;
  readonly disabled?: boolean;
}

/**
 * The label is a span rather than a bare text node so it can be dropped when
 * the viewport is too narrow for the full toolbar. `aria-label` carries the
 * name regardless, so collapsing to icons costs nothing to a screen reader.
 */
function ToolButton({
  label,
  title,
  icon,
  onClick,
  className,
  pressed,
  expanded,
  disabled,
}: ToolButtonProps): JSX.Element {
  return (
    <button
      type="button"
      class={`tool${className ? ` ${className}` : ''}`}
      onClick={onClick}
      aria-label={label}
      title={title ?? label}
      {...(disabled === undefined ? {} : { disabled })}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
    >
      {icon}
      <span class="tool__label">{label}</span>
    </button>
  );
}

export function Toolbar({
  tool,
  onToolChange,
  onClear,
  onInvert,
  styleShelfOpen,
  onToggleStyleShelf,
  tracking,
}: ToolbarProps): JSX.Element {
  return (
    <div class="toolbar" role="toolbar" aria-label="Selection and style">
      <ToolButton
        label="Object"
        icon={<PointerClickIcon />}
        pressed={tool === 'object'}
        className={tool === 'object' ? 'tool--active' : ''}
        onClick={() => {
          onToolChange('object');
        }}
      />
      <ToolButton
        label="Box"
        icon={<BoxSelectIcon />}
        pressed={tool === 'box'}
        className={tool === 'box' ? 'tool--active' : ''}
        onClick={() => {
          onToolChange('box');
        }}
      />
      {/*
        The divider is load-bearing. Object and Box ask a model what is there;
        everything to the right of it draws exactly what you draw. Box and Area
        are the same gesture meaning opposite things, and putting them on
        opposite sides of a line is the cheapest way to say so.
      */}
      <div class="toolbar__divider" role="separator" />
      <ToolButton
        label="Area"
        icon={<SquareIcon />}
        pressed={tool === 'rect'}
        className={tool === 'rect' ? 'tool--active' : ''}
        onClick={() => {
          onToolChange('rect');
        }}
      />
      <ToolButton
        label="Brush"
        icon={<BrushIcon />}
        pressed={tool === 'paint'}
        className={tool === 'paint' ? 'tool--active' : ''}
        onClick={() => {
          onToolChange('paint');
        }}
      />
      <ToolButton
        label="Erase"
        icon={<EraserIcon />}
        pressed={tool === 'erase'}
        className={tool === 'erase' ? 'tool--active' : ''}
        onClick={() => {
          onToolChange('erase');
        }}
      />

      <span class="toolbar__divider" aria-hidden="true" />

      <ToolButton label="Clear" icon={<TrashIcon />} onClick={onClear} />
      <ToolButton label="Invert" icon={<ContrastIcon />} onClick={onInvert} />
      {/*
        One button, and Stop replaces it rather than sitting beside it, which is
        what the clip export does and for the same reason: while a run is going
        there is exactly one thing to do to it. What it found so far is kept,
        because a run abandoned half way has followed the object as far as it
        got and there is already a button for taking that back.
      */}
      {tracking ? (
        tracking.running ? (
          <ToolButton label="Stop" icon={<StopIcon />} className="tool--running" onClick={tracking.onStop} />
        ) : (
          <ToolButton
            label="Track"
            title={tracking.title}
            icon={<RouteIcon />}
            disabled={tracking.disabled}
            onClick={tracking.onTrack}
          />
        )
      ) : null}

      <span class="toolbar__divider" aria-hidden="true" />

      <ToolButton
        label="Style"
        icon={<SlidersIcon />}
        expanded={styleShelfOpen}
        className={styleShelfOpen ? 'tool--open' : ''}
        onClick={onToggleStyleShelf}
      />
    </div>
  );
}
