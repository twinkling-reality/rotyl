import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Activity } from './Activity.tsx';
import { CloseIcon, DownloadIcon, RedoIcon, UndoIcon } from './icons.tsx';

export interface TopBarProps {
  readonly file?: { readonly name: string; readonly width: number; readonly height: number };
  readonly status?: string;
  /** 0 to 1 where the status has a real fraction behind it. */
  readonly statusProgress?: number | undefined;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onExport: () => void;
  readonly exportDisabled: boolean;
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
          <button type="button" class="export-button" onClick={onExport} disabled={exportDisabled}>
            <DownloadIcon />
            Export
          </button>
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
