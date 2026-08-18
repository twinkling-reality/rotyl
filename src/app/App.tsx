import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { useRotyl, type RotylRuntime } from './use-rotyl.ts';
import { DropZone } from './DropZone.tsx';
import { TopBar } from './TopBar.tsx';
import { Toolbar } from './Toolbar.tsx';
import { StylePanel } from './StylePanel.tsx';
import { Viewport } from './Viewport.tsx';
import { Timeline } from './Timeline.tsx';
import { decodeImageFile, describeImageLoadError } from '../platform/image-file.ts';
import { uploadFrameToTexture, uploadImageToTexture } from '../platform/texture-upload.ts';
// Static, and deliberately so: this decides WHICH loader to use, so it cannot
// itself be behind the loader's dynamic import. It reads sixteen bytes and
// pulls in nothing.
import { describeVideoLoadError, looksLikeVideo } from '../platform/video/video-file.ts';
import type { FrameProvider } from '../platform/video/frame-provider.ts';
import { exportFilename, exportImage, imageFileSource, type ExportSource } from '../platform/image-export.ts';
import { defaultControls, type StyleControls, type StyleDefinition } from '../core/style/style.ts';
import { editedFrames } from '../core/document/selection-command.ts';
import { DEFAULT_STYLE, STYLES } from '../core/style/styles.ts';
import { isPrompt, type Tool } from './tool.ts';
import type { PerceptionStatus, SelectIntent } from '../core/perception/perception-store.ts';
import type { MaskCandidate } from '../core/perception/mask-candidates.ts';

interface LoadedFile {
  readonly file: File;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Present for a video, absent for a photograph. */
  readonly video?: { readonly frameCount: number; readonly frameRate: number };
}

const DEFAULT_BRUSH_FRACTION = 0.06;
const BRUSH_STEP = 1.25;

/**
 * How playback decides it cannot keep up.
 *
 * Judged over a window because the first frames of a clip pay for pipelines and
 * a decoder that are not yet warm, and a single late frame there is not a clip
 * that plays badly.
 *
 * THE TOLERANCE IS DELIBERATELY HUGE. This is not a media player, it is an
 * editor showing what a filter does, and someone watching it would rather see
 * the real look at a third of the frames than a smooth approximation of it. The
 * style chain measures 46 ms a frame on a 720p clip at high detail and 105 ms
 * at 1080p, against budgets of 20 and 33, so a strict tolerance degrades
 * everything, always, which is what made playback look like a cheap filter in
 * the first place. Degrading is reserved for the point where the result has
 * stopped reading as motion at all.
 */
const FRAMES_BEFORE_JUDGING = 20;
const TOLERATED_SKIP = 0.6;

/**
 * What the perception layer is doing, in the status line.
 *
 * The download is the only one worth a percentage: it is tens of megabytes and
 * happens once, so a bare "Loading" would look indistinguishable from a hang.
 * The other two are hundreds of milliseconds and a number would just flicker.
 */
function describePerception(status: PerceptionStatus): { label: string; progress?: number } | undefined {
  switch (status.kind) {
    case 'loading':
      return { label: 'Downloading the object model', progress: status.progress };
    case 'understanding':
      return { label: 'Reading the image' };
    case 'thinking':
      return { label: 'Finding the object' };
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
  const [frame, setFrame] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [playing, setPlaying] = useState(false);
  /** Read by the playback loop, which must not be restarted to see a change. */
  const playingRef = useRef(false);

  /**
   * The decoder, and the texture it uploads into.
   *
   * Refs rather than state for the reason the engine is: neither participates
   * in reconciliation, and the texture is written to thirty times a second. The
   * provider owns no GPU resources, so it survives a lost device while the
   * texture does not. Hence the generation stamped alongside it.
   */
  const providerRef = useRef<FrameProvider | undefined>(undefined);
  const sourceRef = useRef<{ texture: GPUTexture; generation: number } | undefined>(undefined);

  const runtime: RotylRuntime | undefined = state.status === 'ready' ? state.runtime : undefined;

  // A lost device takes the source texture with it. The command log survives in
  // ordinary memory, so putting the image back is the whole of recovery here.
  const restoring =
    (state.status === 'ready' && state.recovering) ||
    (runtime !== undefined && loaded !== undefined && mediaGeneration !== runtime.generation);
  const activity = busy ?? (restoring ? 'Restoring' : undefined);

  /**
   * Put one frame of the open video into the source texture.
   *
   * loadMedia is NOT called here. Its job is to allocate for a new piece of
   * media, and doing it per frame would rebuild the selection mask and three
   * render pipelines thirty times a second. A video's dimensions do not change,
   * so the allocation happens once and this only writes pixels.
   */
  const showFrame = useCallback(
    async (target: RotylRuntime, index: number, settled: boolean): Promise<void> => {
      const provider = providerRef.current;
      const source = sourceRef.current;
      if (!provider || !source || source.generation !== target.generation) return;

      const shown = await provider.readFrame(index, (decoded) => {
        uploadFrameToTexture(target.device, decoded, source.texture);
      });
      // False means a later request has already replaced this one, which is the
      // ordinary case while scrubbing.
      if (!shown) return;

      target.engine.markSourceUploaded();
      // Only once the scrub has stopped. What the model understands about a
      // frame is expensive and the pixels are still moving until then.
      if (settled) target.perception.setFrame(target.engine.sceneFrame);
    },
    [],
  );

  const uploadInto = useCallback(
    async (
      target: RotylRuntime,
      media: LoadedFile,
      selection: 'clear' | 'keep',
      index: number,
    ): Promise<boolean> => {
      if (media.video) {
        const texture = target.engine.loadMedia({ width: media.width, height: media.height }, selection);
        sourceRef.current = { texture, generation: target.generation };
        setMediaGeneration(target.generation);
        await showFrame(target, index, true);
        return true;
      }

      const decoded = await decodeImageFile(media.file, target.maxTextureDimension);
      if (!decoded.ok) {
        setError(describeImageLoadError(decoded.error));
        return false;
      }

      const { bitmap, width, height } = decoded.value;
      const texture = target.engine.loadMedia({ width, height }, selection);
      sourceRef.current = { texture, generation: target.generation };
      uploadImageToTexture(target.device, bitmap, texture);
      // Released immediately: an ImageBitmap holds a full RGBA copy, which is
      // 192 MB for a 48 megapixel photograph.
      bitmap.close();
      target.engine.markSourceUploaded();
      target.perception.setFrame(target.engine.sceneFrame);
      setMediaGeneration(target.generation);
      return true;
    },
    [showFrame],
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

      providerRef.current?.dispose();
      providerRef.current = undefined;
      setFrame(0);
      setScrubbing(false);

      let media: LoadedFile = { file, name: file.name, width: 1, height: 1 };
      const format = await looksLikeVideo(file);
      if (format !== 'unknown') {
        // The demuxer, and everything it pulls in, arrives only for someone who
        // has actually opened a video, the same treatment the inference
        // runtime gets, and for the same reason: 38 KB gzipped is an absurd
        // thing to put in front of someone who wants to paint on a photograph.
        const { FrameProvider } = await import('../platform/video/frame-provider.ts');
        const opened = await FrameProvider.open(file, runtime.maxTextureDimension);
        if (!opened.ok) {
          setError(describeVideoLoadError(opened.error));
          setBusy(undefined);
          return;
        }
        providerRef.current = opened.value;
        const { width, height, timeline } = opened.value.info;
        media = {
          file,
          name: file.name,
          width,
          height,
          video: { frameCount: timeline.frameCount, frameRate: timeline.frameRate },
        };
      }

      if (!(await uploadInto(runtime, media, 'clear', 0))) {
        setBusy(undefined);
        return;
      }

      const { width, height } = runtime.engine.sourceSize ?? { width: 1, height: 1 };
      // Never zero: a tiny or extreme-aspect image would give a brush that
      // paints nothing, and the grow key multiplies, so it could never recover.
      setBrushRadius(Math.max(1, Math.round(Math.min(width, height) * DEFAULT_BRUSH_FRACTION)));
      setLoaded({ ...media, width, height });
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
    // The frame index is carried across too: a video comes back where it was,
    // for the same reason the view does.
    void uploadInto(runtime, loaded, 'keep', frame);
  }, [runtime, loaded, mediaGeneration, uploadInto, frame]);

  // The decoder holds an open file and a hardware decode session, neither of
  // which the garbage collector is in any hurry about.
  useEffect(() => {
    return () => {
      providerRef.current?.dispose();
      providerRef.current = undefined;
    };
  }, []);

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
  // frame encode, so both overlap with the user deciding where to click
  // rather than following it. Both prompt tools ask the same model, so
  // switching between them carries the prompt rather than ending it: draw a
  // box, then shift-click to correct what it caught.
  useEffect(() => {
    // Not while a rebuild is in flight: there is no frame to read yet, and
    // asking for one is reported as a failure rather than as a wait.
    if (!runtime || !loaded || restoring) return;
    // Not while the frame is still moving: each one would start an encode the
    // next one discards.
    if (scrubbing || playing) return;
    if (isPrompt(tool)) void runtime.perception.prepare();
    else runtime.perception.endPrompt();
  }, [runtime, loaded, tool, restoring, scrubbing, playing, frame]);

  useEffect(() => {
    runtime?.engine.setStyle(style);
    runtime?.engine.setControls(controls);
  }, [runtime, style, controls]);

  const pause = useCallback((): void => {
    playingRef.current = false;
    setPlaying(false);
    if (!runtime) return;
    runtime.engine.setQuality('full');
    // The frame it stopped on is a frame someone is now looking at.
    runtime.perception.setFrame(runtime.engine.sceneFrame);
  }, [runtime]);

  const onScrub = useCallback(
    (next: number, settled: boolean): void => {
      if (!runtime) return;
      if (playingRef.current) pause();
      setFrame(next);
      setScrubbing(!settled);
      // Both, in this order. The engine decides which commands apply, and the
      // provider decides which pixels do; a frame where those two disagree is a
      // selection drawn over somebody else's picture.
      runtime.engine.setFrame(next);
      // The same tier a style slider drops to while it is moving, and for the
      // same reason: the chain re-runs on every frame that arrives, and at full
      // quality that is 105 ms of work per pointer sample.
      runtime.engine.setQuality(settled ? 'full' : 'draft');
      void showFrame(runtime, next, settled);
    },
    [runtime, showFrame, pause],
  );

  /**
   * Playback.
   *
   * The target frame comes from the wall clock rather than from a counter, so a
   * frame the machine could not keep up with is skipped rather than played
   * late: dropping one is invisible, and drifting behind by a frame per frame
   * is a clip that runs slow and never catches up.
   *
   * FULL QUALITY UNTIL IT CANNOT KEEP UP, rather than the draft tier
   * throughout. Dropping to draft unconditionally was wrong in both directions:
   * on a 720p clip at high detail the two tiers are the same render anyway,
   * because both clamp to the clip's own short edge, so the drop bought nothing
   * and cost the look; on a 1080p clip at default detail the chain is 105 ms
   * against a 33 ms budget and no tier saves it.
   *
   * There is no cost model for the style chain, so this asks the only question
   * that matters and asks it of the thing itself: are frames being skipped. The
   * loop already computes that, because the target frame comes from the clock
   * rather than from a counter. Degrading only downward, and only on a window
   * rather than on one late frame, is what keeps it from oscillating.
   */
  const play = useCallback((): void => {
    if (!runtime || !loaded?.video) return;
    const { frameCount, frameRate } = loaded.video;
    const rate = frameRate > 0 ? frameRate : 30;
    const startFrame = runtime.engine.frame >= frameCount - 1 ? 0 : runtime.engine.frame;
    const startedAt = performance.now();
    let shown = -1;

    playingRef.current = true;
    setPlaying(true);
    runtime.engine.setQuality('full');

    let advanced = 0;
    let skipped = 0;
    let degraded = false;

    const step = async (): Promise<void> => {
      if (!playingRef.current) return;
      const elapsed = (performance.now() - startedAt) / 1000;
      const target = Math.min(frameCount - 1, startFrame + Math.floor(elapsed * rate));

      if (target !== shown) {
        skipped += Math.max(0, target - shown - 1);
        advanced++;
        if (!degraded && advanced >= FRAMES_BEFORE_JUDGING) {
          if (skipped > advanced * TOLERATED_SKIP) {
            degraded = true;
            runtime.engine.setQuality('draft');
          }
          advanced = 0;
          skipped = 0;
        }

        shown = target;
        setFrame(target);
        runtime.engine.setFrame(target);
        await showFrame(runtime, target, false);
      }

      if (!playingRef.current) return;
      if (target >= frameCount - 1) {
        playingRef.current = false;
        setPlaying(false);
        runtime.engine.setQuality('full');
        return;
      }
      // Half a frame, so the clock is sampled often enough to land on each one.
      globalThis.setTimeout(() => void step(), 1000 / rate / 2);
    };
    void step();
  }, [runtime, loaded, showFrame]);

  // Anything that replaces what is on screen ends playback: a scrub, a new
  // file, an export, a lost device.
  useEffect(() => {
    if (!loaded?.video) pause();
  }, [loaded, pause]);

  /**
   * Undo and redo, following the cursor to wherever it went.
   *
   * The log is one list with one cursor, and undo means the last thing you did,
   * which may be on a frame you are not looking at. Moving the view there is
   * what keeps that honest: an edit vanishing in front of you is undo, and an
   * edit vanishing somewhere off screen is a bug report.
   */
  const stepHistory = useCallback(
    (direction: 'undo' | 'redo'): void => {
      if (!runtime) return;
      const command = direction === 'undo' ? runtime.engine.document.undo() : runtime.engine.document.redo();
      if (!command || command.frame === runtime.engine.frame) return;
      onScrub(command.frame, true);
    },
    [runtime, onScrub],
  );

  const onExport = useCallback(async (): Promise<void> => {
    if (!runtime || !loaded) return;
    setBusy('Exporting');
    setError(undefined);
    try {
      const provider = providerRef.current;
      // A video frame is already full resolution as the decoder hands it over,
      // so there is nothing to go back to the file for. A photograph is decoded
      // again, because the preview may have been capped.
      const source: ExportSource =
        loaded.video && provider
          ? {
              width: provider.info.width,
              height: provider.info.height,
              async fill(device, texture) {
                const shown = await provider.readFrame(frame, (decoded) => {
                  uploadFrameToTexture(device, decoded, texture);
                });
                if (!shown) throw new Error('That frame could not be decoded again.');
              },
              release: () => undefined,
            }
          : await imageFileSource(loaded.file, runtime.maxTextureDimension);

      const result = await exportImage({
        device: runtime.device,
        maxTextureDimension: runtime.maxTextureDimension,
        renderer: runtime.engine.compositeRenderer,
        refiner: runtime.engine.maskRefiner,
        source,
        // The frame on screen is the frame exported, so it is that frame's
        // commands and no others.
        commands: runtime.engine.frameCommands,
        style,
        controls,
        format: 'png',
      });

      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFilename(loaded.name, 'png', loaded.video ? frame : undefined);
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
  }, [runtime, loaded, style, controls, frame]);

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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        stepHistory(event.shiftKey ? 'redo' : 'undo');
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
        case ' ':
          // Only for a clip. On a photograph the key is free, and binding it to
          // nothing that can happen would be a shortcut that looks broken.
          if (loaded.video) {
            event.preventDefault();
            if (playingRef.current) pause();
            else play();
          }
          break;
        case 'o':
          setTool('object');
          break;
        case 'r':
          setTool('box');
          break;
        case 'a':
          setTool('rect');
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
  }, [runtime, loaded, stepHistory, play, pause]);

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
  const status = activity ? { label: activity } : describePerception(perception);
  // Object selection can fail on its own, a download that will not complete,
  // a runtime the browser will not start, and it has no other surface.
  const notice = error ?? (perception.kind === 'failed' ? perception.message : undefined);
  // historyRevision is read so that undo and redo re-evaluate when the log moves.
  void historyRevision;
  // Which frames carry an edit. A per-frame selection that leaves no trace on
  // the timeline is a selection nobody can find again.
  const edited = selection ? editedFrames(selection.appliedCommands) : [];

  return (
    <div class="app">
      <TopBar
        {...(loaded ? { file: { name: loaded.name, width: loaded.width, height: loaded.height } } : {})}
        {...(status ? { status: status.label, statusProgress: status.progress } : {})}
        canUndo={selection?.canUndo ?? false}
        canRedo={selection?.canRedo ?? false}
        onUndo={() => {
          stepHistory('undo');
        }}
        onRedo={() => {
          stepHistory('redo');
        }}
        onExport={() => void onExport()}
        exportDisabled={!loaded || activity !== undefined}
      />

      {loaded && runtime ? (
        <div class="editor">
          <div class="stage">
            <Viewport
              runtime={runtime}
              tool={tool}
              brushRadius={brushRadius}
              // Off while playing. The overlay lifts everything unselected
              // toward paper so a selection can be seen being made, and during
              // playback the thing being looked at is the result instead.
              overlayVisible={overlayVisible && !playing}
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
              onRectDragged={(rect, mode) => {
                runtime.engine.commitRect(rect, mode);
                // Same as a stroke: a shape drawn by hand ends whatever object
                // was being refined.
                runtime.perception.endPrompt();
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
                  runtime.engine.document.apply({ kind: 'clear', frame: runtime.engine.frame });
                }}
                onInvert={() => {
                  runtime.engine.document.apply({ kind: 'invert', frame: runtime.engine.frame });
                }}
                stylePanelOpen={stylePanelOpen}
                onToggleStylePanel={() => {
                  setStylePanelOpen((open) => !open);
                }}
              />
            </Viewport>
            {loaded.video ? (
              <Timeline
                frameCount={loaded.video.frameCount}
                frameRate={loaded.video.frameRate}
                frame={frame}
                edited={edited}
                playing={playing}
                onPlayToggle={() => {
                  if (playingRef.current) pause();
                  else play();
                }}
                onScrub={onScrub}
              />
            ) : null}
          </div>
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
