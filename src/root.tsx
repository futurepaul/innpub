import { Switch, Route } from "wouter";
import { App } from "./App";
import { AudioLab } from "./audio/AudioLab";

export function Root() {
  return (
    <Switch>
      <Route path="/audio-lab">
        <AudioLab />
      </Route>
      <Route>
        <App />
      </Route>
    </Switch>
  );
}
