import { getDisplayName, getProfilePicture } from "applesauce-core/helpers";
import { createMemo, from, Show, type Component } from "solid-js";

import { setMicEnabled, setSpeakerEnabled } from "../game/service";
import type { AudioState, PlayerProfileEntry } from "../game/state";
import { eventStore } from "../nostr/client";
import { manager } from "../nostr/accounts";
import { of } from "rxjs";

export interface HeaderProps {
  pubkey: string | null;
  npub: string | null;
  localAlias: string | null;
  profileMap: ReadonlyMap<string, PlayerProfileEntry>;
  audioState: AudioState;
  onLogout: () => void;
  onTogglePlayersDrawer: () => void;
}

export const Header: Component<HeaderProps> = (props) => {
  const handleToggleMic = async () => {
    if (!props.audioState.supported) {
      return;
    }
    try {
      await setMicEnabled(!props.audioState.micEnabled);
    } catch (error) {
      console.error("Failed to toggle microphone", error);
    }
  };

  const handleToggleSpeaker = () => {
    setSpeakerEnabled(!props.audioState.speakerEnabled);
  };

  const profile$ = createMemo(() => props.pubkey ? eventStore.profile(props.pubkey) : of(undefined));
  const profile = from(profile$());

  const avatarUrl = createMemo(() => getProfilePicture(profile(), `https://robohash.org/${props.pubkey}.png`));

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
              <img class="status-strip__avatar" src={avatarUrl()} alt="Avatar" />
            </Show>
            <div class="status-strip__meta">
              <span class="status-strip__label">Logged in</span>
              <span class="status-strip__name" title={props.npub ?? undefined}>
                {getDisplayName(profile(), props.npub ? `${props.npub.slice(0, 12)}…` : "Guest")}
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
            <button type="button" class="status-strip__btn" onClick={props.onTogglePlayersDrawer}>
              Players
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

