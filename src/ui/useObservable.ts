import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { Observable } from "rxjs";

export interface ObservableSignalOptions {
  onError?: (error: unknown) => void;
}

export function createObservableSignal<T>(
  observable: Observable<T>,
  initial: T,
  options: ObservableSignalOptions = {},
): Accessor<T> {
  const [value, setValue] = createSignal(initial);
  const subscription = observable.subscribe({
    next: nextValue => setValue(() => nextValue),
    error: error => {
      if (options.onError) {
        options.onError(error);
      } else {
        console.error("observable subscription error", error);
      }
    },
  });

  onCleanup(() => subscription.unsubscribe());

  return value;
}

