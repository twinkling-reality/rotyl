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
import { defaultControls, type StyleControls, type StyleDefinition } from '../core/style/style.ts';
import { DEFAULT_STYLE, STYLES } from '../core/style/styles.ts';
import { isPrompt, type Tool } from './tool.ts';
import type { PerceptionStatus, SelectIntent } from '../core/perception/perception-store.ts';
import type { MaskCandidate } from '../core/perception/mask-candidates.ts';

interface LoadedFile {
  readonly file: File;
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

const DEFAULT_BRUSH_FRACTION = 0.06;
const BRUSH_STEP = 1.25;

/**
 * What the perception layer is doing, in the status line.
 *
 * The download is the only one worth a percentage: it is tens of megabytes and
 * happens once, so a bare "Loading" would look indistinguishable from a hang.
 * The other two are hundreds of milliseconds and a number would just flicker.
 */
function describePerception(status: PerceptionStatus): string | undefined {
  switch (status.kind) {
    case 'loading':
      return `Downloading the object model, ${String(Math.round(status.progress * 100))}%`;
    case 'understanding':
      return 'Reading the image';
    case 'thinking':
      return 'Finding the object';
    default:
      return undefined;
  }
}

export function App(): JSX.Element {
  const state = useRotyl();

  const [loaded, setLoaded] = useState<LoadedFile | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tool, setTool] = useState<Tool>('paint');
  const [perception, setPerception] = useState<PerceptionStatus>({ kind: 'idle' });
  // Mirrored from the store rather than owned here: the store decides what the
  // prompt currently means, and this only draws it.
  const [candidates, setCandidates] = useState<readonly MaskCandidate[]>([]);
  const [chosenCandidate, setChosenCandidate] = useState<number | undefined>(undefined);
  const [promptAnchor, setPromptAnchor] = useState<{ x: number; y: number } | undefined>(undefined);
  const [brushRadius, setBrushRadius] = useState(64);
  const [style, setStyle] = useState<StyleDefinition>(DEFAULT_STYLE);
  // Kept per style rather than reset on every switch: comparing two styles
  // means going back and forth, and losing a considered Strength each time
  // would make the comparison the thing that costs, not the choice.
  const [controlsByStyle, setControlsByStyle] = useState<Readonly<Record<string, StyleControls>>>(() =>
    Object.fromEntries(STYLES.map((candidate) => [candidate.id, defaultControls(candidate)])),
  );
  const controls = controlsByStyle[style.id] ?? defaultControls(style);
  const [stylePanelOpen, setStylePanelOpen] = useState(false);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<File | undefined>(undefined);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [fitRequest, setFitRequest] = useState(0);
  /** The runtime generation whose device currently holds the decoded pixels. */
  const [mediaGeneration, setMediaGeneration] = useState<number | undefined>(undefined);

  const runtime: RotylRuntime | undefined = state.status === 'ready' ? state.runtime : undefined;

  // A lost device takes the source texture with it. The command log survives in
  // ordinary memory, so putting the image back is the whole of recovery here.
  const restoring =
    (state.status === 'ready' && state.recovering) ||
    (runtime !== undefined && loaded !== undefined && mediaGeneration !== runtime.generation);
  const activity = busy ?? (restoring ? 'Restoring' : undefined);

  const uploadInto = useCallback(
    async (target: RotylRuntime, file: File, selection: 'clear' | 'keep'): Promise<boolean> => {
      const decoded = await decodeImageFile(file, target.maxTextureDimension);
      if (!decoded.ok) {
        setError(describeImageLoadError(decoded.error));
        return false;
      }

      const { bitmap, width, height } = decoded.value;
      const texture = target.engine.loadMedia({ width, height }, selection);
      uploadImageToTexture(target.device, bitmap, texture);
      // Released immediately: an ImageBitmap holds a full RGBA copy, which is
      // 192 MB for a 48 megapixel photograph.
      bitmap.close();
      target.engine.markSourceUploaded();
      target.perception.setFrame(target.engine.sceneFrame);
      setMediaGeneration(target.generation);
      return true;
    },
    [],
  );

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

      if (!(await uploadInto(runtime, file, 'clear'))) {
        setBusy(undefined);
        return;
      }

      const { width, height } = runtime.engine.sourceSize ?? { width: 1, height: 1 };
      // Never zero: a tiny or extreme-aspect image would give a brush that
      // paints nothing, and the grow key multiplies, so it could never recover.
      setBrushRadius(Math.max(1, Math.round(Math.min(width, height) * DEFAULT_BRUSH_FRACTION)));
      setLoaded({ file, name: file.name, width, height });
      setHistoryRevision(runtime.engine.document.revision);
      setBusy(undefined);
    },
    [runtime, uploadInto],
  );

  // Open a file that arrived before the device was ready.
  useEffect(() => {
    if (!runtime || !pending) return;
    setPending(undefined);
    void openFile(pending);
  }, [runtime, pending, openFile]);

  // Put the image back on a rebuilt device, keeping the selection: the log is
  // the work, and replaying it is what the renderer does with it anyway.
  useEffect(() => {
    if (!runtime || !loaded || mediaGeneration === runtime.generation) return;
    void uploadInto(runtime, loaded.file, 'keep');
  }, [runtime, loaded, mediaGeneration, uploadInto]);

  // The engine owns the selection; this only mirrors enough of it to drive the
  // undo and redo buttons.
  useEffect(() => {
    if (!runtime) return undefined;
    return runtime.engine.document.subscribe(() => {
      setHistoryRevision(runtime.engine.document.revision);
    });
  }, [runtime]);

  useEffect(() => {
    if (!runtime) return undefined;
    return runtime.perception.subscribe(() => {
      const perceptionStore = runtime.perception;
      setPerception(perceptionStore.status);
      setCandidates(perceptionStore.candidates);
      setChosenCandidate(perceptionStore.chosen);
      const anchor = perceptionStore.promptAnchor;
      setPromptAnchor(anchor ? { x: anchor.x, y: anchor.y } : undefined);
    });
  }, [runtime]);

  // Selecting the tool, not using it, is what starts the download and the
  // frame encode — so both overlap with the user deciding where to click
  // rather than following it. Both prompt tools ask the same model, so
  // switching between them carries the prompt rather than ending it: draw a
  // box, then shift-click to correct what it caught.
  useEffect(() => {
    // Not while a rebuild is in flight: there is no frame to read yet, and
    // asking for one is reported as a failure rather than as a wait.
    if (!runtime || !loaded || restoring) return;
    if (isPrompt(tool)) void runtime.perception.prepare();
    else runtime.perception.endPrompt();
  }, [runtime, loaded, tool, restoring]);

  useEffect(() => {
    runtime?.engine.setStyle(style);
    runtime?.engine.setControls(controls);
  }, [runtime, style, controls]);

  const onExport = useCallback(async (): Promise<void> => {
    if (!runtime || !loaded) return;
    setBusy('Exporting');
    setError(undefined);
    try {
      const result = await exportImage({
        device: runtime.device,
        maxTextureDimension: runtime.maxTextureDimension,
        renderer: runtime.engine.compositeRenderer,
        refiner: runtime.engine.maskRefiner,
        file: loaded.file,
        commands: runtime.engine.document.appliedCommands,
        style,
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
  }, [runtime, loaded, style, controls]);

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

      // Reaching past the model's own pick to a larger or smaller reading of
      // the same click. Only bound while there is something to reach for, so
      // the keys are free the rest of the time.
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const perceptionStore = runtime.perception;
        const rank = perceptionStore.chosen;
        if (perceptionStore.candidates.length > 1 && rank !== undefined) {
          event.preventDefault();
          perceptionStore.choose(event.key === 'ArrowUp' ? rank + 1 : rank - 1);
        }
        return;
      }

      switch (event.key) {
        case 'o':
          setTool('object');
          break;
        case 'r':
          setTool('box');
          break;
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
  const status = activity ?? describePerception(perception);
  // Object selection can fail on its own — a download that will not complete,
  // a runtime the browser will not start — and it has no other surface.
  const notice = error ?? (perception.kind === 'failed' ? perception.message : undefined);
  // historyRevision is read so that undo and redo re-evaluate when the log moves.
  void historyRevision;

  return (
    <div class="app">
      <TopBar
        {...(loaded ? { file: { name: loaded.name, width: loaded.width, height: loaded.height } } : {})}
        {...(status ? { status } : {})}
        canUndo={selection?.canUndo ?? false}
        canRedo={selection?.canRedo ?? false}
        onUndo={() => selection?.undo()}
        onRedo={() => selection?.redo()}
        onExport={() => void onExport()}
        exportDisabled={!loaded || activity !== undefined}
      />

      {loaded && runtime ? (
        <div class="editor">
          <Viewport
            runtime={runtime}
            tool={tool}
            brushRadius={brushRadius}
            overlayVisible={overlayVisible}
            paused={activity !== undefined}
            fitRequest={fitRequest}
            candidates={candidates}
            chosenCandidate={chosenCandidate}
            promptAnchor={promptAnchor}
            onChooseCandidate={(rank) => {
              runtime.perception.choose(rank);
            }}
            onSelectionChanged={() => {
              // A brush stroke ends whatever object was being refined: the next
              // object click should ask a fresh question rather than adding a
              // point to a prompt the user has moved on from.
              runtime.perception.endPrompt();
              setHistoryRevision(runtime.engine.document.revision);
            }}
            onObjectPicked={(point, intent: SelectIntent) => {
              void runtime.perception.select(point, intent);
            }}
            onBoxPicked={(box) => {
              void runtime.perception.selectBox(box);
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
              styles={STYLES}
              style={style}
              controls={controls}
              onStyleChange={setStyle}
              onChange={(next) => {
                setControlsByStyle((byStyle) => ({ ...byStyle, [style.id]: next }));
              }}
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
        <DropZone onFile={(file) => void openFile(file)} notice={notice} />
      )}

      {/*
        One live region for both states. Status and errors are otherwise
        entirely silent to a screen reader, and an export that fails while an
        image is loaded had no visible surface at all.
      */}
      <div class="announcer" role="status" aria-live="polite">
        {loaded && notice ? <p class="notice notice--floating">{notice}</p> : null}
      </div>
    </div>
  );
}

function noop(): void {
  /* placeholder for the states with no document loaded */
}
