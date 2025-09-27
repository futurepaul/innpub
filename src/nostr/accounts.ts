import { AccountManager } from "applesauce-accounts";
import { registerCommonAccountTypes } from "applesauce-accounts/accounts";
import { eventStore } from "./client";
import { getProfileContent } from "applesauce-core/helpers";

// create an account manager instance
const manager = new AccountManager();

// register common account types
registerCommonAccountTypes(manager);

// first load all accounts from localStorage
try {
  const json = JSON.parse(localStorage.getItem("accounts") || "[]");
  await manager.fromJSON(json);
}
catch {}

// next, subscribe to any accounts added or removed
manager.accounts$.subscribe(() => {
  // save all the accounts into the "accounts" field
  localStorage.setItem("accounts", JSON.stringify(manager.toJSON()));
});

// load active account from storage
try {
  const active = localStorage.getItem("active");
  if (active) manager.setActive(active);
} catch {}

// subscribe to active changes
manager.active$.subscribe((account) => {
  if (account) localStorage.setItem("active", account.id);
  else localStorage.clearItem("active");
});

// Update account metadata when profiles load
eventStore.filters({kinds: [0]}).subscribe((event) => {
  const account = manager.getAccountForPubkey(event.pubkey);
  if(!account) return

  // Update accounts metadata and save it to localStorage
  manager.setAccountMetadata(account, getProfileContent(event))
})

// Export the manager instance
export { manager };
