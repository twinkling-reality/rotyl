import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Activity } from './Activity.tsx';
import { CloseIcon, DownloadIcon, RedoIcon, UndoIcon } from './icons.tsx';

export interface TopBarProps {
  readonly file?: {
    readonly name: string;
    readonly width: number;
    readonly height: number;
    /**
     * A fact about this file that the export cannot honour, or nothing.
     *
     * A STATE AND NOT AN EVENT, which is why it sits here beside the name and
     * the size rather than in the line reports and failures share. A soundtrack
     * an MP4 cannot carry is true for as long as the file is open, and the line
     * below the canvas is for things that JUST happened and take themselves
     * down again after ten seconds.
     */
    readonly note?: string;
  };
  readonly status?: string;
  /** 0 to 1 where the status has a real fraction behind it. */
  readonly statusProgress?: number | undefined;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  /** What to write: the frame on screen, or every frame. */
  readonly onExport: (what: 'frame' | 'clip') => void;
  readonly exportDisabled: boolean;
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
  onExport,
  exportDisabled,
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
        {file ? <CloseFile onClose={onClose} hasEdits={hasEdits} /> : null}
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
              <span class="file-status__name">{file.name}</span>
              <span class="file-status__separator" aria-hidden="true">
                ·
              </span>
              {/* U+00D7, not the letter x. */}
              <span class="file-status__meta mono">{`${String(file.width)} × ${String(file.height)}`}</span>
              {file.note ? (
                <>
                  <span class="file-status__separator" aria-hidden="true">
                    ·
                  </span>
                  <span class="file-status__note">{file.note}</span>
                </>
              ) : null}
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
 * Leaving, and being asked once when leaving costs something.
 *
 * A selection is a few minutes of careful work with no file behind it, so a
 * stray click on an X should not take it. This product has no dialogs anywhere,
 * and adding one here for a decision this small would be a heavier answer than
 * the problem: the button asks in place instead, and forgets it was asking
 * after a few seconds so it cannot sit there armed.
 *
 * With nothing to lose it just closes, because a confirmation nobody needs is
 * the fastest way to teach people to click through confirmations.
 */
function CloseFile({ onClose, hasEdits }: { onClose: () => void; hasEdits: boolean }): JSX.Element {
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!asking) return undefined;
    const timer = setTimeout(() => {
      setAsking(false);
    }, ASKS_FOR);
    return () => {
      clearTimeout(timer);
    };
  }, [asking]);

  if (asking) {
    return (
      <button type="button" class="close-file close-file--asking" onClick={onClose}>
        Discard edits?
      </button>
    );
  }

  return (
    <button
      type="button"
      class="close-file icon-button"
      title="Close"
      onClick={() => {
        if (hasEdits) setAsking(true);
        else onClose();
      }}
    >
      <CloseIcon />
      <span class="visually-hidden">Close</span>
    </button>
  );
}

/** Long enough to answer, short enough that it is never still armed later. */
const ASKS_FOR = 4000;
