import type { JSX } from 'preact';
import type { StyleControls, StyleDefinition } from '../core/style/style.ts';

export interface StyleShelfProps {
  readonly styles: readonly StyleDefinition[];
  readonly style: StyleDefinition;
  readonly controls: StyleControls;
  readonly onStyleChange: (style: StyleDefinition) => void;
  readonly onChange: (controls: StyleControls) => void;
  readonly onInteractionChange: (dragging: boolean) => void;
}

interface SliderProps {
  readonly controlKey: string;
  readonly label: string;
  readonly value: number;
  readonly onInput: (value: number) => void;
  readonly onInteractionChange: (dragging: boolean) => void;
}

function Slider({ controlKey, label, value, onInput, onInteractionChange }: SliderProps): JSX.Element {
  const id = `style-${controlKey}`;
  return (
    <div class="style-control style-control--slider">
      <div class="style-control__labels">
        <label class="style-control__name" for={id}>
          {label}
        </label>
        <span class="style-control__value mono">{value.toFixed(2)}</span>
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
  readonly controlKey: string;
  readonly label: string;
  readonly options: readonly string[];
  readonly value: number;
  readonly onChange: (value: number) => void;
}

/** A short list with no meaningful midpoint, presented as a compact dropup. */
function Choice({ controlKey, label, options, value, onChange }: ChoiceProps): JSX.Element {
  const id = `style-${controlKey}`;
  return (
    <div class="style-control style-control--choice">
      <label class="style-control__name" for={id}>
        {label}
      </label>
      <span class="style-select style-select--control">
        <select
          id={id}
          class="style-select__input"
          value={String(value)}
          onChange={(event) => {
            onChange(Number(event.currentTarget.value));
          }}
        >
          {options.map((option, index) => (
            <option key={option} value={String(index)}>
              {option}
            </option>
          ))}
        </select>
        <span class="style-select__chevron" aria-hidden="true" />
      </span>
    </div>
  );
}

/**
 * Style controls attached to the floating toolbar.
 *
 * The canvas keeps its full width. The active style occupies the shelf's left
 * edge as a dropup, and the controls declared by that style form one horizontal
 * instrument to its right. On a narrow viewport only the parameter rail
 * scrolls, so the style name and the toolbar stay put.
 */
export function StyleShelf({
  styles,
  style,
  controls,
  onStyleChange,
  onChange,
  onInteractionChange,
}: StyleShelfProps): JSX.Element {
  return (
    <aside class="style-shelf" aria-label="Style controls" data-controls={style.controls.length}>
      <div class="style-shelf__type">
        <label class="visually-hidden" for="style-family">
          Style
        </label>
        <span class="style-select style-select--family">
          <select
            id="style-family"
            class="style-select__input"
            value={style.id}
            onChange={(event) => {
              const selected = styles.find((candidate) => candidate.id === event.currentTarget.value);
              if (selected) onStyleChange(selected);
            }}
          >
            {styles.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          <span class="style-select__chevron" aria-hidden="true" />
        </span>
      </div>

      <div class="style-shelf__controls">
        {style.controls.map((spec) =>
          spec.kind === 'choice' ? (
            <Choice
              key={spec.key}
              controlKey={spec.key}
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
              controlKey={spec.key}
              label={spec.label}
              value={controls[spec.key] ?? spec.initial}
              onInput={(value) => {
                onChange({ ...controls, [spec.key]: value });
              }}
              onInteractionChange={onInteractionChange}
            />
          ),
        )}
      </div>
    </aside>
  );
}
