// Shared by the ink stages.

// Turn a difference-of-Gaussians response into an ink coverage value.
// Returns 1 for paper and 0 for full ink.
//
// The soft side uses tanh rather than a hard step so that line ends and faint
// contours fade out instead of terminating in a staircase.
fn inkThreshold(response: f32, epsilon: f32, sharpness: f32) -> f32 {
  if (response >= epsilon) {
    return 1.0;
  }
  return clamp(1.0 + tanh(sharpness * (response - epsilon)), 0.0, 1.0);
}
