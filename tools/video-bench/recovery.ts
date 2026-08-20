// MEASUREMENT 13: what it costs to write the log down on every edit.
//
// The chapter before this one gave the command log a file and a button. What it
// did not do is survive a tab that dies: saving is a thing somebody presses, so
// a crash still costs whatever has happened since they last pressed it, which
// on a tracked run is three quarters of a minute of work per press they did not
// make.
//
// The obvious answer is to write it down as it happens, and that is exactly the
// kind of "obviously cheap" that has been wrong here before.
// [Measurement 12](#12) put a whole ten-minute document at 11 ms to build and
// 46 ms to assemble, which sounds like it could be done per edit until you
// notice that a tracked run produces one edit every 135 ms and there would be
// eighteen thousand of them.
//
// So three things are asked, and any of them could force a different design.
//
//   WHICH OPFS API, and whether the cheap-looking one is cheap. A browser with
//   no save dialog still has the origin private file system, and
//   `docs/limits.md` already prices it as storage with a quota rather than a
//   disk. What has never been measured here is what a WRITE to it costs, and
//   there are two ways to do one that could differ by orders of magnitude:
//   `createWritable`, which is the ordinary handle API, and
//   `createSyncAccessHandle`, which is the one a worker gets. If the first
//   copies the file to open a stream on it, appending to a 65 MB journal costs
//   65 MB every time and the whole idea is dead in that form.
//
//   APPENDING ONE RECORD AGAINST REWRITING THE WHOLE DOCUMENT. One path for
//   both is this project's answer to most questions of this shape, and the
//   whole-document path needs no second format at all. What it costs is
//   quadratic in the number of edits, and whether that matters is a number
//   rather than an opinion.
//
//   WHAT RECOVERY COSTS, which decides whether the thing that comes back on
//   startup can be handed straight to the existing document path or has to be
//   done in the background behind something.
//
// No GPU and no clips, like measurements 8 and 12. It needs a browser, because
// the origin private file system is the thing being measured.

import type { CoverageMask } from '../../src/core/document/coverage-mask.ts';
import { DEFAULT_REFINE_SETTINGS } from '../../src/core/mask/refine-params.ts';
import { writeDocument, type RotylDocument } from '../../src/platform/document/document-file.ts';
import type { SelectionCommand } from '../../src/core/document/selection-command.ts';
import { coverage } from './log.ts';
import { sample, type Stat } from './util.ts';

/** Where every rung writes, cleaned out first so a rerun is not measuring a leftover. */
const DIR = 'rotyl-bench';

async function scratch(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(DIR, { recursive: true }).catch(() => undefined);
  return root.getDirectoryHandle(DIR, { create: true });
}

/**
 * One journal record, framed the way an append-only log has to be.
 *
 * A length in front of a payload, so a reader can walk forward without an index
 * and a writer never has to go back and fix anything up. This is the shape the
 * measurement is about rather than a proposal: what is being timed is a write
 * of about this many bytes, and the exact framing is the product's business.
 */
function record(command: SelectionCommand): Uint8Array<ArrayBuffer> {
  const mask = command.kind === 'applyMask' ? command.mask.packed : new Uint8Array(new ArrayBuffer(0));
  const rest = command.kind === 'applyMask' ? { ...command, mask: undefined } : command;
  const json = new TextEncoder().encode(JSON.stringify(rest));
  const out = new Uint8Array(new ArrayBuffer(8 + json.length + mask.length));
  const view = new DataView(out.buffer);
  view.setUint32(0, json.length, true);
  view.setUint32(4, mask.length, true);
  out.set(json, 8);
  out.set(mask, 8 + json.length);
  return out;
}

function trackedCommand(frame: number, mask: CoverageMask): SelectionCommand {
  return { kind: 'applyMask', mask, op: 'replace', refine: DEFAULT_REFINE_SETTINGS, frame, group: 1 };
}

function strokeCommand(frame: number): SelectionCommand {
  const points = Array.from({ length: 60 }, (_, i) => ({ x: 400 + i * 7, y: 300 + Math.sin(i / 4) * 90 }));
  return { kind: 'paint', stroke: { points, radius: 64, hardness: 0.7 }, frame };
}

const MEDIA = {
  name: 'city.mp4',
  bytes: 1_243_000_000,
  width: 1920,
  height: 1080,
  frames: 18_000,
  digest: '0'.repeat(64),
} as const;

function documentOf(commands: readonly SelectionCommand[]): RotylDocument {
  return {
    media: MEDIA,
    commands,
    frame: Math.max(0, commands.length - 1),
    style: { id: 'comic', controls: { strength: 0.8, detail: 0.5, palette: 2 } },
  };
}

/** Grow a file to `bytes` in one pass, so the rungs after it start from a real one. */
async function fill(dir: FileSystemDirectoryHandle, name: string, block: Uint8Array, times: number) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  const writer = writable.getWriter();
  for (let i = 0; i < times; i++) await writer.write(block);
  await writer.close();
  return handle;
}

/**
 * The sync access handle, which the spec puts in a worker.
 *
 * Asked rather than assumed, in both places, because the answer decides whether
 * this product would need a Web Worker for the first time. `architecture.md`
 * rejected one for export at 50% slower, and a journal is a completely
 * different trade: three and a half kilobytes an edit rather than a
 * full-resolution image per frame.
 *
 * The worker is built from a blob so the measurement carries its own code and
 * needs nothing served alongside it.
 */
const WORKER_SOURCE = `
let access = null;
let at = 0;

self.addEventListener('message', async (event) => {
  const message = event.data;
  try {
    if (message.kind === 'open') {
      const root = await navigator.storage.getDirectory();
      const scratch = await root.getDirectoryHandle(message.dir, { create: true });
      const handle = await scratch.getFileHandle(message.name, { create: true });
      access = await handle.createSyncAccessHandle();
      access.truncate(0);
      at = 0;

      // Grown first, so what follows are appends to a real file rather than to
      // an empty one: a cost that depends on the size already there is the whole
      // thing this is looking for.
      const block = new Uint8Array(message.bytes);
      for (let i = 0; i < message.bytes; i += 64) block[i] = i & 0xff;
      for (let i = 0; i < message.prefill; i++) {
        access.write(block, { at });
        at += message.bytes;
      }
      access.flush();
      self.postMessage({ ok: true, size: access.getSize() });
      return;
    }

    if (message.kind === 'batch') {
      const block = new Uint8Array(message.bytes);
      const samples = [];
      // Timed as a batch as well as per write, because performance.now() is
      // coarsened to a tenth of a millisecond here and a per-write figure would
      // report the clock rather than the write.
      const t0 = performance.now();
      for (let i = 0; i < message.appends; i++) {
        const each = performance.now();
        access.write(block, { at });
        if (message.flush) access.flush();
        at += message.bytes;
        samples.push(performance.now() - each);
      }
      if (!message.flush) access.flush();
      const total = performance.now() - t0;
      self.postMessage({ ok: true, samples, total, appends: message.appends, size: access.getSize() });
      return;
    }

    if (message.kind === 'one') {
      // One record, written and acknowledged, which is what an edit does.
      const t0 = performance.now();
      access.write(message.record, { at });
      access.flush();
      at += message.record.byteLength;
      self.postMessage({ ok: true, inside: performance.now() - t0 });
      return;
    }

    if (message.kind === 'close') {
      const size = access.getSize();
      access.close();
      access = null;
      self.postMessage({ ok: true, size });
      return;
    }
  } catch (error) {
    self.postMessage({ ok: false, error: String(error) });
  }
});
`;

interface WorkerReply {
  ok: boolean;
  samples?: number[];
  total?: number;
  appends?: number;
  inside?: number;
  size?: number;
  error?: string;
}

/**
 * A worker held open across several messages, because the sync access handle is
 * held open across several writes and closing one between edits would be
 * measuring the open rather than the write.
 */
class Journal {
  readonly #worker: Worker;
  readonly #url: string;

  constructor() {
    this.#url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    this.#worker = new Worker(this.#url);
  }

  ask(message: Record<string, unknown>): Promise<WorkerReply> {
    return new Promise<WorkerReply>((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerReply>): void => {
        this.#worker.removeEventListener('message', onMessage);
        resolve(event.data);
      };
      this.#worker.addEventListener('message', onMessage);
      this.#worker.addEventListener('error', (event) => {
        reject(new Error(`worker: ${event.message}`));
      });
      // A worker, so there is no origin to target: `postMessage` on one takes a
      // transfer list rather than the window form's second argument, and the
      // rule below cannot tell the two apart.
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      this.#worker.postMessage(message);
    });
  }

  /** What the MAIN THREAD pays to hand one record over, which is what an edit costs. */
  post(entry: Uint8Array<ArrayBuffer>): void {
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    this.#worker.postMessage({ kind: 'one', record: entry });
  }

  dispose(): void {
    this.#worker.terminate();
    URL.revokeObjectURL(this.#url);
  }
}

export async function recovery(): Promise<unknown> {
  const out: Record<string, unknown> = {};
  const dir = await scratch();

  const mask = coverage(0.5);
  const one = record(trackedCommand(0, mask));
  out.a_journal_record_bytes = one.length;

  // --- is the sync access handle reachable without a worker? ----------------
  //
  // The spec puts it in a dedicated worker. Asked of the browser rather than of
  // anyone's memory, because it is the difference between a module and a module
  // plus this product's first Web Worker.
  const handle = await dir.getFileHandle('probe', { create: true });
  let sync: string;
  try {
    const access = await (
      handle as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<{ close: () => void }> }
    ).createSyncAccessHandle?.();
    if (access) {
      access.close();
      sync = 'available on the main thread';
    } else {
      sync = 'no createSyncAccessHandle on the handle at all';
    }
  } catch (error) {
    sync = String(error);
  }
  out.sync_access_handle_on_the_main_thread = sync;

  // --- what createWritable costs to OPEN, by how large the file already is ---
  //
  // The decisive sub-measurement. If opening a writable copies what is already
  // there, an append is not an append and a journal cannot be written this way.
  const opening: Record<string, unknown> = {};
  const megabyte = new Uint8Array(new ArrayBuffer(1 << 20));
  for (let at = 0; at < megabyte.length; at += 64) megabyte[at] = at & 0xff;
  for (const megabytes of [0, 1, 16, 64]) {
    const name = `open-${String(megabytes)}`;
    const file = await fill(dir, name, megabyte, megabytes);
    const timing = await sample(9, 2, async () => {
      const writable = await file.createWritable({ keepExistingData: true });
      await writable.close();
    });
    opening[`${String(megabytes)} MB already in it`] = { ms: timing };
  }
  out.opening_a_writable = opening;

  // --- appending one record, both ways, on a file that is already large -----
  const appending: Record<string, unknown> = {};
  for (const [label, prefill] of [
    ['an empty journal', 0],
    ['a 300-frame run already in it', 300],
    ['ten minutes already in it', 18_000],
  ] as const) {
    const file = await fill(dir, `append-${String(prefill)}`, one, prefill);

    // Through createWritable, which is everything a page can reach without a
    // worker: read the size, open a stream, seek to the end, write, close.
    const writable: Stat = await sample(prefill > 1000 ? 5 : 11, 2, async () => {
      const size = (await file.getFile()).size;
      const stream = await file.createWritable({ keepExistingData: true });
      await stream.seek(size);
      await stream.write(one);
      await stream.close();
    });

    const journal = new Journal();
    let inWorker: Record<string, unknown> = {};
    try {
      const opened = await journal.ask({
        kind: 'open',
        dir: DIR,
        name: `worker-${String(prefill)}`,
        bytes: one.length,
        prefill,
      });
      if (!opened.ok) throw new Error(opened.error ?? 'the worker would not open a handle');

      // A batch as well as per write, because performance.now() is coarsened to
      // a tenth of a millisecond and a per-write median at the floor of the
      // clock is a measurement of the clock.
      const appends = 2000;
      const durable = await journal.ask({ kind: 'batch', bytes: one.length, appends, flush: true });
      const loose = await journal.ask({ kind: 'batch', bytes: one.length, appends, flush: false });

      // AND WHAT THE MAIN THREAD PAYS, which is the number the interface cares
      // about: the write happens somewhere else, so an edit costs whatever it
      // takes to hand the record over and nothing more.
      const handing: Stat = await sample(200, 20, () => {
        journal.post(one);
      });

      inWorker = {
        inside_the_worker_per_append_ms: Math.round(((durable.total ?? 0) / appends) * 1000) / 1000,
        without_flushing_per_append_ms: Math.round(((loose.total ?? 0) / appends) * 1000) / 1000,
        handing_it_over_on_the_main_thread_ms: handing,
        final_megabytes: Math.round(((durable.size ?? 0) / 1e6) * 10) / 10,
      };
      await journal.ask({ kind: 'close' });
    } catch (error) {
      inWorker = { the_worker_failed: String(error) };
    } finally {
      journal.dispose();
    }

    appending[label] = {
      records_already_there: prefill,
      megabytes_already_there: Math.round(((prefill * one.length) / 1e6) * 10) / 10,
      through_create_writable_ms: writable,
      ...inWorker,
    };
  }
  out.appending_one_record = appending;

  // --- rewriting the whole document instead, which needs no second format ---
  const rewriting: Record<string, unknown> = {};
  for (const [label, count] of [
    ['one stroke', 1],
    ['a 300-frame run', 301],
    ['ten minutes', 18_001],
  ] as const) {
    const commands: SelectionCommand[] = [strokeCommand(0)];
    for (let frame = 1; frame < count; frame++) commands.push(trackedCommand(frame, mask));
    const document = documentOf(commands);
    const file = await dir.getFileHandle(`rewrite-${String(count)}`, { create: true });

    let bytes = 0;
    const timing: Stat = await sample(count > 10_000 ? 3 : 9, 1, async () => {
      const chunks = writeDocument(document);
      const stream = await file.createWritable();
      const writer = stream.getWriter();
      bytes = 0;
      for (const chunk of chunks) {
        await writer.write(chunk);
        bytes += chunk.length;
      }
      await writer.close();
    });
    rewriting[label] = { commands: count, bytes, ms: timing };
  }
  out.rewriting_the_whole_document = rewriting;

  // --- and reading it back, which is what a recovery pays -------------------
  const reading: Record<string, unknown> = {};
  for (const [label, prefill] of [
    ['a 300-frame run', 300],
    ['ten minutes', 18_000],
  ] as const) {
    const file = await dir.getFileHandle(`append-${String(prefill)}`);
    let walked = 0;
    const timing: Stat = await sample(prefill > 1000 ? 5 : 11, 2, async () => {
      const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
      const view = new DataView(bytes.buffer);
      const decoder = new TextDecoder();
      walked = 0;
      let at = 0;
      while (at + 8 <= bytes.length) {
        const json = view.getUint32(at, true);
        const payload = view.getUint32(at + 4, true);
        // Parsed, not skipped: what a recovery pays is turning records back
        // into commands, and a walk that only added up lengths would measure
        // the disk rather than the work.
        JSON.parse(decoder.decode(bytes.subarray(at + 8, at + 8 + json)));
        at += 8 + json + payload;
        walked++;
      }
    });
    reading[label] = { records: walked, ms: timing };
  }
  out.reading_a_journal_back = reading;

  // --- how much room there is, which limits.md already half answers ---------
  const estimate = await navigator.storage.estimate();
  out.quota = {
    usage_megabytes: Math.round((estimate.usage ?? 0) / 1e6),
    quota_megabytes: Math.round((estimate.quota ?? 0) / 1e6),
    persisted: await navigator.storage.persisted?.(),
  };

  // Left clean, because a benchmark that fills somebody's origin private file
  // system with sixty-five megabytes of test data and walks away is rude.
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(DIR, { recursive: true }).catch(() => undefined);

  return out;
}
