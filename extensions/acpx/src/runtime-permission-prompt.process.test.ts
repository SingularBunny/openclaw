import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { fixtureSession, runPrompt, withProcessRuntime } from "./runtime-process.test-support.js";

const peer = fileURLToPath(
  new URL("../../../test/fixtures/acp/approval-effect-agent.mjs", import.meta.url),
);

it.each([
  ["allow", "allow"],
  ["deny", "deny"],
] as const)(
  "answers a real acpx permission request from the chat question (%s)",
  (picked, expected) =>
    withProcessRuntime(
      `acpx-permission-prompt-${picked}`,
      async ({ state, runtime, directory }) => {
        const cwd = state.path("classic");
        await fs.mkdir(cwd);
        const handle = await runtime.ensureSession({
          ...fixtureSession("classic"),
          agentId: "main",
          cwd,
        });
        const onPermissionPrompt = vi.fn(async () => ({
          outcome: "selected" as const,
          optionId: picked,
        }));
        const turn = await runPrompt(runtime, {
          handle,
          text: "write",
          mode: "prompt",
          requestId: `turn-${picked}`,
          onPermissionPrompt,
        });
        expect(turn.result.status).toBe("completed");
        expect(onPermissionPrompt).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Write the approved native effect",
            toolKind: "edit",
            options: [
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          }),
          expect.anything(),
        );
        const result = JSON.parse(
          await fs.readFile(path.join(directory, "permission-result.json"), "utf8"),
        );
        expect(result.outcome).toMatchObject({ outcome: "selected", optionId: expected });
        // The agent delegates the approved write back to the client; acpx must not re-deny it.
        const effect = fs.readFile(path.join(cwd, "native-effect.txt"), "utf8");
        await (picked === "allow"
          ? expect(effect).resolves.toBe("approved native effect")
          : expect(effect).rejects.toMatchObject({ code: "ENOENT" }));
      },
      {
        script: peer,
        permissionMode: "approve-reads",
        nonInteractivePermissions: "deny",
        openclawPermissionPrompts: { permissionMode: "approve-reads" },
      },
    ),
);

it("denies instead of failing the turn when no chat can be asked", () =>
  withProcessRuntime(
    "acpx-permission-prompt-no-chat",
    async ({ state, runtime, directory }) => {
      const cwd = state.path("classic");
      await fs.mkdir(cwd);
      const handle = await runtime.ensureSession({
        ...fixtureSession("classic"),
        agentId: "main",
        cwd,
      });
      const turn = await runPrompt(runtime, {
        handle,
        text: "write",
        mode: "prompt",
        requestId: "turn-no-chat",
      });
      expect(turn.result.status).toBe("completed");
      const result = JSON.parse(
        await fs.readFile(path.join(directory, "permission-result.json"), "utf8"),
      );
      expect(result.outcome).toMatchObject({ outcome: "selected", optionId: "deny" });
    },
    {
      script: peer,
      permissionMode: "approve-reads",
      nonInteractivePermissions: "deny",
      openclawPermissionPrompts: { permissionMode: "approve-reads" },
    },
  ));
