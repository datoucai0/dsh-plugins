/**
 * dsh-message-preview — host half.
 *
 * Registers the `messageIndex` session projection unit: a complete, durable
 * enumeration of the session's USER-sent messages (the navigation rail only
 * needs user turns; assistant replies would double the block count and crowd
 * the rail). Independent of the client's loaded history window.
 *
 * Each entry carries: seq (ordering), time, a short preview text, and the
 * durable message id used to reconstruct the chat node's
 * `data-chat-anchor-key` for jumping.
 *
 * Compaction deliberately does NOT drop user messages: dsh renders a
 * compaction marker row at the checkpoint position but keeps the transcript
 * above it intact, so every user-sent message stays visible in the
 * conversation view — and on the rail.
 */
import z from "@deepseek-ai/schemastery";
import { z as zz } from "zod";

const name = "message-preview";
const PROJECTION_KEY = "dshMessagePreview";

/** Cap preview text so projection payloads stay small enough to deliver
 * reliably through the mux frames and list blocks (80 chars ≈ 1-2 preview
 * lines; the rail never needs the full message body). */
const MAX_TEXT_CHARS = 80;

/** Join the text blocks of a ContentBlock list (host-side message content). */
function textOf(content) {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out.trim().slice(0, MAX_TEXT_CHARS);
}

const MessageSchema = zz.object({
  seq: zz.number().int(),
  time: zz.number().int(),
  text: zz.string(),
  id: zz.string().optional()
});

const MessageIndexSchema = zz.object({
  messages: zz.array(MessageSchema)
}).strict();

const messageIndexProjectionDefinition = {
  key: PROJECTION_KEY,
  schema: MessageIndexSchema,
  init: () => ({ messages: [] }),
  apply: (state, event) => {
    // Only DIRECT user-sent messages shape the navigation rail. Plugin- and
    // tool-injected context rides the same `user/message` event type with a
    // different `source.kind` (job completions, tool notices, cron
    // notifications, agent.inject context...) — those are context rows in the
    // conversation, not turns the user sent, so they are excluded here exactly
    // as the chat view's node assembler classifies them.
    if (event.type === "user/message") {
      const data = event.data;
      if (data.source === null || typeof data.source !== "object" || data.source.kind !== "user") return state;
      const text = textOf(data.content);
      const entry = {
        seq: event.seq,
        time: event.time,
        text,
        ...(typeof data.id === "string" ? { id: data.id } : {})
      };
      return { messages: [...state.messages, entry] };
    }
    // Compaction does not remove user messages (see header note): dsh keeps
    // the transcript above the checkpoint intact, so the rail keeps them too.
    return state;
  },
  view: (state) => state,
  stateVersion: 4
};

const Config = z.object({});

function apply(ctx) {
  ctx.inject(["sessionProjections"], (projectionCtx) => {
    projectionCtx.sessionProjections.register(messageIndexProjectionDefinition);
  });
}

export { Config, apply, name };
