import type { CoverageMask } from '../document/selection-command.ts';
import type { Dimensions } from '../render/resolution.ts';

/**
 * What Rotyl can be asked to understand, and what it answers with.
 *
 * The interface is split into encode and decode because that split is the whole
 * reason object selection feels immediate. Understanding a frame is expensive
 * and depends only on the frame; answering "which object is under this point"
 * is cheap and depends on the click. Collapsing them into one call would make
 * every click pay the frame cost, and would make video tracking — where one
 * encode serves many prompts and many frames — impossible to build on top.
 *
 * Nothing here mentions a model, a runtime, or a file format. A different
 * engine, or one running somewhere else entirely, replaces this and nothing
 * else changes.
 */

/** A frame to be understood. */
export interface SceneFrame {
  /** An sRGB view of the full-resolution source, so sampling yields linear light. */
  readonly view: GPUTextureView;
  readonly size: Dimensions;
}

/**
 * A frame, understood. Opaque, expensive, and worth tens of megabytes, so it
 * is explicitly released rather than left to the garbage collector.
 */
export interface SceneEmbedding {
  dispose(): void;
}

/** Positive marks the object, negative carves away what the engine included wrongly. */
export interface PromptPoint {
  /** Image pixels, like every other coordinate that crosses this boundary. */
  readonly x: number;
  readonly y: number;
  readonly include: boolean;
}

/**
 * A region the object is inside.
 *
 * Corners in either order; an engine normalises them. A box says something a
 * click cannot — where the thing ENDS — which is why it is the better prompt
 * for an object with no unambiguous middle, and why it composes with points
 * rather than replacing them.
 */
export interface PromptBox {
  /** Image pixels, like every other coordinate that crosses this boundary. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface SegmentPrompt {
  readonly points: readonly PromptPoint[];
  readonly box?: PromptBox;
}

export interface MaskProposal {
  /**
   * Coverage at the engine's own resolution.
   *
   * Deliberately not upscaled here. The engine's job is to say which pixels
   * belong to the object at the resolution it reasons in; deciding exactly
   * where the boundary falls in the photograph is the refinement bridge's job,
   * and it needs the image to do it.
   */
  readonly mask: CoverageMask;
  /** The engine's own predicted IoU: how good it thinks this answer is. */
  readonly confidence: number;
}

export interface SegmentationEngine {
  /** Expensive. Once per frame. */
  encode(frame: SceneFrame): Promise<SceneEmbedding>;
  /** Cheap. Once per click. Ordered best first. */
  decode(embedding: SceneEmbedding, prompt: SegmentPrompt): Promise<readonly MaskProposal[]>;
  dispose(): void;
}
