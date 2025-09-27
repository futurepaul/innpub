import type { IAccount } from "applesauce-accounts";
import { ExtensionAccount, NostrConnectAccount, ReadonlyAccount } from "applesauce-accounts/accounts";
import { getDisplayName, normalizeToPubkey } from "applesauce-core/helpers";
import { NostrConnectSigner, ReadonlySigner } from "applesauce-signers";
import { npubEncode } from "nostr-tools/nip19";
import { createMemo, createSignal, For, from, Show, type Component } from "solid-js";
import { manager } from "../nostr/accounts";
import { eventStore } from "../nostr/client";

interface AccountItemProps {
  account: IAccount;
  onSelect: (account: IAccount) => void;
  onRemove: (account: IAccount) => void;
}

// Simple QR code component using external service
const QRCode: Component<{ data: string }> = (props) => (
  <div class="qr-code-container">
    <img
      src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(props.data)}`}
      alt="QR Code"
      class="qr-code-image"
    />
  </div>
);

// NIP-07 Extension Login Button Component
const ExtensionLoginButton: Component = () => {
  const [isConnecting, setIsConnecting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Check if NIP-07 extension is available
  const hasNostrExtension = () => typeof window !== 'undefined' && 'nostr' in window;

  const handleExtensionLogin = async () => {
    setIsConnecting(true);
    setError(null);
    try {
      // Create ExtensionAccount using the static fromExtension method
      const account = await ExtensionAccount.fromExtension();

      // Check if account already exists
      let existingAccount = manager.getAccountForPubkey(account.pubkey);

      if (!existingAccount) {
        // Add new account
        manager.addAccount(account);
        existingAccount = account;
      }

      // Set as active account - this will trigger the login view to disappear
      manager.setActive(existingAccount);

      setError(null);
    } catch (error) {
      console.error("Extension login failed", error);
      setError("Failed to login with NIP-07 extension");
    } finally {
      setIsConnecting(false);
    }
  };

  // Don't render if no extension available
  if (!hasNostrExtension()) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        class="ext-login"
        onClick={handleExtensionLogin}
        disabled={isConnecting()}
      >
        {isConnecting() ? "Connecting…" : "Login with NIP-07"}
      </button>
      <Show when={error()}>
        <div class="login-error">{error()}</div>
      </Show>
    </>
  );
};

// Bunker URL login component
const BunkerUrlLogin: Component = () => {
  const [bunkerUrl, setBunkerUrl] = createSignal("");
  const [isConnecting, setIsConnecting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const handleConnect = async () => {
    if (!bunkerUrl()) return;

    try {
      setIsConnecting(true);
      setError(null);

      // Create signer from bunker URL
      const signer = await NostrConnectSigner.fromBunkerURI(bunkerUrl());

      // Create the account
      const pubkey = await signer.getPublicKey();
      const account = new NostrConnectAccount(pubkey, signer);
      manager.addAccount(account);

      // Set as active account
      manager.setActive(account);
    } catch (err) {
      console.error("Connection error:", err);
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div class="bunker-login-section">
      <h3>Login with Bunker URL</h3>
      <div class="bunker-url-form">
        <input
          type="text"
          placeholder="Enter bunker:// URL"
          value={bunkerUrl()}
          onInput={(e) => setBunkerUrl(e.currentTarget.value)}
          spellcheck={false}
          autocomplete="off"
          autocorrect="off"
        />
        <button
          type="button"
          onClick={handleConnect}
          disabled={!bunkerUrl() || isConnecting()}
        >
          {isConnecting() ? "Connecting..." : "Connect"}
        </button>
      </div>
      <Show when={error()}>
        <div class="login-error">{error()}</div>
      </Show>
    </div>
  );
};

// QR code login component
const QRCodeLogin = () => {
  // Create a new signer for QR code login
  const signer = new NostrConnectSigner({
    relays: ["wss://relay.nsec.app"],
  });

  // Generate QR code URI with metadata
  const uri = signer.getNostrConnectURI({
    name: "INNPUB",
  });

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 1 minute timeout

  // Wait for signer to connect
  signer.waitForSigner(controller.signal).then(async () => {
    clearTimeout(timeoutId);

    // Create the account
    const pubkey = await signer.getPublicKey();
    const account = new NostrConnectAccount(pubkey, signer);
    manager.addAccount(account);

    // Set as active account
    manager.setActive(account);
  });

  return (
    <div class="qr-code-section">
      <p class="qr-instruction">Scan this QR code with your Nostr mobile signer</p>
      <a href={uri} target="_blank" rel="noopener noreferrer">
        <QRCode data={uri} />
      </a>
    </div>
  );
};

// Bunker signer view component
const BunkerSignerView: Component<{ onBack: () => void }> = (props) => {
  return (
    <>
      <h1>Nostr Login</h1>
      <p class="login-description">
        Scan a QR code with your mobile signer or connect using a Nostr bunker URL.
      </p>

      <QRCodeLogin />
      <div class="login-divider">or</div>
      <BunkerUrlLogin />
      <button type="button" class="back-btn" onClick={props.onBack}>
        ← Back
      </button>
    </>
  );
};

const PubkeyLogin: Component = () => {
  const [input, setInput] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  const handleInputChange = (event: Event) => {
    const target = event.currentTarget as HTMLInputElement;
    setInput(target.value);
  };

  const handleSubmit = (event: Event) => {
    event.preventDefault();

    try {
      const pubkeyHex = normalizeToPubkey(input());

      // Check if account already exists
      let account = manager.getAccountForPubkey(pubkeyHex);

      if (!account) {
        // Create new ReadonlyAccount
        const signer = new ReadonlySigner(pubkeyHex);
        account = new ReadonlyAccount(pubkeyHex, signer);
        manager.addAccount(account);
      }

      // Set as active account - this will trigger the login view to disappear
      manager.setActive(account);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to parse public key");
    }
  };

  return (
    <form class="login-form" onSubmit={handleSubmit}>
      <input
        type="text"
        value={input()}
        onInput={handleInputChange}
        placeholder="Paste your npub or hex public key"
        spellcheck={false}
        autocomplete="off"
        autocorrect="off"
      />
      <button type="submit">
        Continue
      </button>
      <Show when={error()}>
        <div class="login-error">{error()}</div>
      </Show>
    </form>
  );
};

const AccountItem: Component<{account: IAccount}> = (props) => {
  const profile = from(eventStore.profile(props.account.pubkey));

  const avatarUrl = createMemo(() => {
    const p = profile();
    return p?.picture || `https://robohash.org/${props.account.pubkey}.png`;
  });

  const handleRemove = (e: Event) => {
    e.stopPropagation();
    manager.removeAccount(props.account);
  };

  return (
    <div class="account-item">
      <button
        type="button"
        class="account-select-btn"
        onClick={() => manager.setActive(props.account)}
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

// Main login view component
const MainLoginView: Component<{onShowBunkerView: () => void}> = (props) => {
  const accounts = from(manager.accounts$);

  return (
    <>
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
                <AccountItem account={account} />
              )}
            </For>
          </div>
        </div>
        <div class="login-divider">or</div>
      </Show>

      <PubkeyLogin />
      <ExtensionLoginButton />

      <button
        type="button"
        class="bunker-login"
        onClick={props.onShowBunkerView}
      >
        Login with Nostr Bunker
      </button>
    </>
  );
};

export const Login: Component = () => {
  const [showBunkerView, setShowBunkerView] = createSignal(false);

  const handleShowBunkerView = () => {
    setShowBunkerView(true);
  };

  const cancelBunker = () => {
    setShowBunkerView(false);
  };

  return (
    <div class="login-overlay">
      <div class="login-modal">
        <Show when={showBunkerView()} fallback={
          <MainLoginView onShowBunkerView={handleShowBunkerView}/>
        }>
          <BunkerSignerView
            onBack={cancelBunker}
          />
        </Show>
      </div>
    </div>
  );
};
