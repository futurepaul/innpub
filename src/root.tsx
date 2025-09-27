import { Switch, Route } from "wouter";
import { App } from "./App";

export function Root() {
  return (
    <Switch>
      <Route>
        <App />
      </Route>
    </Switch>
  );
}
