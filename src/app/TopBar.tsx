import { Fragment, type JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Activity } from './Activity.tsx';
import { CloseIcon, DownloadIcon, RedoIcon, SaveIcon, UndoIcon } from './icons.tsx';

export interface TopBarProps {
  readonly file?: {
    readonly name: string;
    readonly width: number;
    readonly height: number;
    /**
     * Facts about this file that stay true for as long as it is open.
     *
     * STATES AND NOT EVENTS, which is why they sit here beside the name and the
     * size rather than in the line reports and failures share. A soundtrack an
     * MP4 cannot carry is one; a restored selection that was saved against a
     * different copy of this file is the other. The line below the canvas is
     * for things that JUST happened and take themselves down again after ten
     * seconds, and neither of these is one of those.
     *
     * A LIST RATHER THAN ONE, because both can be true at once and the second
     * one arriving must not silently replace the first.
     */
    readonly notes?: readonly string[];
  };
  readonly status?: string;
  /** 0 to 1 where the status has a real fraction behind it. */
  readonly statusProgress?: number | undefined;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  /** Write the command log out as a document. */
  readonly onSave: () => void;
  /** What to write: the frame on screen, or every frame. */
  readonly onExport: (what: 'frame' | 'clip') => void;
  readonly exportDisabled: boolean;
  /** Whatever else is going on, which a save must not run alongside. */
  readonly saveDisabled: boolean;
  /** Whether there is a clip to write, as opposed to one picture. */
  readonly canExportClip: boolean;
  /** What pressing Clip will do, including the range and the sound. */
  readonly clipTitle: string;
  /** A clip export in progress, which is the only one long enough to stop. */
  readonly exporting: boolean;
  readonly onCancelExport: () => void;
  /** Give the file back and return to the drop zone. */
  readonly onClose: () => void;
  /** Whether closing would discard work, which decides if it asks first. */
  readonly hasEdits: boolean;
}

export function TopBar({
  file,
  status,
  statusProgress,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSave,
  onExport,
  exportDisabled,
  saveDisabled,
  canExportClip,
  clipTitle,
  exporting,
  onCancelExport,
  onClose,
  hasEdits,
}: TopBarProps): JSX.Element {
  return (
    <header class={`top-bar${file ? ' top-bar--editing' : ''}`}>
      <div class="top-bar__lead">
        <h1 class="wordmark">Rotyl</h1>
      </div>

      {/*
        Status renders whether or not a file is loaded. Nesting it inside the
        file branch made "Opening" unreachable. It is set before `loaded` is,
        so the one moment the user needs feedback showed nothing at all.
      */}
      {file || status ? (
        <div class="file-status">
          {file ? (
            <>
              <span class="file-status__identity">
                <span class="file-status__name">{file.name}</span>
                <CloseFile onClose={onClose} hasEdits={hasEdits} />
              </span>
              <span class="file-status__separator" aria-hidden="true">
                ·
              </span>
              {/* U+00D7, not the letter x. */}
              <span class="file-status__meta mono">{`${String(file.width)} × ${String(file.height)}`}</span>
              {(file.notes ?? []).map((note) => (
                <Fragment key={note}>
                  <span class="file-status__separator" aria-hidden="true">
                    ·
                  </span>
                  <span class="file-status__note">{note}</span>
                </Fragment>
              ))}
            </>
          ) : null}
          {status ? (
            <>
              {file ? (
                <span class="file-status__separator" aria-hidden="true">
                  ·
                </span>
              ) : null}
              <Activity label={status} progress={statusProgress} />
            </>
          ) : null}
        </div>
      ) : (
        <span />
      )}

      {file ? (
        <div class="top-bar__actions">
          <button type="button" class="icon-button" onClick={onUndo} disabled={!canUndo} title="Undo">
            <UndoIcon />
            <span class="visually-hidden">Undo</span>
          </button>
          <button type="button" class="icon-button" onClick={onRedo} disabled={!canRedo} title="Redo">
            <RedoIcon />
            <span class="visually-hidden">Redo</span>
          </button>
          <button
            type="button"
            class="save-button"
            onClick={onSave}
            disabled={!hasEdits || saveDisabled}
            title={
              hasEdits
                ? 'Save the selection as a .rotyl document, to open again with this file'
                : 'Nothing has been selected yet'
            }
          >
            <SaveIcon />
            Save
          </button>
          <ExportControl
            onExport={onExport}
            disabled={exportDisabled}
            canExportClip={canExportClip}
            clipTitle={clipTitle}
            exporting={exporting}
            onCancel={onCancelExport}
          />
        </div>
      ) : (
        /*
          Only before a file is open, where this corner is empty anyway. Once
          there is something to edit it becomes undo, redo and Export, and a
          link to a measurements page has no business competing with those.
          nobody reads a benchmark while they are working.
        */
        <a class="top-bar__research" href="/research.html">
          Research
        </a>
      )}
    </header>
  );
}

/**
 * Saving, which is one thing for a photograph and two for a clip.
 *
 * A photograph has one answer and gets one button. A clip has two, and the one
 * that gets the weight is the clip, because the clip is what somebody opened a
 * video to make. Saving the frame on screen stays a text button beside it,
 * quieter by size and colour rather than by being hidden behind anything.
 *
 * While a clip is being written the pair becomes a single Stop, in place. A
 * clip export is minutes of work on the comic style and seconds on the other
 * two, and an operation that cannot be called off is a hang with a progress
 * bar on it. It replaces the buttons rather than sitting beside them because
 * there is exactly one thing to do while it runs.
 *
 * AND STOPPING KEEPS WHAT WAS WRITTEN, which the button has to say rather than
 * leave in a comment. It used to abandon, which was honest while the file
 * existed only in memory and nothing had been promised; once the bytes are
 * going into a file the user named, abandoning leaves an empty file where they
 * asked for a video. The label stays one word because the button is pressed
 * under time pressure, and the sentence lives where a button's second sentence
 * lives here, in the title every other control in this product uses.
 */
function ExportControl({
  onExport,
  disabled,
  canExportClip,
  clipTitle,
  exporting,
  onCancel,
}: {
  onExport: (what: 'frame' | 'clip') => void;
  disabled: boolean;
  canExportClip: boolean;
  clipTitle: string;
  exporting: boolean;
  onCancel: () => void;
}): JSX.Element {
  if (exporting) {
    return (
      <button
        type="button"
        class="export-button export-button--stop"
        title="Stop, and keep what has been written"
        onClick={onCancel}
      >
        Stop
      </button>
    );
  }

  if (!canExportClip) {
    return (
      <button
        type="button"
        class="export-button"
        onClick={() => {
          onExport('frame');
        }}
        disabled={disabled}
      >
        <DownloadIcon />
        Export
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        class="text-button"
        onClick={() => {
          onExport('frame');
        }}
        disabled={disabled}
      >
        Frame
      </button>
      <button
        type="button"
        class="export-button"
        title={clipTitle}
        onClick={() => {
          onExport('clip');
        }}
        disabled={disabled}
      >
        <DownloadIcon />
        Clip
      </button>
    </>
  );
}

/**
 * Leaving, and asking before it costs something.
 *
 * A selection is a few minutes of careful work with no file behind it, so a
 * stray click on a close control should not take it. The question opens beside
 * the filename because that is the thing being closed. Cancel is visible,
 * Escape cancels too, and the question still expires so it cannot sit armed.
 *
 * With nothing to lose it closes immediately.
 */
function CloseFile({ onClose, hasEdits }: { onClose: () => void; hasEdits: boolean }): JSX.Element {
  const [asking, setAsking] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  const cancelAsking = useCallback((): void => {
    setAsking(false);
    requestAnimationFrame(() => closeButton.current?.focus());
  }, []);

  useEffect(() => {
    if (!asking) return undefined;
    cancelButton.current?.focus();
    const timer = setTimeout(() => {
      setAsking(false);
    }, ASKS_FOR);
    return () => {
      clearTimeout(timer);
    };
  }, [asking]);

  return (
    <span
      class="close-file"
      onKeyUp={(event) => {
        if (!asking || event.key !== 'Escape') return;
        event.preventDefault();
        cancelAsking();
      }}
    >
      <button
        ref={closeButton}
        type="button"
        class="close-file__trigger icon-button"
        title={asking ? 'Cancel closing this file' : 'Close file'}
        aria-expanded={hasEdits ? asking : undefined}
        onClick={() => {
          if (!hasEdits) onClose();
          else if (asking) cancelAsking();
          else setAsking(true);
        }}
      >
        <CloseIcon />
        <span class="visually-hidden">Close file</span>
      </button>
      {asking ? (
        <span class="close-file__question" role="group" aria-label="Discard edits?">
          <span class="close-file__prompt">Discard edits?</span>
          <button ref={cancelButton} type="button" class="close-file__choice" onClick={cancelAsking}>
            Cancel
          </button>
          <button type="button" class="close-file__choice close-file__choice--discard" onClick={onClose}>
            Discard
          </button>
        </span>
      ) : null}
    </span>
  );
}

/** Long enough to answer, short enough that it is never still armed later. */
const ASKS_FOR = 4000;
