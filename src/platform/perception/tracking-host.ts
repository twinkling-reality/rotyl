/**
 * Where the two tracking graphs are served from, and why there is no default.
 *
 * `memory_attention_shared_fp16.onnx`, `memory_encoder.onnx` and
 * `parameters.json` are not in any published release. `tools/edgetam-export`
 * produces them in one command and whoever runs this puts them somewhere, so
 * the address is a property of a deployment rather than of this program.
 *
 * A DEFAULT WOULD BE WORSE THAN NOTHING. The failure mode of a wrong guess is
 * not an error at start-up, it is nineteen megabytes fetched and a 404 arriving
 * at the moment somebody presses Track. So this returns undefined when nothing
 * is configured, and the interface offers no Track at all: a button that can
 * only fail is worse than an absent feature, which is at least honest about
 * what is here.
 *
 * BUILD TIME RATHER THAN RUNTIME. It is one string per deployment, and reading
 * it from the environment means the decision is visible in whatever builds the
 * site rather than in a settings panel nobody would find. It also means the
 * button's existence is decided before anything is downloaded.
 *
 *     VITE_TRACKING_HOST=https://example.org/edgetam pnpm build
 *
 * The graphs are a derivative work of an Apache-2.0 checkpoint, so whoever
 * hosts them ships the licence text and the attribution beside them and says
 * that the files were modified, which they are. See `tools/edgetam-export`.
 */
export function trackingHost(): string | undefined {
  const configured = import.meta.env.VITE_TRACKING_HOST;
  if (typeof configured !== 'string') return undefined;
  const trimmed = configured.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : undefined;
}
