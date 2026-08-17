/**
 * The colour contract, in one place.
 *
 * Rule: decode on read, encode on write, linear in between — and let the
 * hardware do both ends. The source texture is created as `rgba8unorm` and
 * sampled through an `rgba8unorm-srgb` view; the composite writes through an
 * `rgba8unorm-srgb` view. That round trip is bit-exact (a source byte of 188
 * comes back as 188), which is what makes "the exported file matches the
 * preview" a structural property rather than something to test for and hope.
 *
 * The two ways to get this wrong, both silent:
 *   sample srgb view -> write plain view   = too dark (linear values stored raw)
 *   sample plain view -> write srgb view   = washed out (encoded twice)
 *
 * Filtering, blending and blurring are only correct in linear light, which is
 * the other reason the decode has to happen at sample time rather than being
 * skipped as a passthrough.
 */

/** Source image storage. Sampled through SOURCE_VIEW_FORMAT. */
export const SOURCE_FORMAT = 'rgba8unorm' satisfies GPUTextureFormat;
export const SOURCE_VIEW_FORMAT = 'rgba8unorm-srgb' satisfies GPUTextureFormat;

/**
 * Working colour buffers. Linear light needs more than 8 bits — banding in the
 * flattened layer is visible at 8 — and rgba16float is filterable, blendable
 * and renderable in core WebGPU with no optional feature.
 */
export const WORKING_FORMAT = 'rgba16float' satisfies GPUTextureFormat;

/**
 * Single-channel buffers: the structure tensor's scalar products and the ink
 * layer. Quarter the bandwidth of rgba16float at full output resolution.
 */
export const SCALAR_FORMAT = 'r16float' satisfies GPUTextureFormat;

/** Selection coverage. Eight bits is genuinely enough for an alpha ramp. */
export const MASK_FORMAT = 'r8unorm' satisfies GPUTextureFormat;

/** Composite output, and the exported image. */
export const OUTPUT_FORMAT = 'rgba8unorm' satisfies GPUTextureFormat;
export const OUTPUT_VIEW_FORMAT = 'rgba8unorm-srgb' satisfies GPUTextureFormat;
