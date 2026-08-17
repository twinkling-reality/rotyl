/**
 * Getting decoded pixels onto the GPU.
 *
 * Both destination flags are stated explicitly rather than left to default,
 * because a mismatch in either is silent and shows up much later as "the
 * exported file does not match the preview":
 *
 *   flipY             false means the image's top-left texel lands at (0, 0),
 *                     which is the convention every shader here assumes
 *   premultipliedAlpha false stores straight alpha; Rotyl's images are opaque
 *                     and coverage lives in its own texture, so multiplying
 *                     colour by alpha would only lose precision
 */
export function uploadImageToTexture(device: GPUDevice, bitmap: ImageBitmap, texture: GPUTexture): void {
  device.queue.copyExternalImageToTexture(
    { source: bitmap, flipY: false },
    { texture, premultipliedAlpha: false },
    { width: bitmap.width, height: bitmap.height },
  );
}
