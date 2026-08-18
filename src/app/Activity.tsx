import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';

export interface ActivityProps {
  /** What is happening, in the present participle: "Opening", "Exporting". */
  readonly label: string;
  /** 0 to 1 when it is known. Absent when it is not, which is most of the time. */
  readonly progress?: number | undefined;
}

/**
 * The one way this application says it is working.
 *
 * Standardised rather than per-case because a product that spins one way here
 * and pulses another way there reads as several products. Every wait in Rotyl
 * goes through this: opening a file, restoring after a lost device, downloading
 * the object model, reading a frame, exporting.
 *
 * A SHIMMER RATHER THAN A SPINNER. A spinner says "something is happening";
 * text that says what is happening says that too, and answers the next question
 * as well. The sweep across it is the part that makes it read as ongoing rather
 * than as a label that has got stuck, which is the whole job a spinner is doing.
 *
 * The determinate form is a hairline under the words, and appears only where a
 * real fraction exists. That is the model download, tens of megabytes and once
 * per machine: everything else here is hundreds of milliseconds, where a number
 * would flicker and a bar would be a lie about precision.
 */
export function Activity({ label, progress }: ActivityProps): JSX.Element | null {
  const shown = useVisibleAfter(APPEARS_AFTER);
  if (!shown) return null;

  return (
    <span class="activity">
      <span class="activity__label">{label}</span>
      {progress === undefined ? null : (
        <span class="activity__track">
          <span
            class="activity__fill"
            style={{ transform: `scaleX(${String(Math.min(1, Math.max(0, progress)))})` }}
          />
        </span>
      )}
    </span>
  );
}

/**
 * How long a wait has to last before it is worth mentioning.
 *
 * Under this, an indicator is a flash of something the eye reads as a glitch
 * rather than as information, and the operation has finished before anyone has
 * worked out what appeared. Over it, silence reads as a hang. 220 ms is roughly
 * where one becomes the other, and it means most opens and every style change
 * show nothing at all.
 */
const APPEARS_AFTER = 220;

function useVisibleAfter(delay: number): boolean {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setShown(true);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [delay]);

  return shown;
}
