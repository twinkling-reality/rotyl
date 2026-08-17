import type { JSX } from 'preact';
import type { Tool } from './tool.ts';
import {
  BoxSelectIcon,
  BrushIcon,
  ContrastIcon,
  EraserIcon,
  PointerClickIcon,
  SlidersIcon,
  TrashIcon,
} from './icons.tsx';

export interface ToolbarProps {
  readonly tool: Tool;
  readonly onToolChange: (tool: Tool) => void;
  readonly onClear: () => void;
  readonly onInvert: () => void;
  readonly stylePanelOpen: boolean;
  readonly onToggleStylePanel: () => void;
}

interface ToolButtonProps {
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
function ToolButton({ label, icon, onClick, className, pressed, expanded }: ToolButtonProps): JSX.Element {
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

      <span class="toolbar__divider" aria-hidden="true" />

      <ToolButton
        label="Style"
        icon={<SlidersIcon />}
        expanded={stylePanelOpen}
        className={stylePanelOpen ? 'tool--open' : ''}
        onClick={onToggleStylePanel}
      />
    </div>
  );
}
