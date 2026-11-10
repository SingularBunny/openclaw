import { Type } from "typebox";
import { Value } from "typebox/value";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { stopCliLiveSessionTask } from "../../agents/cli-runner/cli-live-session-registry.js";
import { resolveRequestedSessionStoreTarget } from "../session-store-key.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Fork (F47): `sessions.cliTasks.stop { sessionKey, agentId?, taskId }` stops one
 * background agent or task of the session's live Claude CLI process through the CLI's
 * `stop_task` control request. `{ requested: false }` means no live process of the
 * session knows the task (it ended, or the CLI runs elsewhere). The CLI reports the
 * stop as `task_notification` status "stopped", which reaches the chat as usual.
 */
const SessionsCliTasksStopParamsSchema = Type.Object(
  {
    sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
    agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    taskId: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export type SessionsCliTasksStopResult = { requested: boolean };

export function createSessionCliTaskHandlers(
  stopTask: typeof stopCliLiveSessionTask = stopCliLiveSessionTask,
): GatewayRequestHandlers {
  return {
    "sessions.cliTasks.stop": async ({
      params,
      respond,
      context,
      sessionMutationAuthorization,
    }) => {
      if (!Value.Check(SessionsCliTasksStopParamsSchema, params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "sessions.cliTasks.stop expects { sessionKey, agentId?, taskId }",
          ),
        );
        return;
      }
      const requested = resolveRequestedSessionStoreTarget(
        context.getRuntimeConfig(),
        params.sessionKey,
        params.agentId,
      );
      if (!requested.ok) {
        respond(false, undefined, requested.error);
        return;
      }
      sessionMutationAuthorization?.assertCurrent();
      const sessionKeys = [...new Set([params.sessionKey, requested.value.sessionKey])];
      try {
        const result: SessionsCliTasksStopResult = {
          requested: await stopTask(
            { agentId: requested.value.agentId, sessionKeys },
            params.taskId,
          ),
        };
        respond(true, result);
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            error instanceof Error ? error.message : "Claude CLI did not take the stop request.",
          ),
        );
      }
    },
  };
}

export const sessionCliTaskHandlers = createSessionCliTaskHandlers();
