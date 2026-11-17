/** Fork: the identity-menu Pause chats / Resume chats control (maintenance mode). */
export type GatewayMaintenanceControl = {
  readonly active: boolean;
  readonly toggle: () => void;
};

/** Whether a refused request was refused because chats are paused for maintenance. */
export function isGatewayMaintenanceRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("details" in error)) {
    return false;
  }
  const details = (error as { details?: unknown }).details;
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { reason?: unknown }).reason === "gateway-maintenance"
  );
}
