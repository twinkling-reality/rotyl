import type { BrushMode } from '../core/render/rotyl-engine.ts';

/**
 * What a pointer press means.
 *
 * The brush modes come from the engine, which is where they belong: they name
 * the two things a stroke can do to coverage. `object` and `box` are not
 * strokes, they are questions, one asked with a point and one with a region,
 * which is why they are UI concepts and appear here rather than beside them.
 *
 * Two tools rather than one gesture with a modifier because a drag already
 * means pan in `object`, and that was chosen deliberately: pointing at things
 * repeatedly while moving around the photograph is the common case, and it
 * should need nothing held down. A box is the uncommon case, so it gets a
 * visible tool instead of a hidden modifier.
 */
export type Tool = BrushMode | 'object' | 'box' | 'rect';

export function isBrush(tool: Tool): tool is BrushMode {
  return tool === 'paint' || tool === 'erase';
}

/**
 * Tools that ask the model a question rather than editing coverage directly.
 *
 * `rect` is neither a brush nor a question: it is a shape, dragged the same way
 * `box` is and meaning the opposite thing. That two tools share a gesture and
 * differ in what it means is the reason they sit apart in the toolbar.
 */
export function isPrompt(tool: Tool): boolean {
  return tool === 'object' || tool === 'box';
}

/** Tools whose gesture is dragging a rectangle out. */
export function isDragRegion(tool: Tool): boolean {
  return tool === 'box' || tool === 'rect';
}
