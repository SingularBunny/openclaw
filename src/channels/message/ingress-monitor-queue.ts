import { formatErrorMessage } from "../../infra/errors.js";
import { ChannelIngressUnavailableError } from "./ingress-unavailable.js";

/** Opens the monitor's queue, reporting a failure as the ingress being unavailable. */
export function assertIngressQueueAvailable(getQueue: () => unknown): void {
  try {
    getQueue();
  } catch (error) {
    throw new ChannelIngressUnavailableError(
      `Channel ingress queue is unavailable: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}
