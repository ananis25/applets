/** A multi-turn chat: the browser keeps the history and POSTs it to /api/chat, which streams the reply back as text. */
import { ai, log, page } from "@std";

import type { ChatRequest } from "./shared/chat.ts";

const system =
  "You are a concise assistant. Answer in markdown; use fenced code blocks with a language for code.";

async function* reply(request: ChatRequest): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = ai.stream({
    messages: [{ role: "system", content: system }, ...request.messages],
  });

  for await (const chunk of chunks) yield encoder.encode(chunk.choices[0]?.delta.content ?? "");
}

export async function fetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname !== "/api/chat" || request.method !== "POST") return page({ title: "chat" });

  const body = await request.json<ChatRequest>();
  log.info("turn", { messages: body.messages.length });

  return new Response(ReadableStream.from(reply(body)), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
