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

  undo(): void {
    if (!this.canUndo) return;
    this.#applied--;
    this.#bump();
  }

  redo(): void {
    if (!this.canRedo) return;
    this.#applied++;
    this.#bump();
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
