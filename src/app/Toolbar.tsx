import type { JSX } from 'preact';
import type { BrushMode } from '../core/render/rotyl-engine.ts';
import { BrushIcon, ContrastIcon, EraserIcon, SlidersIcon, TrashIcon } from './icons.tsx';

export interface ToolbarProps {
  readonly tool: BrushMode;
  readonly onToolChange: (tool: BrushMode) => void;
  readonly onClear: () => void;
  readonly onInvert: () => void;
  readonly stylePanelOpen: boolean;
  readonly onToggleStylePanel: () => void;
}

interface ToolProps {
  readonly label: string;
  readonly icon: JSX.Element;
  readonly onClick: () => void;
  readonly className?: string;
  readonly pressed?: boolean;
  readonly expanded?: boolean;
}

/**
 * The label is a span rather than a bare text node so it can be dropped when
 * the viewport is too narrow for the full toolbar. `aria-label` carries the
 * name regardless, so collapsing to icons costs nothing to a screen reader.
 */
function Tool({ label, icon, onClick, className, pressed, expanded }: ToolProps): JSX.Element {
  return (
    <button
      type="button"
      class={`tool${className ? ` ${className}` : ''}`}
      onClick={onClick}
      aria-label={label}
      title={label}
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
  stylePanelOpen,
  onToggleStylePanel,
}: ToolbarProps): JSX.Element {
  return (
    <div class="toolbar" role="toolbar" aria-label="Selection and style">
      <Tool
        label="Select"
        icon={<BrushIcon />}
        pressed={tool === 'paint'}
        className={tool === 'paint' ? 'tool--active' : ''}
        onClick={() => {
          onToolChange('paint');
        }}
      />
      <Tool
        label="Erase"
        icon={<EraserIcon />}
        pressed={tool === 'erase'}
        className={tool === 'erase' ? 'tool--active' : ''}
        onClick={() => {
          onToolChange('erase');
        }}
      />

      <span class="toolbar__divider" aria-hidden="true" />

      <Tool label="Clear" icon={<TrashIcon />} onClick={onClear} />
      <Tool label="Invert" icon={<ContrastIcon />} onClick={onInvert} />

      <span class="toolbar__divider" aria-hidden="true" />

      <Tool
        label="Style"
        icon={<SlidersIcon />}
        expanded={stylePanelOpen}
        className={stylePanelOpen ? 'tool--open' : ''}
        onClick={onToggleStylePanel}
      />
    </div>
  );
}
