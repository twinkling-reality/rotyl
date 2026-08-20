/**
 * The only thread that can append to a file without copying it first.
 *
 * THIS PRODUCT'S FIRST WEB WORKER, and it is here because the platform left no
 * choice rather than because concurrency looked attractive.
 * `docs/architecture.md` rejected a worker for export at 50% slower, and that
 * rejection stands: moving a full-resolution image across the boundary costs
 * more than the parallelism returns. This is the opposite trade, and all four
 * halves of it were measured before a line of it was written:
 *
 *   `createSyncAccessHandle` IS NOT ON THE MAIN THREAD AT ALL. Asked of the
 *     browser rather than remembered: the handle has no such method there. So a
 *     journal either lives in a worker or does not use that API.
 *
 *   `createWritable` COPIES THE FILE to open a stream on it. Opening one on an
 *     empty file is 0.4 ms and on a 64 MB file is 117, linear in between, so an
 *     "append" through it is not an append: one record onto a ten-minute
 *     journal measures 98 ms, per edit, on the thread that draws.
 *
 *   A SYNC ACCESS HANDLE IS FLAT. 0.13 ms per append with a flush after every
 *     one, at every file size measured, and the flush costs nothing detectable.
 *
 *   AND HANDING A RECORD OVER COSTS THE MAIN THREAD NOTHING, below the clock's
 *     own resolution at every size.
 *
 * `/research/crash-recovery.html` has all four.
 *
 * The handle is held open for the life of the session rather than reopened per
 * write. Opening is the expensive half of every file API and a journal writes
 * thousands of times; it is also what makes the append offset a variable here
 * rather than a `getSize()` on every edit.
 *
 * READING IS NOT HERE, and that is deliberate. A recovery happens once, at
 * start-up, before any file is open and therefore before this worker exists, so
 * it is an ordinary `getFile()` on the main thread. Putting it here would mean
 * spinning a worker up for every session including the ones that never open
 * anything. See `journal.ts`.
 */

import { journalHeader } from './journal-record.ts';

/** Where the journal lives, in the origin private file system. */
export const JOURNAL_DIRECTORY = 'rotyl';
export const JOURNAL_FILE = 'session.journal';

export type ToJournal =
  /** Start a journal, discarding whatever was there. */
  | { readonly kind: 'begin' }
  /** Append one framed record. Never answered: an edit must not wait for a disk. */
  | { readonly kind: 'append'; readonly record: Uint8Array<ArrayBuffer> }
  /**
   * Drop everything back to `bytes`, which is where a record began.
   *
   * An undo makes the journal longer than the log, and the journal is defined
   * as the applied commands, so it is cut rather than annotated. The offset
   * comes from the writer, because it is the writer that knows where each
   * record started.
   */
  | { readonly kind: 'truncate'; readonly bytes: number }
  /**
   * Carry on writing an existing journal from `at`, rather than starting one.
   *
   * What a recovered session does. The records are already on the disk and were
   * just read off it, so beginning again would rewrite all of them: eighteen
   * thousand appends and 64 MB, during which the journal does not hold the work
   * it was about to protect.
   */
  | { readonly kind: 'resume'; readonly at: number }
  /** Forget the session: the file was given back. */
  | { readonly kind: 'discard' };

export type FromJournal = { readonly kind: 'ready' } | { readonly kind: 'failed'; readonly error: string };

let handle: FileSystemSyncAccessHandle | undefined;
let at = 0;

async function open(): Promise<FileSystemSyncAccessHandle> {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(JOURNAL_DIRECTORY, { create: true });
  const file = await directory.getFileHandle(JOURNAL_FILE, { create: true });
  // Optional in the declaration because it genuinely is: on the main thread the
  // handle has no such method, which is exactly why this file is a worker.
  const access = await file.createSyncAccessHandle?.();
  if (!access) throw new Error('this browser has no sync access handle');
  return access;
}

function reply(message: FromJournal): void {
  // A worker's `postMessage` takes a transfer list where a window's takes an
  // origin, and the rule below cannot tell the two apart from inside a file
  // compiled against the DOM library.
  // eslint-disable-next-line unicorn/require-post-message-target-origin
  self.postMessage(message);
}

async function serve(message: ToJournal): Promise<void> {
  try {
    switch (message.kind) {
      case 'begin': {
        // ONE SESSION AT A TIME. Whatever was there belonged to a session that
        // has been superseded, and keeping both would need a journal per file
        // and a policy for pruning them. That is in `docs/limits.md` as the
        // thing this deliberately does not do.
        handle ??= await open();
        handle.truncate(0);
        const header = journalHeader();
        handle.write(header, { at: 0 });
        handle.flush();
        at = header.length;
        reply({ kind: 'ready' });
        return;
      }

      case 'resume': {
        handle ??= await open();
        handle.truncate(message.at);
        handle.flush();
        at = message.at;
        reply({ kind: 'ready' });
        return;
      }

      case 'append': {
        if (!handle) return;
        handle.write(message.record, { at });
        // Flushed on every record, because a journal that is only durable when
        // the browser feels like it is not a journal. Measured at nothing:
        // 0.128 ms with the flush and 0.128 without, on a 64 MB file.
        handle.flush();
        at += message.record.length;
        return;
      }

      case 'truncate': {
        if (!handle) return;
        handle.truncate(message.bytes);
        handle.flush();
        at = message.bytes;
        return;
      }

      case 'discard': {
        // Truncated rather than deleted, because the handle is held open and a
        // deleted file underneath one is a different mess in every browser. An
        // empty journal reads back as no journal, which is the same answer.
        handle?.truncate(0);
        handle?.flush();
        at = 0;
        reply({ kind: 'ready' });
        return;
      }

      default:
        return;
    }
  } catch (error) {
    // Reported rather than thrown. A journal that cannot write is a session
    // with no crash recovery, which is what every session had until this
    // chapter, and it is not a reason to take the editor down.
    reply({ kind: 'failed', error: String(error) });
  }
}

/**
 * ONE MESSAGE AT A TIME, and the reason is a bug this had before it was written
 * down.
 *
 * `serve` is asynchronous, because opening the handle is. Started per message,
 * the append that follows a `begin` runs while the begin is still awaiting its
 * handle, finds none, and returns having written nothing. What that lost was the
 * record naming the media, so the journal was a session with no media in it,
 * silently, which is precisely the failure a crash journal exists to not have.
 *
 * A promise chain rather than a queue of its own: messages arrive in order and
 * this makes them complete in order, which is all that was missing.
 */
let inOrder: Promise<void> = Promise.resolve();

self.addEventListener('message', (event: MessageEvent<ToJournal>) => {
  inOrder = inOrder.then(() => serve(event.data));
});
