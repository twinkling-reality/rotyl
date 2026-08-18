import type { SelectionCommand } from './selection-command.ts';

/**
 * The applied command log, plus undo/redo.
 *
 * Deliberately not a reactive store: it exposes `subscribe` and nothing else,
 * so the UI framework can adapt it (one `useSyncExternalStore` bridge lives in
 * the app layer) without the engine ever depending on a framework.
 *
 * `revision` increments on every change so consumers can diff cheaply instead
 * of comparing command arrays.
 */
export class SelectionDocument {
  #commands: SelectionCommand[] = [];
  /** Number of commands currently applied; commands past this are redoable. */
  #applied = 0;
  #revision = 0;
  #groups = 0;
  #listeners = new Set<() => void>();

  /** The commands that are currently in effect, oldest first. */
  get appliedCommands(): readonly SelectionCommand[] {
    return this.#commands.slice(0, this.#applied);
  }

  get revision(): number {
    return this.#revision;
  }

  get canUndo(): boolean {
    return this.#applied > 0;
  }

  get canRedo(): boolean {
    return this.#applied < this.#commands.length;
  }

  /** True when no edit has been made, so the UI can distinguish clean from cleared. */
  get isEmpty(): boolean {
    return this.#applied === 0;
  }

  apply(command: SelectionCommand): void {
    // Applying after an undo discards the redo tail, which is what every
    // editor does and what users expect.
    this.#commands.length = this.#applied;
    this.#commands.push(command);
    this.#applied++;
    this.#bump();
  }

  /**
   * An id for a gesture that is about to produce more than one command.
   *
   * Owned here rather than by the caller so two jobs cannot pick the same
   * number, which would silently weld their commands into one undo.
   */
  beginGroup(): number {
    return ++this.#groups;
  }

  /**
   * Step back one command, and say which one.
   *
   * ONE CURSOR OVER ONE LIST, EVEN ACROSS FRAMES, and the returned command is
   * what makes that honest rather than merely simple. Undo means "the last
   * thing I did", which may be on a frame that is not being shown; a caller
   * that moves the view to the returned command's frame turns an edit
   * disappearing somewhere invisible into an edit disappearing in front of you.
   *
   * It also disarms the sharp edge in `apply`. The redo tail is discarded on
   * the next edit, so undoing another frame's work and then drawing would
   * destroy it, but a caller that follows the cursor is now on that frame, and
   * the sequence is the ordinary single-frame one it has always been.
   *
   * A per-frame cursor was the alternative and it is worse: "undo" would stop
   * meaning the last thing you did, and a list per frame cannot express the
   * order two frames were edited in, which is the only thing anybody remembers.
   */
  undo(): SelectionCommand | undefined {
    if (!this.canUndo) return undefined;
    const last = this.#commands[this.#applied - 1];
    this.#applied = this.#startOfGroup(this.#applied - 1);
    this.#bump();
    // The FIRST command of the group, not the last, which matters only for a
    // group and matters a lot there: a caller that follows the cursor should
    // land on the frame the gesture was made on rather than on the frame three
    // hundred frames later where it happened to stop.
    return this.#commands[this.#applied] ?? last;
  }

  /** Step forward one command, and say which one. See `undo`. */
  redo(): SelectionCommand | undefined {
    if (!this.canRedo) return undefined;
    const command = this.#commands[this.#applied];
    this.#applied = this.#endOfGroup(this.#applied);
    this.#bump();
    return command;
  }

  /** Where the group containing `index` starts, or `index` when it is alone. */
  #startOfGroup(index: number): number {
    const group = this.#commands[index]?.group;
    if (group === undefined) return index;
    let start = index;
    while (start > 0 && this.#commands[start - 1]?.group === group) start--;
    return start;
  }

  /** One past the end of the group starting at `index`. */
  #endOfGroup(index: number): number {
    const group = this.#commands[index]?.group;
    if (group === undefined) return index + 1;
    let end = index + 1;
    while (end < this.#commands.length && this.#commands[end]?.group === group) end++;
    return end;
  }

  /** Drop the entire history, for loading a new document. */
  reset(): void {
    this.#commands = [];
    this.#applied = 0;
    // Group ids are NOT reset. They are only ever compared for equality, and a
    // counter that restarts could weld a new document's first group onto a
    // stale command someone was still holding.
    this.#bump();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #bump(): void {
    this.#revision++;
    for (const listener of this.#listeners) listener();
  }
}
