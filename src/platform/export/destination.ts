import type { ExportFormat } from './export.ts';

/**
 * Where an export is going, asked before any of the work.
 *
 * A clip export is minutes of encoding. Doing it and then asking where to put
 * the result is the worst possible order: the answer might be "nowhere", and by
 * then the whole file is in memory, which is the thing this exists to avoid.
 * So the destination is a decision taken at the click and handed to the sink,
 * and the sink is built around it rather than discovering it at the end.
 *
 * DELIBERATELY NOT PART OF `openSink`. Asking for a file needs the transient
 * activation the click just granted, and it has to be spent before anything
 * slow: the sink is behind a dynamic import of 42.8 KB, and a picker asked for
 * after that is a picker asked for after a network fetch. This module imports
 * nothing, so it can be called first.
 */

/**
 * What a destination needs of a file handle, which is less than one is.
 *
 * Narrower than `FileSystemFileHandle` on purpose, the way an export source is
 * narrower than a frame provider: what the sink does with a handle is open one
 * writable stream on it, and what the interface does is say its name. Nothing
 * here should be in a position to read the file back or ask what kind of entry
 * it is. It also means a stand-in for the picker, which both the benchmark and
 * the end-to-end suite need, is a real implementation of this rather than a
 * cast of something that is not a file handle.
 */
export interface WritableFile {
  readonly name: string;
  createWritable(): Promise<WritableStream<FileSystemWriteChunkType>>;
}

/** A file the user named, or the browser's own downloads folder. */
export type Destination =
  | { readonly kind: 'download' }
  | { readonly kind: 'file'; readonly handle: WritableFile; readonly name: string };

/** What the dialog is told to offer, which is all of it this uses. */
interface SavePickerOptions {
  readonly suggestedName?: string;
  readonly types?: readonly { description: string; accept: Record<string, readonly string[]> }[];
}

declare global {
  /**
   * Chrome and Edge, and nowhere else, which is the whole reason this module
   * exists.
   *
   * Declared optional rather than present, because it genuinely is: Safari and
   * Firefox have no property of this name, so it has to be reached through
   * `globalThis` rather than as a bare identifier, which would throw where it
   * does not exist.
   *
   * It answers with `WritableFile` rather than the whole handle for the reason
   * that interface exists: this module has no business reading a file back, and
   * a declaration that said it could would let one be written.
   */
  // eslint-disable-next-line no-var
  var showSaveFilePicker: ((options?: SavePickerOptions) => Promise<WritableFile>) | undefined;
}

/** What the picker offers to write, so the dialog's type list is not "all files". */
const TYPES: Record<ExportFormat, { description: string; accept: Record<string, readonly string[]> }> = {
  mp4: { description: 'MPEG-4 video', accept: { 'video/mp4': ['.mp4'] } },
  png: { description: 'PNG image', accept: { 'image/png': ['.png'] } },
  jpeg: { description: 'JPEG image', accept: { 'image/jpeg': ['.jpg'] } },
};

/**
 * Ask for a file to write into, or say that this browser has no way to give one.
 *
 * ONE ENTRY POINT RATHER THAN TWO. A caller that asked whether a picker existed
 * and then used it would have two chances to disagree with itself, and the
 * answer it wants in both cases is the same: where do the bytes go. Chrome and
 * Edge have `showSaveFilePicker`; Safari and Firefox have no way to let somebody
 * give a page a file, so they get the downloads folder and the ceiling that
 * comes with it, which is in `docs/limits.md` with the measurement behind it.
 *
 * `undefined` means the user dismissed the dialog, which is not a failure and
 * must not be reported as one: they were asked a question and declined to
 * answer it. Anything else is a real error and is thrown.
 *
 * The file exists from the moment it is picked, empty, whatever happens next.
 * That is the browser's behaviour rather than a choice made here, and it is why
 * stopping an export finishes the file rather than abandoning it: an abandoned
 * one leaves nothing where the user asked for a video.
 */
export async function chooseFile(
  suggestedName: string,
  format: ExportFormat,
): Promise<Destination | undefined> {
  const pick = globalThis.showSaveFilePicker;
  if (!pick) return { kind: 'download' };
  try {
    const handle = await pick({ suggestedName, types: [TYPES[format]] });
    return { kind: 'file', handle, name: handle.name || suggestedName };
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') return undefined;
    throw cause;
  }
}
