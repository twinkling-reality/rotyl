import type { SelectionDocument } from '../document/selection-document.ts';
import { DEFAULT_REFINE_SETTINGS } from '../mask/refine-params.ts';
import type {
  MaskProposal,
  PromptPoint,
  SceneEmbedding,
  SceneFrame,
  SegmentationEngine,
} from './segmentation-engine.ts';

/**
 * What Rotyl understands about the current frame — which is not the same thing
 * as what it draws.
 *
 * THAT DISTINCTION IS THE POINT OF THIS CLASS. The engine analyses the whole
 * scene and returns several candidate objects per click, at several scales; the
 * render mask holds exactly one thing, the selection the user has made. Keeping
 * them apart means the system can hold candidates it is not drawing, remember
 * the prompt that produced the current one, and offer alternatives later —
 * none of which is possible if a click writes straight into the mask.
 *
 * The only thing that crosses over is a command, applied to the document like
 * any other edit and undone like any other edit. This class never touches a
 * mask texture.
 */

export type PerceptionStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly progress: number }
  /** Encoding the frame: expensive, and paid once. */
  | { readonly kind: 'understanding' }
  | { readonly kind: 'ready' }
  /** Decoding a prompt: cheap, and paid per click. */
  | { readonly kind: 'thinking' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * How a click relates to what came before.
 *
 *   object    a different thing; starts a fresh prompt
 *   include   also this, on the same thing
 *   exclude   not that, on the same thing
 *
 * The last two refine the object already proposed, so they replace its command
 * rather than adding another. Without that the log would fill with half-formed
 * versions of one selection and undo would have to be pressed once per click.
 */
export type SelectIntent = 'object' | 'include' | 'exclude';

/** Loads the engine, reporting progress from 0 to 1 while it does. */
export type EngineLoader = (onProgress: (progress: number) => void) => Promise<SegmentationEngine>;

export class PerceptionStore {
  readonly #document: SelectionDocument;
  readonly #load: EngineLoader;
  readonly #listeners = new Set<() => void>();

  #engine: SegmentationEngine | undefined;
  #loading: Promise<SegmentationEngine> | undefined;

  #frame: SceneFrame | undefined;
  #embedding: SceneEmbedding | undefined;
  /** The frame `#embedding` describes; anything else makes it stale. */
  #embeddedFrame: SceneFrame | undefined;
  /**
   * An encode already in flight, and the frame it is reading.
   *
   * Without this, two clicks landing before the first encode returns each start
   * their own — hundreds of milliseconds and tens of megabytes of duplicated
   * work, with whichever finishes second silently orphaning the other's
   * embedding.
   */
  #understanding: { readonly frame: SceneFrame; readonly promise: Promise<SceneEmbedding> } | undefined;

  #points: PromptPoint[] = [];
  #proposals: readonly MaskProposal[] = [];
  #status: PerceptionStatus = { kind: 'idle' };

  /**
   * The document revision our own command produced, while it is still the head.
   *
   * Refining a prompt replaces that command, and replacing it means undoing it
   * — but only if it is still the most recent edit. If a brush stroke has
   * landed in between, the refinement becomes a new command instead, because
   * undoing here would silently discard the stroke.
   */
  #committedRevision: number | undefined;

  /** Discards results from prompts the user has already moved past. */
  #sequence = 0;
  #disposed = false;

  constructor(document: SelectionDocument, load: EngineLoader) {
    this.#document = document;
    this.#load = load;
  }

  get status(): PerceptionStatus {
    return this.#status;
  }

  /**
   * Every candidate the engine offered for the current prompt, best first.
   *
   * Only the first is drawn. The rest are the objects the system knows about
   * and is not drawing — usually the same click read as a part, a whole, and a
   * group.
   */
  get proposals(): readonly MaskProposal[] {
    return this.#proposals;
  }

  get promptPoints(): readonly PromptPoint[] {
    return this.#points;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Point at a new frame, discarding everything understood about the old one. */
  setFrame(frame: SceneFrame | undefined): void {
    this.#frame = frame;
    this.#releaseEmbedding();
    this.#points = [];
    this.#proposals = [];
    this.#committedRevision = undefined;
    this.#sequence++;
    this.#setStatus(this.#engine ? { kind: 'ready' } : { kind: 'idle' });
  }

  /**
   * Get everything expensive out of the way.
   *
   * Called when the tool is selected rather than when it is first used, so the
   * model download and the frame encode overlap with the user deciding where to
   * click instead of following it.
   */
  async prepare(): Promise<void> {
    try {
      const engine = await this.#ensureEngine();
      await this.#ensureEmbedding(engine);
    } catch (cause) {
      this.#fail(cause);
    }
  }

  /**
   * Answer a click, and commit the answer to the document.
   *
   * Returns once the selection reflects the click, or immediately if a later
   * click has already superseded this one.
   */
  async select(point: { readonly x: number; readonly y: number }, intent: SelectIntent): Promise<void> {
    // "Not that" with nothing to subtract it from is meaningless, so a stray
    // exclude with no prompt in progress starts a new object instead of
    // silently doing nothing.
    const fresh = intent === 'object' || this.#points.length === 0;
    const points = fresh ? [] : [...this.#points];
    points.push({ x: point.x, y: point.y, include: fresh || intent !== 'exclude' });
    this.#points = points;
    if (fresh) this.#committedRevision = undefined;

    const sequence = ++this.#sequence;
    this.#notify();

    try {
      const engine = await this.#ensureEngine();
      const embedding = await this.#ensureEmbedding(engine);
      if (sequence !== this.#sequence) return;

      this.#setStatus({ kind: 'thinking' });
      const proposals = await engine.decode(embedding, { points });
      if (sequence !== this.#sequence) return;

      this.#proposals = proposals;
      this.#setStatus({ kind: 'ready' });

      const best = proposals[0];
      if (best) this.#commit(best);
    } catch (cause) {
      if (sequence === this.#sequence) this.#fail(cause);
    }
  }

  /** End the current prompt, so the next click starts a new object. */
  endPrompt(): void {
    if (this.#points.length === 0) return;
    this.#points = [];
    this.#proposals = [];
    this.#committedRevision = undefined;
    this.#notify();
  }

  dispose(): void {
    this.#sequence++;
    this.#disposed = true;
    // Clearing the frame is what makes an encode still in flight release its
    // own result: it checks the frame it was reading against the current one
    // and disposes rather than storing an embedding nobody will ever free.
    this.#frame = undefined;
    this.#releaseEmbedding();
    this.#engine?.dispose();
    this.#engine = undefined;
    // A load in flight has nowhere to arrive; `#ensureEngine` releases it.
    this.#loading = undefined;
    this.#listeners.clear();
  }

  #commit(proposal: MaskProposal): void {
    // Adds to the selection rather than replacing it, so clicking an object
    // never discards brushwork. Removing one is what the eraser is for.
    if (this.#committedRevision === this.#document.revision) this.#document.undo();
    this.#document.apply({
      kind: 'applyMask',
      mask: proposal.mask,
      op: 'add',
      refine: DEFAULT_REFINE_SETTINGS,
    });
    this.#committedRevision = this.#document.revision;
  }

  async #ensureEngine(): Promise<SegmentationEngine> {
    if (this.#engine) return this.#engine;
    this.#loading ??= (async () => {
      this.#setStatus({ kind: 'loading', progress: 0 });
      const engine = await this.#load((progress) => {
        if (this.#status.kind === 'loading') this.#setStatus({ kind: 'loading', progress });
      });
      if (this.#disposed) {
        engine.dispose();
        throw new Error('PerceptionStore: disposed while the engine was loading');
      }
      this.#engine = engine;
      this.#setStatus({ kind: 'ready' });
      return engine;
    })();

    try {
      return await this.#loading;
    } catch (cause) {
      // Cleared so a later attempt can retry rather than resolving the same
      // rejected promise for the rest of the session.
      this.#loading = undefined;
      throw cause;
    }
  }

  async #ensureEmbedding(engine: SegmentationEngine): Promise<SceneEmbedding> {
    const frame = this.#frame;
    if (!frame) throw new Error('PerceptionStore: no frame to segment');
    if (this.#embedding && this.#embeddedFrame === frame) return this.#embedding;
    if (this.#understanding?.frame === frame) return this.#understanding.promise;

    this.#releaseEmbedding();
    this.#setStatus({ kind: 'understanding' });

    const promise = (async () => {
      const embedding = await engine.encode(frame);
      // The frame can change while the encode is in flight; keeping a stale
      // embedding would answer clicks about the previous photograph.
      if (this.#frame !== frame) {
        embedding.dispose();
        throw new Error('PerceptionStore: the frame changed while it was being read');
      }
      this.#embedding = embedding;
      this.#embeddedFrame = frame;
      this.#setStatus({ kind: 'ready' });
      return embedding;
    })();

    this.#understanding = { frame, promise };
    try {
      return await promise;
    } finally {
      if (this.#understanding?.promise === promise) this.#understanding = undefined;
    }
  }

  #releaseEmbedding(): void {
    this.#embedding?.dispose();
    this.#embedding = undefined;
    this.#embeddedFrame = undefined;
    this.#understanding = undefined;
  }

  #fail(cause: unknown): void {
    this.#setStatus({
      kind: 'failed',
      message: cause instanceof Error ? cause.message : 'Object selection is unavailable.',
    });
  }

  #setStatus(status: PerceptionStatus): void {
    this.#status = status;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
