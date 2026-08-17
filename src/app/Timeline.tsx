import type { JSX } from 'preact';

export interface TimelineProps {
  readonly frameCount: number;
  readonly frame: number;
  readonly frameRate: number;
  /** Frames carrying an edit, ascending. */
  readonly edited: readonly number[];
  /** `settled` is false while the pointer is still down. */
  readonly onScrub: (frame: number, settled: boolean) => void;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Frames as a timecode, which is what a person reading a timeline wants. */
function timecode(frame: number, frameRate: number): string {
  const rate = frameRate > 0 ? frameRate : 30;
  const totalSeconds = frame / rate;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  // Frames within the second, not hundredths: the unit an edit is made in is
  // the frame, and this is the only place its number is visible.
  const within = Math.round(frame - Math.floor(totalSeconds) * rate);
  return `${pad(minutes)}:${pad(seconds)}.${pad(within)}`;
}

/**
 * The timeline.
 *
 * A track and a knob, and the same instrument weight as the style sliders
 * rather than the weight of a media player: this is a control on a workbench,
 * not a transport for watching something.
 *
 * Stepped in frames rather than in seconds, because a frame is the unit an edit
 * will be attached to. Seconds are shown, since nobody thinks in frame 1043,
 * but the number that moves is integral.
 */
export function Timeline({ frameCount, frame, frameRate, edited, onScrub }: TimelineProps): JSX.Element {
  const last = Math.max(0, frameCount - 1);
  const fill = last > 0 ? (frame / last) * 100 : 0;

  return (
    <div class="timeline">
      <span class="timeline__time mono">{timecode(frame, frameRate)}</span>
      <div class="timeline__scrubber">
        {/*
          Where the edits are.
          A selection belongs to the frame it was made on and to no other, which
          is honest and, without this, invisible: scrub away and the work is
          gone from the screen with nothing to say it still exists. These are
          the only marks on the track, and they are the whole affordance.
        */}
        <div class="timeline__marks" aria-hidden="true">
          {edited.map((index) => (
            <span
              key={index}
              class="timeline__mark"
              style={{ left: `${String(last > 0 ? (index / last) * 100 : 0)}%` }}
            />
          ))}
        </div>
        <input
          class="slider timeline__track"
          type="range"
          min="0"
          max={last}
          step="1"
          value={frame}
          aria-label="Frame"
          style={{ '--fill': `${String(fill)}%` }}
          onInput={(event) => {
            onScrub(Number(event.currentTarget.value), false);
          }}
          // Settling is what promotes the frame from the draft tier to full, and
          // it has to come from every way a range input can end an interaction:
          // a pointer release, a key, and losing focus mid-drag.
          onPointerUp={(event) => {
            onScrub(Number(event.currentTarget.value), true);
          }}
          onKeyUp={(event) => {
            onScrub(Number(event.currentTarget.value), true);
          }}
          onBlur={(event) => {
            onScrub(Number(event.currentTarget.value), true);
          }}
        />
      </div>
      <span class="timeline__count mono">
        {frame + 1} / {frameCount}
      </span>
    </div>
  );
}
