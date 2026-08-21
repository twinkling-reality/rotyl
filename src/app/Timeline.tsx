import type { JSX } from 'preact';
import { PauseIcon, PlayIcon } from './icons.tsx';
// Type-only, and from the export rather than restated here: a range IS an
// export concept, and two identical declarations of it would be two places for
// somebody to decide whether the ends are inclusive.
import type { FrameRange } from '../platform/export/export-source.ts';
// Type-only, and from core, for the same reason a range comes from the export:
// what the log amounts to per frame is the log's question, and restating the
// shape here would be a second place for somebody to decide whether `to` is
// inclusive.
import type { EditSpan } from '../core/document/selection-command.ts';
import { movedEnd } from './range.ts';

export interface TimelineProps {
  readonly frameCount: number;
  readonly frame: number;
  readonly frameRate: number;
  /** What the log has to say, per stretch of the clip, ascending. */
  readonly spans: readonly EditSpan[];
  readonly playing: boolean;
  readonly onPlayToggle: () => void;
  /** `settled` is false while the pointer is still down. */
  readonly onScrub: (frame: number, settled: boolean) => void;
  /** The part a clip export writes, or the whole clip when nothing is set. */
  readonly range: FrameRange | undefined;
  readonly onRangeChange: (range: FrameRange | undefined) => void;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Frames as a timecode, which is what a person reading a timeline wants. */
export function timecode(frame: number, frameRate: number): string {
  const rate = frameRate > 0 ? frameRate : 30;
  const totalSeconds = frame / rate;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  // Frames within the second, not hundredths: the unit an edit is made in is
  // the frame, and this is the only place its number is visible.
  const within = Math.round(frame - Math.floor(totalSeconds) * rate);
  return `${pad(minutes)}:${pad(seconds)}.${pad(within)}`;
}

const percent = (frame: number, last: number): number => (last > 0 ? (frame / last) * 100 : 0);

/**
 * Half of one frame, as a percentage of the track.
 *
 * A mark is CENTRED on its frame, so a frame occupies the track from half a
 * frame before its position to half a frame after it. A band therefore runs
 * from half a frame before its first frame to half a frame after its last, and
 * not from one position to the other: measured that way every segment of a run
 * comes up one frame short, and on a sixty-frame clip that is seventeen pixels
 * of daylight between the end of one stretch and the start of the next. Which
 * is the one thing a run must not look like, since a gap is what "the run never
 * got here" looks like.
 */
const halfFrame = (last: number): number => (last > 0 ? 50 / last : 0);

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
export function Timeline({
  frameCount,
  frame,
  frameRate,
  spans,
  playing,
  onPlayToggle,
  onScrub,
  range,
  onRangeChange,
}: TimelineProps): JSX.Element {
  const last = Math.max(0, frameCount - 1);
  const fill = percent(frame, last);
  const half = halfFrame(last);

  return (
    <div class="timeline">
      <button
        type="button"
        class="timeline__play"
        onClick={onPlayToggle}
        aria-label={playing ? 'Pause' : 'Play'}
        aria-pressed={playing}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <span class="timeline__time mono">{timecode(frame, frameRate)}</span>
      <div class="timeline__scrubber">
        {/*
          Where the edits are.
          A selection holds from the frame it was made on until something later
          changes it, so the frame it was made on is the only place it can be
          found again, and without this it is invisible: scrub away and the work
          is gone from the screen with nothing to say it still exists.

          THREE THINGS RATHER THAN ONE, because the log has always known three
          and this layer used to be handed a list of frame numbers. An edit
          somebody made is a mark. A tracking run is a bar, because it is ONE
          gesture that happens to touch three hundred frames, and drawing it as
          three hundred marks said the opposite of what `group` has recorded
          since the day tracking landed. And a stretch a run found nothing in is
          the same bar drawn faintly: the run reached those frames and the model
          said the object was behind something, which is the difference between
          a tracker that failed and a tracker that worked and is telling the
          truth. That difference is the whole of what this chapter carried.
        */}
        <div class="timeline__marks" aria-hidden="true">
          {spans.map((span) =>
            span.kind === 'edit' ? (
              <span
                key={span.from}
                class="timeline__mark"
                style={{ left: `${String(percent(span.from, last))}%` }}
              />
            ) : (
              <span
                key={span.from}
                class={span.kind === 'absent' ? 'timeline__run timeline__run--absent' : 'timeline__run'}
                // Clamped at the ends of the track and nowhere else. A run
                // reaching the last frame would otherwise put half a frame of
                // itself past the end, which the marks layer does not clip; the
                // interior boundaries keep the extension, so two stretches of
                // one run still meet with nothing between them.
                style={{
                  left: `${String(Math.max(0, percent(span.from, last) - half))}%`,
                  width: `${String(
                    Math.min(100, percent(span.to, last) + half) -
                      Math.max(0, percent(span.from, last) - half),
                  )}%`,
                }}
              />
            ),
          )}
          {/*
            And what a clip export would write.
            NOTHING AT ALL WITH NO RANGE SET, which is the whole constraint on
            this: a clip somebody has said nothing about must not carry marks
            implying they have. Where there is one it is a bar under the track,
            in the same language as the edit marks above it, where a mark means
            something is there rather than something is missing. Under rather
            than over, so it never dims the playhead it is being set with.
          */}
          {range ? (
            <span
              class="timeline__range-bar"
              style={{
                left: `${String(percent(range.from, last))}%`,
                width: `${String(percent(range.to - range.from, last))}%`,
              }}
            />
          ) : null}
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
      {/*
        Marking the part to export.
        Two words rather than two icons, because there is no drawing of a
        bracket that anybody reads as "start the export here" without being
        told, and the keys are the ones every editor uses. The third appears
        only when there is a range to drop, which is what keeps the row from
        carrying a control for a decision nobody has taken. It is not called
        Clear and not called Whole clip: the toolbar already has a Clear, the
        export button is already called Clip, and a control whose name contains
        another control's name is a trap for anybody reaching things by name
        rather than by eye. In, Out and All is the set of answers to one
        question, which is what these three are.
      */}
      <div class="timeline__range">
        <button
          type="button"
          class="text-button text-button--quiet"
          title="Start the exported range here (I)"
          onClick={() => {
            onRangeChange(movedEnd(range, 'from', frame, last));
          }}
        >
          In
        </button>
        <button
          type="button"
          class="text-button text-button--quiet"
          title="End the exported range here (O)"
          onClick={() => {
            onRangeChange(movedEnd(range, 'to', frame, last));
          }}
        >
          Out
        </button>
        {range ? (
          <button
            type="button"
            class="text-button text-button--quiet"
            title="Export the whole clip again"
            onClick={() => {
              onRangeChange(undefined);
            }}
          >
            All
          </button>
        ) : null}
      </div>
      {/*
        Still the playhead, and deliberately not the range. Where the range is
        was just drawn on the track and is in the export button's own sentence;
        where the playhead is has nowhere else to be, and losing it the moment
        somebody marks a range would be taking away the number they were using
        to mark it.
      */}
      <span class="timeline__count mono">
        {frame + 1} / {frameCount}
      </span>
    </div>
  );
}
