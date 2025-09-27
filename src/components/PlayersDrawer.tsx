import { getDisplayName, getProfilePicture } from "applesauce-core/helpers";
import { npubEncode } from "nostr-tools/nip19";
import { For, from, Show, type Component } from "solid-js";
import type { RemotePlayerState } from "../game/state";
import { eventStore } from "../nostr/client";

export interface PlayersDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  players: RemotePlayerState[];
  currentPlayerNpub: string | null;
}

const PlayerItem: Component<{pubkey: string, speaking?: boolean}> = (props) => {
	const profile = from(eventStore.profile(props.pubkey));

  return (
    <div class={`player-item${props.speaking ? ' player-item--speaking' : ''}`}>
      <a class="player-item__avatar" href={`nostr:${npubEncode(props.pubkey)}`} target="_blank">
        <img src={getProfilePicture(profile(), `https://robohash.org/${props.pubkey}.png`)} />
        <Show when={props.speaking}>
          <div class="player-item__speaking-indicator" />
        </Show>
      </a>
      <div class="player-item__info">
        <a class="player-item__name" href={`nostr:${npubEncode(props.pubkey)}`} target="_blank">
          {getDisplayName(profile())}
        </a>
        <div class="player-item__npub" title={npubEncode(props.pubkey)}>
          {npubEncode(props.pubkey).slice(0, 16)}…
        </div>
      </div>
    </div>
  );
};

export const PlayersDrawer: Component<PlayersDrawerProps> = (props) => {
  return (
    <Show when={props.isOpen}>
      <div class="players-drawer-overlay" onClick={props.onClose}>
        <div class="players-drawer" onClick={(e) => e.stopPropagation()}>
          <div class="players-drawer__header">
            <h3 class="players-drawer__title">Players ({props.players.length+1})</h3>
            <button
              type="button"
              class="players-drawer__close"
              onClick={props.onClose}
              aria-label="Close players drawer"
            >
              ×
            </button>
          </div>
          <div class="players-drawer__content">
						<Show when={props.currentPlayerNpub}>
							<PlayerItem
								pubkey={props.currentPlayerNpub!}
								speaking={false}
							/>
						</Show>
            <For each={props.players}>
              {(player) => (
                <PlayerItem
                  pubkey={player.npub}
                  speaking={player.speakingLevel > 0.02}
                />
              )}
            </For>
            <Show when={props.players.length === 0}>
              <div class="players-drawer__empty">
                No players in the game
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};
