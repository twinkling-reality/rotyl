/**
 * Explicit GPU resource lifetime.
 *
 * Textures and buffers are the only WebGPU objects with a `destroy()`, and they
 * are also the only ones large enough to matter: a single full-resolution
 * source texture for a 48 MP photograph is 192 MB. Waiting for the garbage
 * collector to notice that is not a memory strategy, and the symptom — memory
 * climbing across repeated image loads until the tab dies — is the exact
 * failure this class exists to make impossible.
 *
 * Everything allocated through a pool is destroyed when the pool is, in
 * reverse order of creation. Pools are scoped to a lifetime, not to the
 * application: one for the device, one per loaded image, one per output-size
 * change.
 */
export class ResourcePool {
  #resources: { destroy(): void }[] = [];
  #disposed = false;

  texture(device: GPUDevice, descriptor: GPUTextureDescriptor): GPUTexture {
    return this.#track(device.createTexture(descriptor));
  }

  buffer(device: GPUDevice, descriptor: GPUBufferDescriptor): GPUBuffer {
    return this.#track(device.createBuffer(descriptor));
  }

  #track<T extends { destroy(): void }>(resource: T): T {
    if (this.#disposed) {
      throw new Error('ResourcePool: allocated after dispose');
    }
    this.#resources.push(resource);
    return resource;
  }

  get size(): number {
    return this.#resources.length;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (let i = this.#resources.length - 1; i >= 0; i--) {
      this.#resources[i]?.destroy();
    }
    this.#resources.length = 0;
  }
}
