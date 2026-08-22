import manifest from '../../../models/edgetam/manifest.json' with { type: 'json' };

export type ModelAssetName = keyof typeof manifest.files;
export type ModelAsset = (typeof manifest.files)[ModelAssetName];

export const MODEL_RELEASE = manifest.version;

export function modelAsset(name: ModelAssetName): ModelAsset {
  return manifest.files[name];
}

/**
 * A model URL in the deployment that served this application.
 *
 * The build obtains the bytes from Rotyl's release, verifies them, and emits
 * them here. Runtime code never reaches through the deployment to the release
 * or to an upstream model host.
 */
export function modelAssetUrl(name: ModelAssetName): string {
  const suffix = modelAsset(name).feature === 'legal' ? '' : '.gz';
  return `${import.meta.env.BASE_URL}models/edgetam/${MODEL_RELEASE}/${name}${suffix}`;
}
