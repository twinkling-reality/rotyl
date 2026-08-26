/**
 * The hosted illustrated still, as a product fact rather than a style.
 *
 * Comic, Poster and Print are synchronous GPU chains. This is a job: a still
 * leaves the machine, a generator draws a person, and the existing compositor
 * puts that drawing back through the selection. The four sentences below are
 * the authorization boundary. Nothing may call the host until the user has
 * accepted this exact version of them.
 *
 * v3 sends two jobs, not one. A vision model reads the still and writes the
 * keep list, then the drawing is made from that list. That is a second model
 * seeing the photograph, so it is a new consent, not a silent swap.
 *
 * v4 sends a bigger picture and pays more for it. The still crosses the network
 * at 2048 rather than 1280 and the drawing comes back at full size, which costs
 * about twice as much and takes about twice as long. Both are stated below, and
 * more of the photograph leaving the machine is itself a reason to ask again.
 *
 * publishReady stays false until the licensed evaluation set clears the same
 * visual bar the local Anime slot and official DCT-Net failed. A working
 * request is not that bar.
 */

export const ILLUSTRATED_TERMS_VERSION = 'illustrated-v4';

/**
 * Longest edge sent to the host.
 *
 * The compositor still writes unselected pixels from the original still, so
 * a 48 megapixel photograph does not have to cross the network at 48
 * megapixels. The generated layer is sampled to output size.
 *
 * This was 1280, which is a layer big enough to composite and too small to
 * judge. Every sheet in the stylisation ledger was drawn at that size and then
 * looked at larger, and read as soft for that reason rather than because of the
 * generator. Measured at 2048 the same request comes back with drawn line work
 * instead of blurred line work. See `docs/stylization-decision-log.md`.
 */
export const ILLUSTRATED_LONG_EDGE = 2048;

/**
 * Decoded still bytes the worker will accept. About a 2048 JPEG, with room.
 *
 * The licensed set measures 0.5 MB to 1.4 MB at that edge. The cap is set well
 * above the largest of them and still refuses a full-size camera dump.
 */
export const ILLUSTRATED_MAX_BYTES = 6_000_000;

export interface IllustratedTerms {
  readonly version: typeof ILLUSTRATED_TERMS_VERSION;
  readonly title: string;
  /** Identity-preserving generator this version is wired to. */
  readonly path: string;
  readonly stillsOnly: true;
  readonly privacy: string;
  readonly cost: string;
  readonly latency: string;
  readonly retention: string;
  readonly background: string;
  readonly publishReady: false;
}

export const ILLUSTRATED_TERMS: IllustratedTerms = {
  version: ILLUSTRATED_TERMS_VERSION,
  title: 'Hosted illustrated still',
  path: 'Two Fal jobs on this still: a vision model reads it and writes what to keep, then Nano Banana Pro draws it from that list',
  stillsOnly: true,
  privacy:
    "The whole still leaves this machine, and two models see it. It goes to Rotyl's same-origin worker, then to Fal. There a vision model reads the picture and writes a plain description of the person and their clothes, and that description is then sent with the still to Nano Banana Pro, which draws it. The description is about this photograph only and is not kept. The selection stays here. Fal's API terms say they do not train on client content. The key never enters the browser.",
  cost: "The host pays Fal's compute bill. Measured on the licensed set at about a cent to read the still and about thirty cents to draw it at full size. Comic, Poster and Print stay free and local.",
  latency:
    'Measured at forty to a hundred seconds on the licensed set, the reading and the drawing together. The editor stays usable. Nothing comes back until the job finishes.',
  retention:
    'Rotyl keeps nothing. The worker asks Fal not to store the request payload. Fal may still hold the generated file on its CDN for up to seven days. Export the PNG if you want the result. Closing the file drops the layer.',
  background:
    'The photograph around the selection never goes through the generator on the way back. The compositor writes those pixels from the original still.',
  publishReady: false,
};

export interface IllustratedConsent {
  readonly version: string;
  readonly accepted: true;
}

/**
 * Whether this consent is for the terms that are in force.
 *
 * A stale version is a no, even if accepted is true. That is what stops a
 * remembered click from covering a later change to privacy, cost, latency or
 * retention.
 */
export function consentMatches(consent: unknown, terms: IllustratedTerms = ILLUSTRATED_TERMS): boolean {
  if (consent === null || typeof consent !== 'object') return false;
  return Reflect.get(consent, 'version') === terms.version && Reflect.get(consent, 'accepted') === true;
}
