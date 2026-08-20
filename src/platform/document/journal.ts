import type { SelectionCommand } from '../../core/document/selection-command.ts';
import type { SelectionDocument } from '../../core/document/selection-document.ts';
import {
  commandFromWire,
  commandToWire,
  documentStateFromWire,
  type RotylDocument,
} from './document-file.ts';
import {
  COMMAND_RECORD,
  frameRecord,
  JOURNAL_HEADER_BYTES,
  STATE_RECORD,
  walkJournal,
} from './journal-record.ts';
import { JOURNAL_DIRECTORY, JOURNAL_FILE, type FromJournal, type ToJournal } from './journal-worker.ts';

/**
 * The command log, written down as it happens, so a tab that dies costs nothing.
 *
 * The chapter before this one gave the log a file and a button. What a button
 * cannot do is protect the work between presses, and on a tracked run that is
 * three quarters of a minute per press somebody did not make. So the log is
 * written down as it is made, and a session that ended without being given back
 * is offered again on the next load.
 *
 * A JOURNAL IS THE SAME LOG IN A DIFFERENT SHAPE, and the measurement is why
 * there are two shapes rather than one. A document is one JSON header with the
 * masks behind it, written once: 11 ms for ten minutes of tracking. Written
 * eighteen thousand times instead, that same path measures 2559 ms PER EDIT at
 * that size, because the header is at the front and grows. Appending one
 * self-describing record measures 0.13 ms whatever is already in the file, and
 * costs the main thread nothing at all, because the write happens in a worker.
 * See `journal-worker.ts` for why there has to be one.
 *
 * WHAT IS IN IT IS EXACTLY WHAT IS IN A DOCUMENT. A recovery hands back a
 * `RotylDocument`, which then goes through the same path a dropped `.rotyl`
 * takes: the same media check, the same replay, the same refusal if the file
 * somebody supplies is the wrong one. Recovery is a document nobody had to
 * save, and that is the whole of it as far as the interface is concerned.
 *
 * IT IS NOT A SAVE, AND IT DOES NOT PRETEND TO BE. Nothing appears while it
 * writes, no indicator, no line, because there is nothing to say about 0.13 ms
 * in another thread. The Save button is still the way work leaves this browser
 * and reaches somewhere the user chose.
 */

/** Everything a document says that is not a command, which is one record. */
export type SessionState = Omit<RotylDocument, 'commands'>;

/**
 * How long the playhead has to sit still before it is written down.
 *
 * COMMANDS ARE NEVER DEBOUNCED and this is not a command. A scrub moves the
 * frame thirty times a second, and writing each one would fill a journal with a
 * record per rendered frame for a value nobody edited. Half a second of quiet
 * is the most a crash can cost here, and what it costs is where the playhead
 * was rather than any of the work.
 */
const STATE_SETTLES_IN = 500;

export class SessionJournal {
  #worker: Worker | undefined;
  /** True once the worker has failed, after which everything here is a no-op. */
  #broken = false;

  /** The commands already written, by identity, and where each record began. */
  #written: SelectionCommand[] = [];
  #offsets: number[] = [];
  #at = 0;

  #state: SessionState | undefined;
  #pending: ReturnType<typeof setTimeout> | undefined;
  /**
   * Whether a journal has been opened at all.
   *
   * The interface notices the playhead and the style through an effect, and an
   * effect can run while the open that is about to `begin` is still awaiting a
   * digest. A state record written then belongs to no journal: it is either
   * dropped, because the worker has no handle yet, or lands in front of the
   * header that is about to overwrite it. Neither is a bug worth reasoning
   * about twice, so nothing is written until there is somewhere to write it.
   */
  #started = false;

  /**
   * Whatever a previous session left behind, as a document, or nothing.
   *
   * ON THE MAIN THREAD AND WITHOUT A WORKER, deliberately. This runs once at
   * start-up, before any file is open and therefore before any worker exists,
   * so it is an ordinary read of an ordinary file: 40 ms on a ten-minute
   * journal of eighteen thousand records. Spinning a worker up to do it would
   * cost every session that never opens anything a thread.
   *
   * A journal that is damaged, truncated mid-write or written by a build that
   * meant something else by a record answers "nothing". Discarded rather than
   * refused with a sentence, because unlike a document nobody asked for this to
   * be opened, and a complaint about a file the user has never seen is noise.
   */
  /** What the last session left, kept so a recovery can carry on writing it. */
  #stashed:
    | { commands: readonly SelectionCommand[]; offsets: number[]; size: number; state: SessionState }
    | undefined;

  async recover(): Promise<RotylDocument | undefined> {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(JOURNAL_DIRECTORY);
      const file = await (await directory.getFileHandle(JOURNAL_FILE)).getFile();
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      // No directory, no file, or no origin private file system at all. All
      // three mean the same thing here: there is nothing to come back to.
      return undefined;
    }

    let state: SessionState | undefined;
    const commands: SelectionCommand[] = [];
    const offsets: number[] = [];
    // Where the last whole record ended, which is where a resumed session
    // appends from. Not the file's length: a tab killed mid-append leaves a
    // fragment after it, and writing past that would keep the fragment.
    let size = 0;
    for (const entry of walkJournal(bytes)) {
      try {
        if (entry.kind === STATE_RECORD) {
          state = documentStateFromWire(entry.wire);
        } else {
          offsets.push(entry.at);
          commands.push(commandFromWire(entry.wire, entry.payload));
        }
      } catch {
        // One record this build cannot read, and everything before it is real
        // work. Stopping keeps that work, which is the rule a stopped export
        // and a stopped tracking run both already follow.
        break;
      }
      size = entry.end;
    }

    if (!state || commands.length === 0) return undefined;
    this.#stashed = { commands, offsets, size, state };
    return { ...state, commands };
  }

  /**
   * Carry on writing the journal a recovery just came out of.
   *
   * Called instead of `begin` when the document being restored is the one this
   * session recovered. The records are already on the disk, so beginning again
   * would rewrite every one of them: on ten minutes of tracking that is
   * eighteen thousand appends and 64 MB, and until it finished the journal
   * would not hold the work it exists to protect.
   *
   * Answers false when there is nothing stashed, so the caller falls back to
   * `begin` rather than silently writing nothing.
   */
  resume(): boolean {
    const stashed = this.#stashed;
    if (!stashed) return false;
    this.#started = true;
    this.#written = [...stashed.commands];
    this.#offsets = [...stashed.offsets];
    this.#at = stashed.size;
    this.#state = stashed.state;
    this.#post({ kind: 'resume', at: stashed.size });
    return true;
  }

  /**
   * Start a journal for a file that has just been opened.
   *
   * The state goes in first, so a journal always names its media before it
   * carries a single command. A recovery with commands and no state is a
   * journal cut off in its first few milliseconds, and it answers "nothing".
   */
  begin(state: SessionState): void {
    this.#started = true;
    this.#written = [];
    this.#offsets = [];
    // Past the header the worker is about to write, because every offset kept
    // here is a position in that file and an undo cuts back to one of them.
    this.#at = JOURNAL_HEADER_BYTES;
    this.#state = undefined;
    this.#post({ kind: 'begin' });
    this.note(state, true);
  }

  /**
   * Where the playhead is, what is marked, and what it looks like.
   *
   * Written only when it has changed, and then only after it has stopped
   * changing, for the reason `STATE_SETTLES_IN` gives. `now` is for the one
   * that must not wait: the record that names the media.
   */
  note(state: SessionState, now = false): void {
    if (!this.#started || this.#same(state)) return;
    this.#state = state;
    if (this.#pending !== undefined) clearTimeout(this.#pending);
    if (now) {
      this.#writeState();
      return;
    }
    this.#pending = setTimeout(() => {
      this.#writeState();
    }, STATE_SETTLES_IN);
  }

  /**
   * Follow a command log for as long as the returned function is not called.
   *
   * The journal is DEFINED as the applied commands, so every change is either
   * an extension of what is written or a cut back to where the two agree. The
   * common case is one command arriving on the end, which is one identity
   * comparison and one message.
   */
  follow(document: SelectionDocument): () => void {
    return document.subscribe(() => {
      this.#sync(document.appliedCommands);
    });
  }

  /** The file was given back, so there is nothing left to come back to. */
  discard(): void {
    this.#started = false;
    if (this.#pending !== undefined) clearTimeout(this.#pending);
    this.#pending = undefined;
    this.#written = [];
    this.#offsets = [];
    this.#at = 0;
    this.#state = undefined;
    if (this.#worker) {
      this.#post({ kind: 'discard' });
      return;
    }
    // Nothing has been written this session, so what is on the disk belongs to
    // a previous one and there is no handle held open over it.
    void SessionJournal.#erase();
  }

  dispose(): void {
    if (this.#pending !== undefined) clearTimeout(this.#pending);
    this.#worker?.terminate();
    this.#worker = undefined;
  }

  static async #erase(): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(JOURNAL_DIRECTORY);
      await directory.removeEntry(JOURNAL_FILE);
    } catch {
      // Nothing there, which is the state this was asking for.
    }
  }

  #same(state: SessionState): boolean {
    const last = this.#state;
    if (!last) return false;
    if (last.frame !== state.frame || last.media.digest !== state.media.digest) return false;
    if (last.range?.from !== state.range?.from || last.range?.to !== state.range?.to) return false;
    if (last.style.id !== state.style.id) return false;
    const keys = Object.keys(state.style.controls);
    if (keys.length !== Object.keys(last.style.controls).length) return false;
    return keys.every((key) => last.style.controls[key] === state.style.controls[key]);
  }

  #writeState(): void {
    this.#pending = undefined;
    const state = this.#state;
    if (!state) return;
    // Appended like anything else rather than seeking back to rewrite the last
    // one. A record that is superseded costs 300 bytes and the last one wins on
    // the way back, where an in-place update would need the journal to know
    // where its own records are and would stop it being append-only.
    this.#append(frameRecord(STATE_RECORD, state, EMPTY));
  }

  #sync(applied: readonly SelectionCommand[]): void {
    // Nothing before there is a journal, for the reason `#started` gives. A log
    // being reset for a file that is about to be opened is not work.
    if (!this.#started) return;

    // The common case first: one command on the end of what is already written.
    // Everything else walks, and everything else is an undo.
    let same = this.#written.length;
    if (same > applied.length || this.#written[same - 1] !== applied[same - 1]) {
      same = 0;
      while (same < this.#written.length && same < applied.length && this.#written[same] === applied[same]) {
        same++;
      }
    }

    if (same < this.#written.length) {
      const bytes = this.#offsets[same] ?? JOURNAL_HEADER_BYTES;
      this.#post({ kind: 'truncate', bytes });
      this.#written.length = same;
      this.#offsets.length = same;
      this.#at = bytes;
    }

    for (let index = same; index < applied.length; index++) {
      const command = applied[index];
      if (!command) continue;
      // `at` is zero because each record carries its own payload region, where
      // a document concatenates every mask into one and offsets into it.
      const { wire, payload } = commandToWire(command, 0);
      this.#written.push(command);
      this.#offsets.push(this.#at);
      this.#append(frameRecord(COMMAND_RECORD, wire, payload));
    }
  }

  #append(record: Uint8Array<ArrayBuffer>): void {
    this.#at += record.length;
    // TRANSFERRED, not copied. The record was allocated for this message and
    // nothing else refers to it, so handing the buffer over rather than cloning
    // it is free and correct.
    this.#post({ kind: 'append', record }, [record.buffer]);
  }

  #post(message: ToJournal, transfer: readonly ArrayBuffer[] = []): void {
    if (this.#broken) return;
    try {
      this.#worker ??= this.#start();
      this.#worker.postMessage(message, [...transfer]);
    } catch {
      // A browser with no worker, no module worker, or no origin private file
      // system. Every one of them means the same thing: this session has no
      // crash recovery, which is what every session had before this chapter.
      this.#broken = true;
    }
  }

  #start(): Worker {
    const worker = new Worker(new URL('./journal-worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<FromJournal>) => {
      if (event.data.kind === 'failed') this.#broken = true;
    });
    // A worker that fails to load at all reports here rather than throwing into
    // whichever edit happened to be first.
    worker.addEventListener('error', () => {
      this.#broken = true;
    });
    return worker;
  }
}

const EMPTY = new Uint8Array(new ArrayBuffer(0));
