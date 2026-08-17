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
   * destroy it — but a caller that follows the cursor is now on that frame, and
   * the sequence is the ordinary single-frame one it has always been.
   *
   * A per-frame cursor was the alternative and it is worse: "undo" would stop
   * meaning the last thing you did, and a list per frame cannot express the
   * order two frames were edited in, which is the only thing anybody remembers.
   */
  undo(): SelectionCommand | undefined {
    if (!this.canUndo) return undefined;
    this.#applied--;
    this.#bump();
    return this.#commands[this.#applied];
  }

  /** Step forward one command, and say which one. See `undo`. */
  redo(): SelectionCommand | undefined {
    if (!this.canRedo) return undefined;
    const command = this.#commands[this.#applied];
    this.#applied++;
    this.#bump();
    return command;
  }

  /** Drop the entire history, for loading a new document. */
  reset(): void {
    this.#commands = [];
    this.#applied = 0;
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
