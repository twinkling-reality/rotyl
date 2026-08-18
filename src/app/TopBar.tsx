import type { JSX } from 'preact';
import { DownloadIcon, RedoIcon, UndoIcon } from './icons.tsx';

export interface TopBarProps {
  readonly file?: { readonly name: string; readonly width: number; readonly height: number };
  readonly status?: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onExport: () => void;
  readonly exportDisabled: boolean;
}

export function TopBar({
  file,
  status,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onExport,
  exportDisabled,
}: TopBarProps): JSX.Element {
  return (
    <header class={`top-bar${file ? ' top-bar--editing' : ''}`}>
      <h1 class="wordmark">Rotyl</h1>

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
              <span class="file-status__meta">{status}</span>
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
