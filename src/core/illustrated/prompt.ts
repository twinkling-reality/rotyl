/**
 * What PhotoMaker is asked to draw.
 *
 * The `img` token is PhotoMaker's identity slot. The rest is the illustrated
 * treatment. Negative prompts name the failures already seen on this set:
 * melted faces, sticker eyes, and a photograph that only pretends to be drawn.
 *
 * These strings are not a claim that the bar is cleared. They are the starting
 * request. Changing them is a new evaluation, not a slider.
 */

export const ILLUSTRATED_PROMPT =
  'cel-animation illustrated character of a person img, clean ink outlines, flat colour fills, detailed eyes with highlights, coherent hair, same pose, same clothes, same framing';

export const ILLUSTRATED_NEGATIVE_PROMPT =
  'photograph, photorealistic, snapshot, melted face, sticker eyes, plastic skin, deformed hands, extra fingers, missing limbs, text, watermark, logo, collage, cutout';

/** PhotoMaker's stacked-ID style pipeline, not the photoreal one. */
export const ILLUSTRATED_PIPELINE = 'photomaker-style';

/** Fal's upper bound. More steps is the quality spend, not a new look. */
export const ILLUSTRATED_STEPS = 100;

export const ILLUSTRATED_GUIDANCE = 5;

/**
 * How hard the style adapter may pull. Mid-high of Fal's 15-50 range, so the
 * still can leave the photograph without becoming a sticker.
 */
export const ILLUSTRATED_STYLE_STRENGTH = 40;

/**
 * How far the generator may move from the still.
 *
 * High enough to leave the photograph. Low enough that pose and clothes remain
 * a reading of this frame rather than a new scene. Judged on the licensed set,
 * not tuned for one favourite portrait.
 */
export const ILLUSTRATED_STRENGTH = 0.48;

/**
 * What the vision pass is asked to write about the still.
 *
 * This replaces the hand-written per-still keep lists used in the bench. Those
 * were written by a person looking at six known photographs, which is not
 * something a real upload can be given. The answer to this instruction becomes
 * the keep clause for whatever picture the user actually sent.
 *
 * It asks only for what is visibly in the frame. Guessing a name, a place, a
 * mood or a backstory would put invention into the very clause that exists to
 * stop invention.
 */
export const KEEP_INSTRUCTION =
  'Look at this photograph and list only what must be preserved to redraw this exact person as an illustration. Name, in one paragraph and in plain phrases: the sitter apparent age range, their skin tone as it appears in this frame, hair length, texture and colour, facial hair, any eyewear, any headwear and which way it faces, every visible garment with its colour and material, every piece of jewellery, and any lettering visible on an object. Describe only what is actually in the picture. Do not guess a name, a place, an occupation, a mood or a story. Do not describe the lighting, the camera or the composition. If a detail is unclear, leave it out rather than guessing.';

/** Joins the drawn-style request to a keep clause derived from the still. */
export function buildIllustratedPrompt(keep: string): string {
  const trimmed = keep.trim();
  const base =
    'Transform this photograph into a cel-animation illustration with clean ink outlines and flat colour fills. Keep this exact person: the same face, age, skin, hair, eyes, expression, pose, and framing. Do not invent a different person.';
  return trimmed.length === 0
    ? base
    : `${base} Keep all of the following exactly as photographed: ${trimmed}`;
}
