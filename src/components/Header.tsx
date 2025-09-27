import { getDisplayName } from "applesauce-core/helpers";
import { createMemo, Show, type Component, from } from "solid-js";
import { npubEncode } from "nostr-tools/nip19";
import {
  getAudioState,
  getProfilePictureUrl,
  setMicrophoneEnabled,
  setSpeakerEnabled,
  type AudioControlState,
  type PlayerProfile
} from "../multiplayer/stream";
import { manager } from "../nostr/accounts";
import { eventStore } from "../nostr/client";

export interface HeaderProps {
  profileMap: Map<string, PlayerProfile>;
  audioState: AudioControlState;
  onLogout: () => void;
}

export const Header: Component<HeaderProps> = (props) => {
  const activeAccount = from(manager.active$);

  const pubkey = createMemo(() => activeAccount()?.pubkey || null);
  const npub = createMemo(() => {
    const pk = pubkey();
    return pk ? npubEncode(pk) : null;
  });

  const profile = createMemo(() => {
    const pk = pubkey();
    if (!pk) return null;
    const profileEvent = eventStore.profile(pk);
    return from(profileEvent)();
  });

  const handleToggleMic = async () => {
    if (!props.audioState.supported) {
      return;
    }
    try {
      await setMicrophoneEnabled(!props.audioState.micEnabled);
    } catch (error) {
      console.error("Failed to toggle microphone", error);
    }
  };

  const handleToggleSpeaker = () => {
    setSpeakerEnabled(!props.audioState.speakerEnabled);
  };

  const displayName = createMemo(() => {
    const p = profile();
    if (p) {
      return getDisplayName(p);
    }
    const currentNpub = npub();
    if (currentNpub) {
      return `${currentNpub.slice(0, 12)}…`;
    }
    return null;
  });

  const avatarUrl = createMemo(() => {
    const p = profile();
    const pk = pubkey();
    if (p?.picture) {
      return p.picture;
    }
    if (pk) {
      return getProfilePictureUrl(pk) ?? `https://robohash.org/${pk}.png`;
    }
    return null;
  });

  return (
    <header class="status-bar">
      <Show
        when={pubkey()}
        fallback={
          <div class="status-strip status-strip--placeholder">Sign in to explore the InnPub.</div>
        }
      >
        <div class="status-strip">
          <div class="status-strip__identity">
            <Show
              when={avatarUrl()}
              fallback={<div class="status-strip__avatar status-strip__avatar--placeholder" />}
            >
              <img class="status-strip__avatar" src={avatarUrl()!} alt="Avatar" />
            </Show>
            <div class="status-strip__meta">
              <span class="status-strip__label">Logged in</span>
              <span class="status-strip__name" title={npub() ?? undefined}>
                {displayName() ?? (npub() ? `${npub()!.slice(0, 12)}…` : "Guest")}
              </span>
            </div>
          </div>
          <div class="status-strip__controls">
            <button
              type="button"
              class={`status-strip__btn${props.audioState.micEnabled ? " is-on" : ""}`}
              onClick={handleToggleMic}
              disabled={!props.audioState.supported}
            >
              {props.audioState.micEnabled ? "Mic On" : "Mic Off"}
            </button>
            <button
              type="button"
              class={`status-strip__btn${props.audioState.speakerEnabled ? " is-on" : ""}`}
              onClick={handleToggleSpeaker}
            >
              {props.audioState.speakerEnabled ? "Speaker On" : "Speaker Off"}
            </button>
            <button type="button" class="status-strip__btn status-strip__btn--ghost" onClick={props.onLogout}>
              Logout
            </button>
          </div>
          <Show when={props.audioState.micError}>
            <div class="status-error">{props.audioState.micError}</div>
          </Show>
        </div>
      </Show>
    </header>
  );
};
