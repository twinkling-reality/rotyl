/**
 * Per-still keep lists for Fal edit evals. These name the costume failures
 * already judged on Kontext and FLUX.2. Not a claim that the bar is cleared.
 *
 * portrait-close is described from the photograph, which shows a black snapback
 * worn backward with a red adjuster strap across the forehead. Earlier sweeps
 * told the model to avoid both, so they asked it to depart from the still.
 */

const DRAW =
  'Transform this photograph into a cel-animation illustration with clean ink outlines and flat colour fills. Keep this exact person: the same face, age, skin, hair, eyes, expression, pose, and framing. Do not invent a different person.';

export const ILLUSTRATED_KEEP: Record<string, string> = {
  'portrait-close': `${DRAW} Keep the black snapback cap worn backward, its red adjuster strap across the forehead, and the flat brim pointing behind the head. Keep this exact camera and its lettering. Keep the landscape.`,
  'portrait-glasses': `${DRAW} Keep the dark textured knit sweater, not a t-shirt or jacket. Keep the glasses. Keep this window and this room. Do not invent a new eye colour.`,
  'portrait-somali': `${DRAW} Keep the cream shawl with the dark floral border only on the edge of the cloth.`,
  'portrait-lehna': `${DRAW} Keep the gold and black patterned headpiece, the magenta cardigan, the black turtleneck, the nose ring, and the dangling geometric silver earrings. Do not add a necklace.`,
  'portrait-doorway': `${DRAW} Keep the older man, the mustard turban, the white mustache, the kurta, the dark interior, and the red doors.`,
  'portrait-hands': `${DRAW} Keep the grey crew-neck shirt and the leopard-print headband.`,
};

export function keepPrompt(id: string): string {
  return ILLUSTRATED_KEEP[id] ?? DRAW;
}
