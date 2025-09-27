import { AccountManager } from "applesauce-accounts";
import { registerCommonAccountTypes } from "applesauce-accounts/accounts";
import { NostrConnectSigner } from "applesauce-signers";
import { pool } from "./client";

// create an account manager instance
const manager = new AccountManager();

// register common account types
registerCommonAccountTypes(manager);

// Setup nostr connect signer with pool
NostrConnectSigner.pool = pool

// first load all accounts from localStorage
try {
  const json = JSON.parse(localStorage.getItem("accounts") || "[]");
  await manager.fromJSON(json);
}
catch (error) {
  console.error("Error loading accounts from localStorage", error);
}

// next, subscribe to any accounts added or removed
manager.accounts$.subscribe(() => {
  // save all the accounts into the "accounts" field
  localStorage.setItem("accounts", JSON.stringify(manager.toJSON()));
});

// load active account from storage
try {
  const active = localStorage.getItem("active");
  if (active) manager.setActive(active);
} catch (error) {
  console.error("Error loading active account from localStorage", error);
}

// subscribe to active changes
manager.active$.subscribe((account) => {
  if (account) localStorage.setItem("active", account.id);
  else localStorage.setItem("active", "");
});

// Export the manager instance
export { manager };
