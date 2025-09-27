import { ExtensionSigner } from "applesauce-signers";
import { decode as decodeNip19 } from "nostr-tools/nip19";
import { createSignal, Show, type Component } from "solid-js";

export interface LoginProps {
  /** Function called when login is successful */
  onLogin: (pubkeyHex: string, alias?: string) => void;
}

export const Login: Component<LoginProps> = (props) => {
  const [npubInputValue, setNpubInputValue] = createSignal("");
  const [loginError, setLoginError] = createSignal<string | null>(null);
  const [loginPending, setLoginPending] = createSignal(false);

  const resolvePubkey = (input: string): string => {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("Enter a public key");
    }

    if (/^npub/i.test(trimmed)) {
      const decoded = decodeNip19(trimmed);
      if (decoded.type !== "npub") {
        throw new Error("Unsupported NIP-19 format");
      }
      const data = decoded.data;
      if (typeof data !== "string") {
        throw new Error("Invalid npub payload");
      }
      return data.toLowerCase();
    }

    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return trimmed.toLowerCase();
    }

    throw new Error("Invalid public key");
  };

  const handleManualLogin = (event: Event) => {
    event.preventDefault();
    try {
      const pubkeyHex = resolvePubkey(npubInputValue());
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
