import { createPortal } from 'preact/compat';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { StyleControls, StyleDefinition } from '../core/style/style.ts';
import { CheckIcon, ChevronUpIcon } from './icons.tsx';

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

interface SelectOption {
  readonly value: string;
  readonly label: string;
}

interface ShelfSelectProps {
  readonly id: string;
  readonly label: string;
  readonly options: readonly SelectOption[];
  readonly value: string;
  readonly className?: string;
  readonly onChange: (value: string) => void;
}

interface MenuPosition {
  readonly left: number;
  readonly bottom: number;
  readonly width: number;
}

/**
 * The shelf's one choice instrument, shared by Style and Palette.
 *
 * Its list is portalled to the document surface so a palette near the right
 * edge can rise above the shelf even while the parameter rail scrolls.
 */
function ShelfSelect({ id, label, options, value, className = '', onChange }: ShelfSelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition>({ left: 0, bottom: 0, width: 132 });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const optionButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex] ?? options[0];

  const placeMenu = useCallback((): void => {
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds) return;
    const width = Math.max(132, bounds.width + 12);
    setPosition({
      left: Math.max(8, Math.min(bounds.left - 6, globalThis.innerWidth - width - 8)),
      bottom: globalThis.innerHeight - bounds.top + 6,
      width,
    });
  }, []);

  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    placeMenu();
    const frame = requestAnimationFrame(() => optionButtons.current[selectedIndex]?.focus());
    const closeFromOutside = (event: PointerEvent): void => {
      const path = event.composedPath();
      if (root.current && path.includes(root.current)) return;
      if (menu.current && path.includes(menu.current)) return;
      setOpen(false);
    };
    globalThis.addEventListener('pointerdown', closeFromOutside);
    globalThis.addEventListener('resize', placeMenu);
    globalThis.addEventListener('scroll', placeMenu, true);
    return () => {
      cancelAnimationFrame(frame);
      globalThis.removeEventListener('pointerdown', closeFromOutside);
      globalThis.removeEventListener('resize', placeMenu);
      globalThis.removeEventListener('scroll', placeMenu, true);
    };
  }, [open, placeMenu, selectedIndex]);

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!open && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      placeMenu();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const current = optionButtons.current.findIndex((button) => button === document.activeElement);
    let next: number | undefined;
    if (event.key === 'ArrowUp') next = current <= 0 ? options.length - 1 : current - 1;
    if (event.key === 'ArrowDown') next = current >= options.length - 1 ? 0 : current + 1;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = options.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    optionButtons.current[next]?.focus();
  };

  const choose = (next: string): void => {
    onChange(next);
    close(true);
  };

  const menuId = `${id}-menu`;

  return (
    <div
      ref={root}
      class={`style-control style-control--select ${className}`.trim()}
      onKeyDown={(event) => {
        handleKeyDown(event);
      }}
    >
      <span class="style-control__name">{label}</span>
      <div class="shelf-dropdown">
        <button
          ref={trigger}
          type="button"
          class="shelf-dropdown__trigger"
          aria-label={`${label}: ${selected?.label ?? ''}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => {
            if (open) close(false);
            else {
              placeMenu();
              setOpen(true);
            }
          }}
        >
          <span class="shelf-dropdown__value">{selected?.label}</span>
          <ChevronUpIcon />
        </button>
      </div>
      {open
        ? createPortal(
            <div
              ref={menu}
              id={menuId}
              class="shelf-dropdown__menu"
              role="listbox"
              aria-label={label}
              style={{
                left: `${String(position.left)}px`,
                bottom: `${String(position.bottom)}px`,
                width: `${String(position.width)}px`,
              }}
              onKeyDown={(event) => {
                handleKeyDown(event);
              }}
            >
              {options.map((option, index) => {
                const active = option.value === value;
                return (
                  <button
                    ref={(node) => {
                      optionButtons.current[index] = node;
                    }}
                    key={option.value}
                    type="button"
                    class="shelf-dropdown__option"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      choose(option.value);
                    }}
                  >
                    <span>{option.label}</span>
                    <span class="shelf-dropdown__check" aria-hidden={!active}>
                      {active ? <CheckIcon /> : null}
                    </span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
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
  return (
    <ShelfSelect
      id={`style-${controlKey}`}
      label={label}
      className="style-control--choice"
      options={options.map((option, index) => ({ value: String(index), label: option }))}
      value={String(value)}
      onChange={(next) => {
        onChange(Number(next));
      }}
    />
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
      <ShelfSelect
        id="style-family"
        label="Style"
        className="style-shelf__type"
        options={styles.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
        value={style.id}
        onChange={(next) => {
          const selected = styles.find((candidate) => candidate.id === next);
          if (selected) onStyleChange(selected);
        }}
      />

      <div class="style-shelf__controls">
        {style.controls.map((spec) =>
          spec.kind === 'choice' ? (
            <Choice
              key={spec.key}
              controlKey={spec.key}
              label={spec.label}
              options={spec.options}
              value={Math.round(controls[spec.key] ?? spec.initial)}
              onChange={(next) => {
                onChange({ ...controls, [spec.key]: next });
              }}
            />
          ) : (
            <Slider
              key={spec.key}
              controlKey={spec.key}
              label={spec.label}
              value={controls[spec.key] ?? spec.initial}
              onInput={(next) => {
                onChange({ ...controls, [spec.key]: next });
              }}
              onInteractionChange={onInteractionChange}
            />
          ),
        )}
      </div>
    </aside>
  );
}
