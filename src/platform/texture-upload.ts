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

/**
 * A decoded video frame, into the same texture an image would go into.
 *
 * A sibling rather than a widened parameter, because a VideoFrame reports its
 * size under different names and because the colour question is different
 * enough to deserve stating.
 *
 * A frame arrives as NV12 in some YCbCr space, usually BT.709 with limited
 * range, and the browser converts it here. MEASURED (tools/video-bench): what
 * lands in an `rgba8unorm` texture is the same sRGB-encoded byte an image
 * decodes to, within one code on a losslessly encoded probe, and the sRGB view
 * downstream then does the decode in hardware exactly as it does for a
 * photograph. Writing it through an `rgba8unorm-srgb` view instead encodes it
 * twice and is wrong by 73 codes at mid grey.
 *
 * So there is no video colour path. There is the colour path, and this is one
 * more thing that arrives already in it.
 */
export function uploadFrameToTexture(device: GPUDevice, frame: VideoFrame, texture: GPUTexture): void {
  device.queue.copyExternalImageToTexture(
    { source: frame, flipY: false },
    { texture, premultipliedAlpha: false },
    // Display size, not coded size: a decoder pads to a macroblock multiple, so
    // a 1080-high clip is 1088 coded, and the last eight rows are not picture.
    { width: frame.displayWidth, height: frame.displayHeight },
  );
}
