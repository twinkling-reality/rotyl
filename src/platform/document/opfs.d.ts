/**
 * The one file API that is not in TypeScript's DOM library.
 *
 * `createSyncAccessHandle` is the whole reason the crash journal is a worker,
 * and TypeScript declares it in `lib.webworker.d.ts` rather than in
 * `lib.dom.d.ts`. This project compiles one library for both, so the four
 * methods the journal uses are declared here rather than pulling a second lib
 * in and colliding it with the DOM one, which is the same trap the WebGPU types
 * already spring on this build.
 *
 * Declared as a merge onto `FileSystemFileHandle` rather than as a cast at the
 * call site, so the compiler is checking the journal rather than being told to
 * trust it.
 */

interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  /**
   * Present in a dedicated worker and nowhere else, which was measured rather
   * than read: on the main thread the handle has no such method at all. Hence
   * optional, so a main-thread caller has to notice.
   */
  createSyncAccessHandle?(): Promise<FileSystemSyncAccessHandle>;
}
