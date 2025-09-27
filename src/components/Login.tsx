import { ReadonlyAccount } from "applesauce-accounts/accounts";
import { getDisplayName, normalizeToPubkey } from "applesauce-core/helpers";
import { ExtensionSigner, ReadonlySigner } from "applesauce-signers";
import { npubEncode } from "nostr-tools/nip19";
import { createMemo, createSignal, For, from, Show, type Component } from "solid-js";
import { manager } from "../nostr/accounts";
import { eventStore } from "../nostr/client";

interface AccountItemProps {
  account: any;
  onSelect: (account: any) => void;
  onRemove: (account: any) => void;
}

const AccountItem: Component<AccountItemProps> = (props) => {
  const profile = from(eventStore.profile(props.account.pubkey));

  const avatarUrl = createMemo(() => {
    const p = profile();
    return p?.picture || `https://robohash.org/${props.account.pubkey}.png`;
  });

  const handleRemove = (e: Event) => {
    e.stopPropagation();
    props.onRemove(props.account);
  };

  return (
    <div class="account-item">
      <button
        type="button"
        class="account-select-btn"
        onClick={() => props.onSelect(props.account)}
      >
        <div class="account-avatar">
          <img src={avatarUrl()} alt={getDisplayName(profile())} />
        </div>
        <div class="account-info">
          <div class="account-name">{getDisplayName(profile())}</div>
          <div class="account-pubkey">{npubEncode(props.account.pubkey).slice(0, 12)}…</div>
        </div>
      </button>
      <button
        type="button"
        class="account-remove-btn"
        onClick={handleRemove}
        title="Remove account"
      >
        ×
      </button>
    </div>
  );
};

export interface LoginProps {
  /** Function called when login is successful */
  onLogin: (pubkeyHex: string, alias?: string) => void;
}

export const Login: Component<LoginProps> = (props) => {
  const [npubInputValue, setNpubInputValue] = createSignal("");
  const [loginError, setLoginError] = createSignal<string | null>(null);
  const [loginPending, setLoginPending] = createSignal(false);
  const accounts = from(manager.accounts$)

  const resolvePubkey = (input: string): string => {
    const trimmed = input.trim();
    if (!trimmed)
      throw new Error("Enter a public key");

    return normalizeToPubkey(trimmed)
  };

  const handleAccountSelect = (account: any) => {
    manager.setActive(account);
    props.onLogin(account.pubkey);
  };

  const handleAccountRemove = (account: any) => {
    manager.removeAccount(account);
  };

  const handleManualLogin = async (event: Event) => {
    event.preventDefault();
    try {
      const pubkeyHex = resolvePubkey(npubInputValue());

      // Check if account already exists
      let account = manager.getAccountForPubkey(pubkeyHex);

      if (!account) {
        // Create new ReadonlyAccount
        const signer = new ReadonlySigner(pubkeyHex);
        account = new ReadonlyAccount(pubkeyHex, signer);
        manager.addAccount(account);
      }

      // Set as active account
      manager.setActive(account);
      props.onLogin(pubkeyHex);

      // Reset form state on successful login
      setNpubInputValue("");
      setLoginError(null);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Failed to parse public key");
    }
  };

  const handleExtensionLogin = async () => {
    setLoginPending(true);
    setLoginError(null);
    try {
      const signer = new ExtensionSigner();
      const pubkeyHex = await signer.getPublicKey();
      props.onLogin(pubkeyHex);
      // Reset form state on successful login
      setNpubInputValue("");
      setLoginError(null);
    } catch (error) {
      console.error("Extension login failed", error);
      setLoginError("Failed to login with NIP-07 extension");
    } finally {
      setLoginPending(false);
    }
  };

  const handleInputChange = (event: Event) => {
    const target = event.currentTarget as HTMLInputElement;
    setNpubInputValue(target.value);
    setLoginError(null);
  };

  return (
    <div class="login-overlay">
      <div class="login-modal">
        <h1>INNPUB</h1>
        <p class="login-description">
          Realtime audio and position over WebTransport. Enter a room to join that room's audio channel.
          Chrome required for audio to work.
        </p>

        <Show when={(accounts() || []).length > 0}>
          <div class="existing-accounts">
            <h3>Existing Accounts</h3>
            <div class="account-list">
              <For each={accounts() || []}>
                {(account) => (
                  <AccountItem
                    account={account}
                    onSelect={handleAccountSelect}
                    onRemove={handleAccountRemove}
                  />
                )}
              </For>
            </div>
          </div>
          <div class="login-divider">or</div>
        </Show>

        <form class="login-form" onSubmit={handleManualLogin}>
          <input
            type="text"
            value={npubInputValue()}
            onInput={handleInputChange}
            placeholder="Paste your npub or hex public key"
            spellcheck={false}
            autocomplete="off"
            autocorrect="off"
          />
          <button type="submit" disabled={loginPending()}>
            Continue
          </button>
        </form>
        <button
          type="button"
          class="ext-login"
          onClick={handleExtensionLogin}
          disabled={loginPending()}
        >
          {loginPending() ? "Connecting…" : "Login with NIP-07"}
        </button>
        <Show when={loginError()}>
          <div class="login-error">{loginError()}</div>
        </Show>
      </div>
    </div>
  );
};
