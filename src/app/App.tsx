import { useCallback, useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { useRotyl, type RotylRuntime } from './use-rotyl.ts';
import { DropZone } from './DropZone.tsx';
import { TopBar } from './TopBar.tsx';
import { Toolbar } from './Toolbar.tsx';
import { StylePanel } from './StylePanel.tsx';
import { Viewport } from './Viewport.tsx';
import { decodeImageFile, describeImageLoadError } from '../platform/image-file.ts';
import { uploadImageToTexture } from '../platform/texture-upload.ts';
import { exportFilename, exportImage } from '../platform/image-export.ts';
import { DEFAULT_COMIC_CONTROLS, type ComicControls } from '../core/style/comic-params.ts';
import type { BrushMode } from '../core/render/rotyl-engine.ts';

interface LoadedFile {
  readonly file: File;
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

const DEFAULT_BRUSH_FRACTION = 0.06;
const BRUSH_STEP = 1.25;

export function App(): JSX.Element {
  const state = useRotyl();

  const [loaded, setLoaded] = useState<LoadedFile | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tool, setTool] = useState<BrushMode>('paint');
  const [brushRadius, setBrushRadius] = useState(64);
  const [controls, setControls] = useState<ComicControls>(DEFAULT_COMIC_CONTROLS);
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<File | undefined>(undefined);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [fitRequest, setFitRequest] = useState(0);

  const runtime: RotylRuntime | undefined = state.status === 'ready' ? state.runtime : undefined;

  const openFile = useCallback(
    async (file: File): Promise<void> => {
      if (!runtime) {
        // Device acquisition is fast but not instant, and a file dropped
        // during it must not be silently discarded.
        setPending(file);
        setBusy('Starting');
        return;
      }
      setError(undefined);
      setBusy('Opening');

      const decoded = await decodeImageFile(file, runtime.maxTextureDimension);
      if (!decoded.ok) {
        setBusy(undefined);
        setError(describeImageLoadError(decoded.error));
        return;
      }

      const { bitmap, width, height } = decoded.value;
      const texture = runtime.engine.loadMedia({ width, height });
      uploadImageToTexture(runtime.device, bitmap, texture);
      // Released immediately: an ImageBitmap holds a full RGBA copy, which is
      // 192 MB for a 48 megapixel photograph.
      bitmap.close();
      runtime.engine.markSourceUploaded();

      // Never zero: a tiny or extreme-aspect image would give a brush that
      // paints nothing, and the grow key multiplies, so it could never recover.
      setBrushRadius(Math.max(1, Math.round(Math.min(width, height) * DEFAULT_BRUSH_FRACTION)));
      setLoaded({ file, name: file.name, width, height });
      setHistoryRevision(runtime.engine.document.revision);
      setBusy(undefined);
    },
    [runtime],
  );

  // Open a file that arrived before the device was ready.
  useEffect(() => {
    if (!runtime || !pending) return;
    setPending(undefined);
    void openFile(pending);
  }, [runtime, pending, openFile]);

  // The engine owns the selection; this only mirrors enough of it to drive the
  // undo and redo buttons.
  useEffect(() => {
    if (!runtime) return undefined;
    return runtime.engine.document.subscribe(() => {
      setHistoryRevision(runtime.engine.document.revision);
    });
  }, [runtime]);

  useEffect(() => {
    runtime?.engine.setControls(controls);
  }, [runtime, controls]);

  const onExport = useCallback(async (): Promise<void> => {
    if (!runtime || !loaded) return;
    setBusy('Exporting');
    setError(undefined);
    try {
      const result = await exportImage({
        device: runtime.device,
        maxTextureDimension: runtime.maxTextureDimension,
        renderer: runtime.engine.compositeRenderer,
        file: loaded.file,
        commands: runtime.engine.document.appliedCommands,
        controls,
        format: 'png',
      });

      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFilename(loaded.name, 'png');
      link.click();
      // Revoked on the next task so the download has taken the reference; a
      // leaked object URL pins the whole encoded image in memory.
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Export failed.');
    } finally {
      // Export replaced the style chain's stage textures with
      // export-resolution ones; the next interactive frame rebuilds them.
      runtime.engine.invalidateStyle();
      setBusy(undefined);
    }
  }, [runtime, loaded, controls]);

  // --- keyboard ---
  useEffect(() => {
    if (!runtime || !loaded) return undefined;

    // Single-key shortcuts must not fire while a control has focus: a slider
    // answers to arrow keys, and a focused button to Space, so swallowing keys
    // globally would silently change the tool under someone navigating the UI.
    const isTypingTarget = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName));

    const onKeyDown = (event: KeyboardEvent): void => {
      const engine = runtime.engine;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) engine.document.redo();
        else engine.document.undo();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      switch (event.key) {
        case 'b':
          setTool('paint');
          break;
        case 'e':
          setTool('erase');
          break;
        case '[':
          setBrushRadius((radius) => Math.max(1, Math.round(radius / BRUSH_STEP)));
          break;
        case ']':
          setBrushRadius((radius) => Math.min(4096, Math.round(radius * BRUSH_STEP) + 1));
          break;
        case '0':
          // The only way back when the image has been panned out of sight.
          setFitRequest((n) => n + 1);
          break;
        case '\\':
          // Hold to see the result without the selection overlay on top of it.
          setOverlayVisible(false);
          break;
        default:
          break;
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === '\\') setOverlayVisible(true);
    };

    // The keyup for a held key is delivered to whichever window has focus, so
    // switching away mid-peek would otherwise leave the overlay off for good.
    const restoreOverlay = (): void => {
      setOverlayVisible(true);
    };

    globalThis.addEventListener('keydown', onKeyDown);
    globalThis.addEventListener('keyup', onKeyUp);
    globalThis.addEventListener('blur', restoreOverlay);
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown);
      globalThis.removeEventListener('keyup', onKeyUp);
      globalThis.removeEventListener('blur', restoreOverlay);
    };
  }, [runtime, loaded]);

  // A file dropped anywhere other than the drop zone would otherwise be opened
  // by the browser itself, navigating away and discarding the session.
  useEffect(() => {
    const swallow = (event: DragEvent): void => {
      event.preventDefault();
    };
    globalThis.addEventListener('dragover', swallow);
    globalThis.addEventListener('drop', swallow);
    return () => {
      globalThis.removeEventListener('dragover', swallow);
      globalThis.removeEventListener('drop', swallow);
    };
  }, []);

  if (state.status === 'unsupported') {
    return (
      <div class="app">
        <TopBar canUndo={false} canRedo={false} onUndo={noop} onRedo={noop} onExport={noop} exportDisabled />
        <div class="dropzone-region">
          <p class="notice notice--quiet">
            Rotyl renders on the GPU and needs WebGPU. It is available in Chrome and Edge 113 and later,
            Safari 26 and later, and recent Firefox.
          </p>
        </div>
      </div>
    );
  }

  if (state.status === 'lost') {
    return (
      <div class="app">
        <TopBar canUndo={false} canRedo={false} onUndo={noop} onRedo={noop} onExport={noop} exportDisabled />
        <div class="dropzone-region">
          <p class="notice">The graphics device was lost. Reload to continue.</p>
        </div>
      </div>
    );
  }

  const selection = runtime?.engine.document;
  // historyRevision is read so that undo and redo re-evaluate when the log moves.
  void historyRevision;

  return (
    <div class="app">
      <TopBar
        {...(loaded ? { file: { name: loaded.name, width: loaded.width, height: loaded.height } } : {})}
        {...(busy ? { status: busy } : {})}
        canUndo={selection?.canUndo ?? false}
        canRedo={selection?.canRedo ?? false}
        onUndo={() => selection?.undo()}
        onRedo={() => selection?.redo()}
        onExport={() => void onExport()}
        exportDisabled={!loaded || busy !== undefined}
      />

      {loaded && runtime ? (
        <div class="editor">
          <Viewport
            runtime={runtime}
            tool={tool}
            brushRadius={brushRadius}
            overlayVisible={overlayVisible}
            paused={busy !== undefined}
            fitRequest={fitRequest}
            onSelectionChanged={() => {
              setHistoryRevision(runtime.engine.document.revision);
            }}
          >
            {/*
              Rendered inside the viewport, not beside it. Positioned against
              the editor it centred on the whole editor including the docked
              panel, so it drifted off the image the moment the panel opened.
            */}
            <Toolbar
              tool={tool}
              onToolChange={setTool}
              onClear={() => {
                runtime.engine.document.apply({ kind: 'clear' });
              }}
              onInvert={() => {
                runtime.engine.document.apply({ kind: 'invert' });
              }}
              stylePanelOpen={stylePanelOpen}
              onToggleStylePanel={() => {
                setStylePanelOpen((open) => !open);
              }}
            />
          </Viewport>
          {stylePanelOpen ? (
            <StylePanel
              controls={controls}
              onChange={setControls}
              onInteractionChange={(dragging) => {
                // Drop the flatten stage's resolution while a slider is moving,
                // then settle back to full quality on release.
                runtime.engine.setQuality(dragging ? 'draft' : 'full');
                setOverlayVisible(!dragging);
              }}
            />
          ) : null}
        </div>
      ) : (
        <DropZone onFile={(file) => void openFile(file)} notice={error} />
      )}

      {/*
        One live region for both states. Status and errors are otherwise
        entirely silent to a screen reader, and an export that fails while an
        image is loaded had no visible surface at all.
      */}
      <div class="announcer" role="status" aria-live="polite">
        {loaded && error ? <p class="notice notice--floating">{error}</p> : null}
      </div>
    </div>
  );
}

function noop(): void {
  /* placeholder for the states with no document loaded */
}
