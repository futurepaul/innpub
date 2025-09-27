import { getDisplayName } from "applesauce-core/helpers";
import { createMemo, Show, type Component } from "solid-js";
import {
  getAudioState,
  getProfilePictureUrl,
  setMicrophoneEnabled,
  setSpeakerEnabled,
  type AudioControlState,
  type PlayerProfile
} from "../multiplayer/stream";

export interface HeaderProps {
  pubkey: string | null;
  npub: string | null;
  localAlias: string | null;
  profileMap: Map<string, PlayerProfile>;
  audioState: AudioControlState;
  onLogout: () => void;
}

export const Header: Component<HeaderProps> = (props) => {
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

  const localProfile = createMemo(() => {
    const pk = props.pubkey;
    return pk ? props.profileMap.get(pk)?.profile : undefined;
  });

  const displayName = createMemo(() => {
    if (props.localAlias)
      return props.localAlias;

    const profile = localProfile();
    const name = profile ? getDisplayName(profile) : null;
    if (name) {
      return name;
    }
    const currentNpub = props.npub;
    if (currentNpub) {
      return `${currentNpub.slice(0, 12)}…`;
    }
    return null;
  });

  const avatarUrl = createMemo(() => {
    const pk = props.pubkey;
    if (!pk) {
      return null;
    }
    return getProfilePictureUrl(pk) ?? null;
  });

  return (
    <header class="status-bar">
      <Show
        when={props.pubkey}
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
              <span class="status-strip__name" title={props.npub ?? undefined}>
                {displayName() ?? (props.npub ? `${props.npub.slice(0, 12)}…` : "Guest")}
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
