import type { JSX } from 'preact';
import type { IllustratedStatus } from '../core/illustrated/request.ts';
import { ILLUSTRATED_TERMS } from '../core/illustrated/terms.ts';

export interface IllustratedConsentProps {
  readonly status: IllustratedStatus;
  readonly hasSelection: boolean;
  readonly sending: boolean;
  readonly active: boolean;
  readonly onSend: () => void;
  readonly onClear: () => void;
}

/**
 * The hosted illustrated still, asked in place.
 *
 * Not a style shelf and not a dialog. The four terms have to be readable
 * before a still can leave, so this is a panel of sentences rather than a
 * slider. Send stays disabled until there is a selection and the host is
 * configured. Clearing drops the layer and does not talk to the host.
 */
export function IllustratedConsent({
  status,
  hasSelection,
  sending,
  active,
  onSend,
  onClear,
}: IllustratedConsentProps): JSX.Element {
  const terms = status.terms ?? ILLUSTRATED_TERMS;
  const sendTitle = !status.available
    ? (status.reason ?? 'The host has not configured the illustrated stills job.')
    : !hasSelection
      ? 'Select the person first. Only that region will show the result.'
      : 'Send this still for a hosted illustrated treatment of the selection.';

  return (
    <aside class="illustrated-shelf" aria-label="Hosted illustrated still">
      <p class="illustrated-shelf__title">{terms.title}</p>
      <p class="illustrated-shelf__lede">
        Separate from Comic, Poster, Print and Anime. Stills only. The still leaves this machine only if you
        send it.
      </p>
      <dl class="illustrated-shelf__terms">
        <div>
          <dt>Privacy</dt>
          <dd>{terms.privacy}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{terms.cost}</dd>
        </div>
        <div>
          <dt>Latency</dt>
          <dd>{terms.latency}</dd>
        </div>
        <div>
          <dt>Retention</dt>
          <dd>{terms.retention}</dd>
        </div>
      </dl>
      <p class="illustrated-shelf__note">{terms.background}</p>
      <div class="illustrated-shelf__actions">
        {active ? (
          <button type="button" class="illustrated-shelf__button" onClick={onClear}>
            Clear illustrated layer
          </button>
        ) : (
          <button
            type="button"
            class="illustrated-shelf__button illustrated-shelf__button--send"
            title={sendTitle}
            disabled={!status.available || !hasSelection || sending}
            onClick={onSend}
          >
            {sending ? 'Sending this still' : 'Send this still'}
          </button>
        )}
      </div>
    </aside>
  );
}
