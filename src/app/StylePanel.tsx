import type { JSX } from 'preact';
import type { StyleControls, StyleDefinition } from '../core/style/style.ts';

export interface StylePanelProps {
  readonly styles: readonly StyleDefinition[];
  readonly style: StyleDefinition;
  readonly controls: StyleControls;
  readonly onStyleChange: (style: StyleDefinition) => void;
  readonly onChange: (controls: StyleControls) => void;
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

interface ChoiceProps {
  readonly label: string;
  readonly options: readonly string[];
  readonly value: number;
  readonly onChange: (value: number) => void;
}

/**
 * A control with no meaningful midpoint.
 *
 * Buttons rather than a track, because half way between two palettes is not a
 * palette. It reuses the style picker's own segmented control at the top of
 * this panel: the two are the same gesture, choosing one of a short list, and
 * they should not look like different kinds of thing.
 */
function Choice({ label, options, value, onChange }: ChoiceProps): JSX.Element {
  return (
    <div class="slider-field">
      <div class="slider-field__labels">
        <span class="slider-field__name">{label}</span>
      </div>
      <div class="style-choice" role="group" aria-label={label}>
        {options.map((option, index) => {
          const active = index === value;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              class={`style-choice__option${active ? ' style-choice__option--active' : ''}`}
              onClick={() => {
                onChange(index);
              }}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Style controls, docked rather than floating.
 *
 * A popover centred over the image would cover the very thing the user is
 * judging while they drag Strength. Docking costs 280px of viewport and makes
 * the result continuously visible, which for this product is the whole point.
 *
 * The sliders are BUILT FROM THE STYLE, not written here. A style declares its
 * controls and this renders them, so a style with three of them needs no UI
 * code of its own, which is the same seam the renderer has, arriving at the
 * one layer where it would otherwise be tempting to special-case.
 */
export function StylePanel({
  styles,
  style,
  controls,
  onStyleChange,
  onChange,
  onInteractionChange,
}: StylePanelProps): JSX.Element {
  return (
    <aside class="style-panel" aria-label="Style controls">
      <div class="style-panel__header">
        <div class="style-choice" role="group" aria-label="Style">
          {styles.map((candidate) => {
            const active = candidate.id === style.id;
            return (
              <button
                key={candidate.id}
                type="button"
                aria-pressed={active}
                class={`style-choice__option${active ? ' style-choice__option--active' : ''}`}
                onClick={() => {
                  onStyleChange(candidate);
                }}
              >
                {candidate.name}
              </button>
            );
          })}
        </div>
        <span class="style-panel__hint mono">local</span>
      </div>

      {style.controls.map((spec) =>
        spec.kind === 'choice' ? (
          <Choice
            key={spec.key}
            label={spec.label}
            options={spec.options}
            value={Math.round(controls[spec.key] ?? spec.initial)}
            onChange={(value) => {
              onChange({ ...controls, [spec.key]: value });
            }}
          />
        ) : (
          <Slider
            key={spec.key}
            label={spec.label}
            value={controls[spec.key] ?? spec.initial}
            onInput={(value) => {
              onChange({ ...controls, [spec.key]: value });
            }}
            onInteractionChange={onInteractionChange}
          />
        ),
      )}
    </aside>
  );
}
