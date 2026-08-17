import { useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

export interface DropZoneProps {
  readonly onFile: (file: File) => void;
  /** Shown beneath the zone; the reason the last attempt was refused. */
  readonly notice?: string | undefined;
}

/**
 * The empty state.
 *
 * One rectangle and two lines of text. No icon, no hero, no feature list — the
 * rectangle is the affordance, and the product is what happens after it.
 */
export function DropZone({ onFile, notice }: DropZoneProps): JSX.Element {
  const [isOver, setIsOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const take = (list: FileList | null | undefined): void => {
    const file = list?.[0];
    if (file) onFile(file);
  };

  return (
    <div class="dropzone-region">
      <button
        type="button"
        class={`dropzone${isOver ? ' dropzone--over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setIsOver(true);
        }}
        onDragLeave={(event) => {
          // dragleave fires when the pointer crosses onto a child element too,
          // and it bubbles — so an unconditional reset makes the highlight
          // flicker as the cursor passes over the zone's own text.
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          setIsOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsOver(false);
          take(event.dataTransfer?.files);
        }}
      >
        <span class="dropzone__primary">Drop a file, or click to browse</span>
        {/* Named exactly, and only what the loader accepts: WebM plays in the
            browser and is refused here, so listing "video" would be a lie. */}
        <span class="dropzone__secondary">PNG, JPEG, WebP, AVIF, GIF, MP4 or MOV</span>
      </button>

      {notice ? <p class="notice">{notice}</p> : null}

      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/mp4,video/quicktime"
        class="visually-hidden"
        // Not a tab stop: the button above is the control, and a
        // visually-hidden input would otherwise be an invisible focus stop
        // with a focus ring nobody can see.
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const input = event.currentTarget;
          take(input.files);
          // Cleared so that selecting the same file twice still fires a change.
          input.value = '';
        }}
      />
    </div>
  );
}
