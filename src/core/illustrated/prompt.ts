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
