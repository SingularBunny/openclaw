// Fork (F49): Claude's ExitPlanMode plan as a Markdown card in the transcript. The three
// approval choices are the structured question the CLI runtime opens for the same call.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { Icon } from "../../../components/solid/icon.tsx";
import { MarkdownHtml } from "../../../components/solid/markdown-html.tsx";
import { registerClaudeComposerEnglish } from "../../../i18n/locales/en-claude-composer.ts";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/chat/plan-card.css";

registerClaudeComposerEnglish();

/** The plan of a Claude CLI ExitPlanMode call; other tools render as ordinary cards. */
export function readClaudePlanMarkdown(card: ToolCard): string | undefined {
  if (card.name.trim().toLowerCase() !== "exitplanmode") {
    return undefined;
  }
  const plan = asNullableRecord(card.args)?.plan;
  return typeof plan === "string" && plan.trim() ? plan.trim() : undefined;
}

function planStateKey(outcome: ToolCardOutcome): string | undefined {
  switch (outcome) {
    case "running":
      return "chat.planCard.pending";
    case "succeeded":
      return "chat.planCard.approved";
    case "failed":
    case "blocked":
      return "chat.planCard.rejected";
    default:
      return undefined;
  }
}

export function ClaudePlanCard(props: { markdown: string; outcome: ToolCardOutcome }) {
  const state = () => planStateKey(props.outcome);
  return (
    <div class="chat-plan-card" data-chat-plan-card="true" data-plan-outcome={props.outcome}>
      <div class="chat-plan-card__header">
        <span class="chat-plan-card__icon" aria-hidden="true">
          <Icon name="listChecks" />
        </span>
        <span class="chat-plan-card__title">{t("chat.planCard.title")}</span>
        {state() ? <span class="chat-plan-card__state">{t(state()!)}</span> : undefined}
      </div>
      <MarkdownHtml class="chat-plan-card__body chat-text" markdown={props.markdown} />
    </div>
  );
}
