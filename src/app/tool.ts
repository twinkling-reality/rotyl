import type { BrushMode } from '../core/render/rotyl-engine.ts';

/**
 * What a pointer press means.
 *
 * The brush modes come from the engine, which is where they belong: they name
 * the two things a stroke can do to coverage. `object` is not a third stroke —
 * it is a click that asks a question — which is why it is a UI concept and
 * appears here rather than beside them.
 */
export type Tool = BrushMode | 'object';

export function isBrush(tool: Tool): tool is BrushMode {
  return tool !== 'object';
}
