import type { JSX } from 'preact';
import type { ComicControls } from '../core/style/comic-params.ts';

export interface StylePanelProps {
  readonly controls: ComicControls;
  readonly onChange: (controls: ComicControls) => void;
  readonly onInteractionChange: (dragging: boolean) => void;
}

interface SliderProps {
  readonly label: string;
  readonly value: number;
  readonly onInput: (value: number) => void;
  readonly onInteractionChange: (dragging: boolean) => void;
}

function Slider({ label, value, onInput, onInteractionChange }: SliderProps): JSX.Element {
  const id = `slider-${label.toLowerCase()}`;
  return (
    <div class="slider-field">
      <div class="slider-field__labels">
        <label class="slider-field__name" for={id}>
          {label}
        </label>
        <span class="slider-field__value mono">{value.toFixed(2)}</span>
      </div>
      <input
        id={id}
        class="slider"
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={value}
        // Drives the track fill; a native range input cannot express a
        // two-tone track without it.
        style={{ '--fill': `${String(value * 100)}%` }}
        onInput={(event) => {
          onInput(Number(event.currentTarget.value));
        }}
        onPointerDown={() => {
          onInteractionChange(true);
        }}
        onPointerUp={() => {
          onInteractionChange(false);
        }}
        onBlur={() => {
          onInteractionChange(false);
        }}
      />
    </div>
  );
}

/**
 * Style controls, docked rather than floating.
 *
 * A popover centred over the image would cover the very thing the user is
 * judging while they drag Strength. Docking costs 280px of viewport and makes
 * the result continuously visible, which for this product is the whole point.
 */
export function StylePanel({ controls, onChange, onInteractionChange }: StylePanelProps): JSX.Element {
  return (
    <aside class="style-panel" aria-label="Style controls">
      <div class="style-panel__header">
        <h2 class="style-panel__title">Comic</h2>
        <span class="style-panel__hint mono">local</span>
      </div>
      <Slider
        label="Strength"
        value={controls.strength}
        onInput={(strength) => {
          onChange({ ...controls, strength });
        }}
        onInteractionChange={onInteractionChange}
      />
      <Slider
        label="Detail"
        value={controls.detail}
        onInput={(detail) => {
          onChange({ ...controls, detail });
        }}
        onInteractionChange={onInteractionChange}
      />
    </aside>
  );
}
