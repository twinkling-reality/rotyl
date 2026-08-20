import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { useRotyl, type RotylRuntime } from './use-rotyl.ts';
import { useTracking } from './use-tracking.ts';
import { DropZone } from './DropZone.tsx';
import { TopBar } from './TopBar.tsx';
import { Toolbar } from './Toolbar.tsx';
import { StylePanel } from './StylePanel.tsx';
import { Viewport } from './Viewport.tsx';
import { Timeline, timecode } from './Timeline.tsx';
import { isWholeClip, movedEnd } from './range.ts';
import { decodeImageFile, describeImageLoadError } from '../platform/image-file.ts';
import { uploadFrameToTexture, uploadImageToTexture } from '../platform/texture-upload.ts';
// Static, and deliberately so: this decides WHICH loader to use, so it cannot
// itself be behind the loader's dynamic import. It reads sixteen bytes and
// pulls in nothing.
import { describeVideoLoadError, looksLikeVideo } from '../platform/video/video-file.ts';
import type { FrameProvider } from '../platform/video/frame-provider.ts';
import {
  ExportCancelled,
  carriesAudio,
  exportFilename,
  openSink,
  runExport,
  type ExportFormat,
  type ExportResult,
  type ExportSource,
} from '../platform/export/export.ts';
import {
  clipSource,
  imageFileSource,
  videoSource,
  type FrameRange,
} from '../platform/export/export-source.ts';
// Imports nothing, deliberately, so a file can be asked for while the click
// that asked is still granting the right to ask. See destination.ts.
import { chooseFile, type Destination } from '../platform/export/destination.ts';
import { defaultControls, type StyleControls, type StyleDefinition } from '../core/style/style.ts';
import { editedFrames } from '../core/document/selection-command.ts';
import { DEFAULT_STYLE, STYLES } from '../core/style/styles.ts';
import { isPrompt, type Tool } from './tool.ts';
import type { PerceptionStatus, SelectIntent } from '../core/perception/perception-store.ts';
import type { MaskCandidate } from '../core/perception/mask-candidates.ts';
import type { TrackingStatus } from '../core/perception/tracking-store.ts';
import { hasAnyCoverage } from '../core/document/selection-command.ts';

interface LoadedFile {
  readonly file: File;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Present for a video, absent for a photograph. */
  readonly video?: {
    readonly frameCount: number;
    readonly frameRate: number;
    /**
     * The soundtrack, and whether a clip export can carry it.
     *
     * Decided at open rather than at export, because what the interface owes
     * somebody whose sound will not survive is a warning BEFORE the minutes of
     * encoding rather than a note afterwards. It costs a list lookup: see
     * `carriesAudio`.
     */
    readonly audio?: { readonly codec: string; readonly carried: boolean };
  };
}

const DEFAULT_BRUSH_FRACTION = 0.06;
const BRUSH_STEP = 1.25;

/** How long a report stays up. Longer than the close button's arming, which is four. */
const REPORT_LASTS = 10_000;

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
 * What a tracking run is doing, in the same status line everything else uses.
 *
 * Two fractions, and they mean different things. The download is nineteen
 * megabytes and happens once; the run is one frame per ninety milliseconds and
 * is the only place in the product where a progress figure counts something a
 * person can see arriving on the timeline behind it.
 */
function describeTracking(
  status: TrackingStatus,
): { label: string; progress?: number | undefined } | undefined {
  switch (status.kind) {
    case 'loading':
      return { label: 'Downloading the tracker', progress: status.progress };
    case 'running':
      return {
        label: `Tracking, frame ${String(status.tracked)} of ${String(status.total)}`,
        progress: status.total > 0 ? status.tracked / status.total : undefined,
      };
    default:
      return undefined;
  }
}

/**
 * What the perception layer is doing, in the status line.
 *
 * The download is the only one worth a percentage: it is tens of megabytes and
 * happens once, so a bare "Loading" would look indistinguishable from a hang.
 * The other two are hundreds of milliseconds and a number would just flicker.
 */
function describePerception(
  status: PerceptionStatus,
): { label: string; progress?: number | undefined } | undefined {
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

/** The last frame's number, which is one less than how many there are. */
const lastFrameOf = (file: LoadedFile): number => Math.max(0, (file.video?.frameCount ?? 1) - 1);

/** Minutes and seconds, which is how long a clip is to anyone who has one. */
function atTime(frames: number, frameRate: number): string {
  const seconds = Math.round(frames / (frameRate || 30));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * What to say about an export that has finished, if anything.
 *
 * Three of the four cases need a sentence and one does not. A clip written
 * whole into the downloads folder is announced by the browser itself, and a
 * second announcement from inside the page would be the product talking over
 * it. Everything else is invisible: a file written to a path the user chose
 * leaves no trace in the browser at all, and an export that came out shorter
 * than the clip leaves one that looks exactly like an export that did not.
 *
 * The two short endings produce the same file and want opposite sentences.
 * Stopping is a button somebody pressed, so the only thing worth saying is that
 * the work up to there was kept, which is the part they cannot see. Running out
 * of room is this browser rather than this clip, and saying only "stopped"
 * there would blame the user for a limit they did not choose.
 */
function describeExport(
  result: ExportResult,
  frameRate: number,
  silent: string | undefined,
): string | undefined {
  const where = result.written.to === 'file' ? result.written.name : 'The saved file';
  // Said again at the end as well as before the work. The warning went up when
  // the file was opened, minutes ago on a long clip, and a file that turns out
  // to be silent when it is played is the one thing this chapter exists to stop
  // being a surprise.
  const lost = silent ? ` Its ${silent} soundtrack is one an MP4 cannot carry, so it has no sound.` : '';
  if (result.ended === 'complete') {
    if (result.written.to === 'file') return `Wrote ${where}.${lost}`;
    return lost ? `${where} has no sound:${lost.slice(5)}` : undefined;
  }
  const got = atTime(result.frames, frameRate);
  const asked = atTime(result.total, frameRate);
  if (result.ended === 'full') {
    // AND IT CAN NOW SAY WHAT TO DO ABOUT IT. Until this chapter the only
    // advice available was "use a different browser", which is not advice. In
    // and Out are the thing that works here, in this browser, on this clip.
    return `Ran out of room at ${got} of ${asked}: with nowhere to write the file, this browser has to hold all of it. ${where} has what was written. In and Out on the timeline will write a shorter piece at a time.${lost}`;
  }
  return `Stopped at ${got} of ${asked}. ${where} has what was written.${lost}`;
}

/**
 * What the Clip button will do, which is where the range and the sound are said.
 *
 * A BUTTON'S SECOND SENTENCE LIVES IN ITS TITLE HERE, which is the rule the Stop
 * button already follows. What makes it worth having on this one is that a clip
 * export takes minutes and two of its decisions are invisible until it is over:
 * which part of the clip is being written, and whether the sound survives.
 */
function describeClipButton(
  frameRate: number,
  range: FrameRange | undefined,
  audio: { readonly codec: string; readonly carried: boolean } | undefined,
): string {
  // The timeline's own timecode rather than the rounded minutes and seconds a
  // duration is quoted in. This names two FRAMES, and a range of half a second
  // read back as "0:01 to 0:01" would look like a control that had not worked.
  const what = range
    ? `Write ${timecode(range.from, frameRate)} to ${timecode(range.to, frameRate)} as an MP4`
    : 'Write the whole clip as an MP4';
  if (!audio) return `${what}.`;
  if (audio.carried) return `${what}, with its sound.`;
  return `${what}. Its ${audio.codec} soundtrack is one an MP4 cannot carry, so the clip will be silent.`;
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
  /**
   * Which frames a clip export writes, or nothing, which means all of them.
   *
   * A RANGE ON THE EXPORT AND NOT A TRIM OF THE DOCUMENT. Frame numbers stay
   * absolute, so a selection made at frame 100 still applies at frame 500 and
   * still applies to a range that starts at 400. See `FrameRange`, which says
   * what a trim would have cost.
   */
  const [range, setRange] = useState<FrameRange | undefined>(undefined);
  const [scrubbing, setScrubbing] = useState(false);
  const [playing, setPlaying] = useState(false);
  /** Read by the playback loop, which must not be restarted to see a change. */
  const playingRef = useRef(false);
  /**
   * How far a clip export has got, and how to stop it.
   *
   * A fraction only where one is real, which until now was the model download
   * alone. A clip is the second: hundreds of frames with a known total, where
   * "Exporting" on its own would be indistinguishable from a hang for minutes.
   */
  const [exportProgress, setExportProgress] = useState<number | undefined>(undefined);
  const exportAbort = useRef<AbortController | undefined>(undefined);
  /**
   * Something that happened and is not a failure.
   *
   * Kept apart from `error` rather than folded into it, because the two read
   * differently and should: an export that stopped where it was told to stop is
   * the product doing as it was asked, and colouring that like a fault would
   * teach people to distrust the colour.
   *
   * And it goes away by itself, which an error does not. It says what JUST
   * happened, so left on screen through a scrub and two brush strokes it would
   * be describing something else by then. A failure is a state and stays until
   * something changes it; this is an event and outlives itself.
   */
  const [report, setReport] = useState<string | undefined>(undefined);

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

  // A run of its own, over a decoder of its own, and only for a clip. The
  // playhead and the tracker are two independent cursors over one document, so
  // this deliberately does not participate in `busy`.
  const tracking = useTracking({
    runtime,
    ...(loaded?.video ? { file: loaded.file } : { file: undefined }),
  });

  // Long enough to read a sentence about a clip that stopped early, short enough
  // that it is gone before it starts describing the wrong moment.
  useEffect(() => {
    if (!report) return undefined;
    const timer = setTimeout(() => {
      setReport(undefined);
    }, REPORT_LASTS);
    return () => {
      clearTimeout(timer);
    };
  }, [report]);

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
      setReport(undefined);
      setBusy('Opening');

      providerRef.current?.dispose();
      providerRef.current = undefined;
      setFrame(0);
      setRange(undefined);
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
        const { width, height, timeline, audio } = opened.value.info;
        media = {
          file,
          name: file.name,
          width,
          height,
          video: {
            frameCount: timeline.frameCount,
            frameRate: timeline.frameRate,
            // Asked here rather than at export, so a soundtrack that cannot
            // survive is said before the minutes of encoding rather than after.
            ...(audio ? { audio: { codec: audio.codec, carried: carriesAudio('mp4', audio.codec) } } : {}),
          },
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

  /**
   * Close the file and go back to the drop zone.
   *
   * Everything the file owned goes with it: the decoder and its hardware decode
   * session, the source texture and mask on the GPU, the command log, and
   * whatever the perception layer had understood about the picture. Anything
   * kept would be a claim about a file that is no longer open.
   *
   * The style and its controls deliberately survive. They are a choice about
   * how the tool is set up rather than about this photograph, and re-picking a
   * palette on every file would be the tool forgetting what it was told.
   */
  const closeFile = useCallback((): void => {
    providerRef.current?.dispose();
    providerRef.current = undefined;

    runtime?.engine.unloadMedia();
    runtime?.perception.endPrompt();
    runtime?.perception.setFrame(undefined);

    setLoaded(undefined);
    setError(undefined);
    setReport(undefined);
    setBusy(undefined);
    setFrame(0);
    setRange(undefined);
    setScrubbing(false);
    setPlaying(false);
    setCandidates([]);
    setChosenCandidate(undefined);
    setPromptAnchor(undefined);
    setPerception({ kind: 'idle' });
    setHistoryRevision(0);
  }, [runtime]);

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

  /**
   * Move one end of the exported range, or drop it.
   *
   * A range that covers the whole clip is not a range, so marking one that
   * reaches both ends puts it back to nothing: what is on screen then is a clip
   * with no marks on it, which is what a clip with nothing said about it should
   * look like.
   */
  const onRangeChange = useCallback(
    (next: FrameRange | undefined): void => {
      const last = Math.max(0, (loaded?.video?.frameCount ?? 1) - 1);
      setRange(next && isWholeClip(next, last) ? undefined : next);
    },
    [loaded],
  );

  /**
   * Write it out.
   *
   * ONE PATH FOR BOTH. A source hands over frames and a sink takes them; a
   * photograph is a one-frame document and goes through the same loop once.
   * The only decisions here are which pair the user asked for and where the
   * answer goes, which are the two that genuinely belong in the interface.
   *
   * WHERE IT GOES IS ASKED FIRST. A clip is minutes of encoding, and a browser
   * that can be handed a file writes the bytes out as it makes them rather than
   * holding the whole file until the end. Asking afterwards would be the worst
   * possible order: the file is already in memory by then, which is the thing a
   * handle exists to avoid, and the answer might be "nowhere".
   */
  const onExport = useCallback(
    async (what: 'frame' | 'clip'): Promise<void> => {
      if (!runtime || !loaded) return;
      // Anything that replaces what is on screen ends playback, and an export
      // walks the decoder through the whole file.
      if (playingRef.current) pause();

      const provider = providerRef.current;
      const clip = what === 'clip' && provider !== undefined;
      const format: ExportFormat = clip ? 'mp4' : 'png';
      // A frame of a clip carries its number, because exporting three of them
      // would otherwise write the same name three times. The clip is the
      // document and takes the document's name.
      const name = exportFilename(loaded.name, format, !clip && loaded.video ? frame : undefined);

      // A picture is not asked about, and that is deliberate rather than
      // unfinished. It is a couple of megabytes with no ceiling in sight, so a
      // dialog in front of it would buy nothing and cost the one interaction
      // this product has always had.
      let destination: Destination | undefined;
      try {
        destination = clip ? await chooseFile(name, format) : { kind: 'download' };
      } catch (cause) {
        // A picker that refuses for a reason other than being dismissed, which
        // is rare and is still the only thing that has happened yet: nothing
        // has been rendered and nothing needs cleaning up.
        setError(cause instanceof Error ? cause.message : 'Could not ask where to save this.');
        return;
      }
      // Dismissed. They were asked a question and declined to answer it, which
      // is not a failure and gets no message.
      if (!destination) return;

      // The codec of a soundtrack this container cannot hold, or nothing. Read
      // once here so the sentence at the end says the same thing the button's
      // title said before any of the work.
      const audio = loaded.video?.audio;
      const silenced = audio && !audio.carried ? audio.codec : undefined;

      const controller = new AbortController();
      exportAbort.current = controller;

      setBusy(destination.kind === 'file' ? `Writing ${destination.name}` : 'Exporting');
      setExportProgress(clip ? 0 : undefined);
      setError(undefined);
      setReport(undefined);

      // Only when it moves. A clip is hundreds of frames and setting state per
      // frame would re-render the application two hundred times a second to
      // move a hairline by a fraction of a pixel.
      let shownPercent = -1;

      // A video frame is already full resolution as the decoder hands it over,
      // so there is nothing to go back to the file for. A photograph is decoded
      // again, because the preview may have been capped for memory.
      const openSource = (): Promise<ExportSource> => {
        // A range narrows which frames go through the loop and changes nothing
        // else: the numbers on them are the document's own, so a selection made
        // before the range starts still applies to it.
        if (clip) return clipSource(provider, format, range);
        if (provider) return Promise.resolve(videoSource(provider, [frame]));
        return imageFileSource(loaded.file, runtime.maxTextureDimension);
      };

      try {
        const result = await runExport({
          device: runtime.device,
          maxTextureDimension: runtime.maxTextureDimension,
          renderer: runtime.engine.compositeRenderer,
          refiner: runtime.engine.maskRefiner,
          source: await openSource(),
          sink: await openSink(format, destination),
          // The whole log. Which commands are in effect on a frame is core's
          // question, and an export that answered it here could answer it
          // differently from the preview.
          commands: runtime.engine.document.appliedCommands,
          style,
          controls,
          onProgress: (written, total) => {
            const percent = Math.round((written / total) * 100);
            if (percent === shownPercent) return;
            shownPercent = percent;
            setExportProgress(written / total);
          },
          signal: controller.signal,
        });

        if (result.written.to === 'download') {
          // A blob large enough for the browser to keep somewhere other than
          // memory can be created and then refuse to be read. Measured: on a
          // machine under load, one byte out of a 512 MB blob throws where the
          // same read at 256 MB does not. As a download that is a file that
          // never arrives and no word about why, so it is asked here, where the
          // answer can be a sentence. One byte is enough to find out.
          try {
            await result.written.blob.slice(0, 1).arrayBuffer();
          } catch {
            const size = Math.round(result.written.blob.size / 1e6);
            throw new Error(
              `This browser could not hold the finished clip, which came to ${String(size)} MB. Chrome and Edge can be given a file to write into, which holds none of it, and In and Out on the timeline will write a shorter piece here.`,
            );
          }
          const url = URL.createObjectURL(result.written.blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = name;
          link.click();
          // Revoked on the next task so the download has taken the reference; a
          // leaked object URL pins the whole encoded file in memory.
          setTimeout(() => {
            URL.revokeObjectURL(url);
          }, 0);
        }

        // The browser announces a download and announces nothing else, so
        // everything else has to be announced here.
        setReport(describeExport(result, loaded.video?.frameRate ?? 30, clip ? silenced : undefined));
      } catch (cause) {
        // A file the user named exists from the moment they named it, whatever
        // happens next, and a page can neither delete one it was handed nor
        // stop a writable stream committing on close. So the two ways of ending
        // with nothing usable in it both have to say so: silence there is a
        // video file that will not open and no explanation of it.
        const unfinished = destination.kind === 'file' ? ` ${destination.name} was left unfinished.` : '';
        if (cause instanceof ExportCancelled) {
          // Stopping is not failing, and saying so would be the product arguing
          // with a button the user just pressed. It only reaches here at all
          // when it was stopped before a single frame, where there is nothing
          // to keep.
          if (unfinished) setReport(`Stopped before the first frame.${unfinished}`);
        } else {
          setError((cause instanceof Error ? cause.message : 'Export failed.') + unfinished);
        }
      } finally {
        exportAbort.current = undefined;
        // Export replaced the style chain's stage textures with
        // export-resolution ones; the next interactive frame rebuilds them.
        runtime.engine.invalidateStyle();
        setBusy(undefined);
        setExportProgress(undefined);
      }
    },
    [runtime, loaded, style, controls, frame, range, pause],
  );

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
        // Shifted, because the unshifted pair is taken: `o` is the Object tool
        // and this product's tools come first. Every editor binds in and out to
        // these two letters, so the letters are kept and the modifier is the
        // cost of the collision.
        case 'I':
          if (loaded.video) onRangeChange(movedEnd(range, 'from', frame, lastFrameOf(loaded)));
          break;
        case 'O':
          if (loaded.video) onRangeChange(movedEnd(range, 'to', frame, lastFrameOf(loaded)));
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
  }, [runtime, loaded, stepHistory, play, pause, frame, range, onRangeChange]);

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
        <TopBar
          canUndo={false}
          canRedo={false}
          onUndo={noop}
          onRedo={noop}
          onExport={noop}
          exportDisabled
          canExportClip={false}
          clipTitle=""
          exporting={false}
          onCancelExport={noop}
          onClose={noop}
          hasEdits={false}
        />
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
        <TopBar
          canUndo={false}
          canRedo={false}
          onUndo={noop}
          onRedo={noop}
          onExport={noop}
          exportDisabled
          canExportClip={false}
          clipTitle=""
          exporting={false}
          onCancelExport={noop}
          onClose={noop}
          hasEdits={false}
        />
        <div class="dropzone-region">
          <p class="notice">The graphics device was lost. Reload to continue.</p>
        </div>
      </div>
    );
  }

  const selection = runtime?.engine.document;
  // Tracking runs while the user carries on scrubbing, so it goes in the status
  // line but never into `busy`, which is what disables the interface. The
  // playhead and the tracker are two cursors over one document, and an editor
  // that froze for half a minute would be a third claim nobody made.
  const status = activity
    ? { label: activity, progress: exportProgress }
    : (describeTracking(tracking.status) ?? describePerception(perception));
  // Object selection can fail on its own, a download that will not complete,
  // a runtime the browser will not start, and it has no other surface.
  const notice =
    error ??
    (tracking.status.kind === 'failed' ? tracking.status.message : undefined) ??
    (perception.kind === 'failed' ? perception.message : undefined);
  // historyRevision is read so that undo and redo re-evaluate when the log moves.
  void historyRevision;
  // Which frames carry an edit. A per-frame selection that leaves no trace on
  // the timeline is a selection nobody can find again.
  const edited = selection ? editedFrames(selection.appliedCommands) : [];
  // Closing is only worth asking about when there is something to lose.
  const hasEdits = (selection?.appliedCommands.length ?? 0) > 0;
  // And tracking needs something on THIS frame to follow, which is the fold's
  // question rather than the log's.
  // Only asked where there is a Track button to disable, so a build with no
  // tracker configured folds no commands per render for a button it does not
  // draw.
  const hasSelection = tracking.available && runtime ? hasAnyCoverage(runtime.engine.frameCommands) : false;
  // A soundtrack that will not survive an export, said while the file is merely
  // open. It stays up as long as the file does, because it is a fact about the
  // file rather than something that just happened.
  const audio = loaded?.video?.audio;
  const soundNote = audio && !audio.carried ? `its ${audio.codec} sound cannot go in an MP4` : undefined;

  return (
    <div class="app">
      <TopBar
        {...(loaded
          ? {
              file: {
                name: loaded.name,
                width: loaded.width,
                height: loaded.height,
                ...(soundNote ? { note: soundNote } : {}),
              },
            }
          : {})}
        {...(status ? { status: status.label, statusProgress: status.progress } : {})}
        canUndo={selection?.canUndo ?? false}
        canRedo={selection?.canRedo ?? false}
        onUndo={() => {
          stepHistory('undo');
        }}
        onRedo={() => {
          stepHistory('redo');
        }}
        onExport={(what) => void onExport(what)}
        exportDisabled={!loaded || activity !== undefined}
        canExportClip={loaded?.video !== undefined}
        clipTitle={describeClipButton(loaded?.video?.frameRate ?? 30, range, audio)}
        exporting={exportProgress !== undefined}
        onCancelExport={() => {
          exportAbort.current?.abort();
        }}
        onClose={closeFile}
        hasEdits={hasEdits}
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
                {...(tracking.available
                  ? {
                      tracking: {
                        running: tracking.running,
                        // There has to be something to follow. Coverage is
                        // inferred from the log rather than read back from the
                        // GPU, which is the same thing the overlay does.
                        disabled: !hasSelection || activity !== undefined,
                        onTrack: () => {
                          if (playingRef.current) pause();
                          tracking.track(runtime.engine.frame);
                        },
                        onStop: tracking.stop,
                      },
                    }
                  : {})}
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
                range={range}
                onRangeChange={onRangeChange}
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
        {loaded && !notice && report ? <p class="notice notice--quiet notice--floating">{report}</p> : null}
      </div>
    </div>
  );
}

function noop(): void {
  /* placeholder for the states with no document loaded */
}
