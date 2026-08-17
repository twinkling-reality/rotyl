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

/**
 * Release GPU resources once the queue has finished with them.
 *
 * A resource referenced by a recorded command is read at SUBMIT, not at record,
 * so anything a submitted-but-unfinished frame still touches must outlive the
 * decision to replace it. Every stage buffer in the application is replaced
 * this way — a style control changes a derived resolution, an export swaps in
 * full-resolution buffers — and freeing them immediately is a use-after-free
 * that presents as an intermittent hard crash rather than as an error.
 *
 * Keyed on queue completion rather than on a later frame, because there may not
 * be a later frame: the style chain only re-runs when something changes, so
 * after an export the editor can sit idle indefinitely. Ageing these out on the
 * next render parked several hundred megabytes of unreachable GPU memory for
 * the rest of the session.
 *
 * `dispose()` TAKES OWNERSHIP by clearing the pending set, so a completion
 * callback arriving after teardown finds nothing to release and does nothing.
 */
export class DeferredRelease {
  readonly #device: GPUDevice;
  readonly #pending = new Set<() => void>();

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  after(release: () => void): void {
    this.#pending.add(release);
    void this.#device.queue.onSubmittedWorkDone().then(() => {
      if (!this.#pending.delete(release)) return;
      release();
    });
  }

  dispose(): void {
    const pending = [...this.#pending];
    this.#pending.clear();
    for (const release of pending) release();
  }
}
