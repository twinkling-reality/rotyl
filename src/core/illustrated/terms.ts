/**
 * The hosted illustrated still, as a product fact rather than a style.
 *
 * Comic, Poster and Print are synchronous GPU chains. This is a job: a still
 * leaves the machine, a generator draws a person, and the existing compositor
 * puts that drawing back through the selection. The four sentences below are
 * the authorization boundary. Nothing may call the host until the user has
 * accepted this exact version of them.
 *
 * publishReady stays false until the licensed evaluation set clears the same
 * visual bar the local Anime slot and official DCT-Net failed. A working
 * request is not that bar.
 */

export const ILLUSTRATED_TERMS_VERSION = 'illustrated-v2';

/**
 * Longest edge sent to the host.
 *
 * The compositor still writes unselected pixels from the original still, so
 * a 48 megapixel photograph does not have to cross the network at 48
 * megapixels. The generated layer is sampled to output size.
 */
export const ILLUSTRATED_LONG_EDGE = 1280;

/** Decoded still bytes the worker will accept. About a 1280 JPEG, with room. */
export const ILLUSTRATED_MAX_BYTES = 3_500_000;

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
  path: 'PhotoMaker (Tencent ARC, Apache-2.0) on Fal, photomaker-style, img2img from this still',
  stillsOnly: true,
  privacy:
    "The whole still leaves this machine. It goes to Rotyl's same-origin worker, then to Fal, which runs PhotoMaker. The selection stays here. Fal's API terms say they do not train on client content. The key never enters the browser.",
  cost: "The host pays Fal's compute bill. A 100-step still measured about twenty cents at $0.00125 a compute second. Comic, Poster and Print stay free and local.",
  latency:
    'About two minutes on the licensed set. The editor stays usable. Nothing comes back until the job finishes.',
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
