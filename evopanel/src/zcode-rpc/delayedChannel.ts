import { type CancellationToken, Event, Relay } from "./foundation.js";
import type { IChannel } from "./channels.shared.js";

export function getDelayedChannel<T extends IChannel>(promise: Promise<T>): T {
  return {
    call(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<any> {
      return promise.then((channel) => channel.call(command, arg, cancellationToken));
    },
    listen(event: string, arg?: any): Event<any> {
      const relay = new Relay<any>();
      promise.then((channel) => {
        relay.input = channel.listen(event, arg);
      });
      return relay.event;
    },
  } as T;
}
