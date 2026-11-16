/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { formatReplyAuthor } from "../chat-handoff-registry.ts";
import { ReplyAuthorBadge } from "./chat-message-timestamp-view.tsx";

afterEach(() => {
  document.body.replaceChildren();
});

describe("reply author badge", () => {
  it("names the ACP agent or the model that wrote a reply", () => {
    expect(formatReplyAuthor("acp", "junie")).toBe("Junie");
    expect(formatReplyAuthor("openrouter", "x/y:free")).toBe("y:free");
    expect(formatReplyAuthor("openclaw", "gateway-injected")).toBeUndefined();
    const container = document.body.appendChild(document.createElement("div"));
    mountSolid(
      () => (
        <ReplyAuthorBadge
          meta={{
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            model: "junie",
            provider: "acp",
            contextPercent: null,
          }}
        />
      ),
      { container },
    );
    flush();
    const badge = container.querySelector("[data-chat-reply-author]");
    expect(badge?.textContent).toBe("Junie");
    expect(badge?.getAttribute("title")).toBe("Written by Junie");
  });
});
