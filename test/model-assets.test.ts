import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MODEL_RELEASE, modelAssetUrl } from '../src/platform/perception/model-assets.ts';
import { verifyModelAsset } from '../src/platform/perception/model-store.ts';
import { readVerifiedModelAssets } from '../tools/model-assets/vite.ts';

const temporary = mkdtempSync(path.join(tmpdir(), 'rotyl-model-assets-'));
afterAll(() => rmSync(temporary, { recursive: true }));

describe('the model release', () => {
  it('serves a versioned file from the application origin', () => {
    expect(modelAssetUrl('memory_encoder.onnx')).toBe(
      `/models/edgetam/${MODEL_RELEASE}/memory_encoder.onnx.gz`,
    );
    expect(modelAssetUrl('NOTICE.txt')).toBe(`/models/edgetam/${MODEL_RELEASE}/NOTICE.txt`);
  });

  it('accepts the licence bytes the manifest names', async () => {
    const bytes = Uint8Array.from(readFileSync('models/edgetam/LICENSE.txt'));
    await expect(verifyModelAsset('LICENSE.txt', bytes)).resolves.toBeUndefined();
  });

  it('refuses same-sized bytes with a different digest', async () => {
    const bytes = Uint8Array.from(readFileSync('models/edgetam/NOTICE.txt'));
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await expect(verifyModelAsset('NOTICE.txt', bytes)).rejects.toThrow(
      /refused NOTICE\.txt because it did not match model release/,
    );
  });

  it('refuses to build from an assetless clone', async () => {
    await expect(readVerifiedModelAssets(temporary)).rejects.toThrow(
      /Model asset .* is absent\. Run pnpm models; no deployment was produced/,
    );
  });
});
