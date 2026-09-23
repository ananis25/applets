/** The chat page: the history lives here, and each turn streams from /api/chat into the last message. */
import { marked } from "npm:marked@^15";
import { render } from "npm:preact";
import { useEffect, useRef, useState } from "npm:preact/hooks";

import type { ChatMessage, ChatRequest } from "../shared/chat.ts";
import { styles } from "./styles.ts";

const storageKey = "chat-history";

const suggestions = [
  "Explain what a Durable Object is in three sentences",
  "Write a SQL query that finds duplicate emails in a users table",
  "Give me a haiku about a slow build",
];

/** The reply as it streams: the text so far and the handle that stops it. */
type Reply = { readonly text: string; readonly controller: AbortController };

const loadHistory = (): ChatMessage[] => JSON.parse(localStorage.getItem(storageKey) ?? "[]");

/** POSTs the history and feeds every chunk of the reply to `onText`; resolves with the whole reply. */
async function streamReply(
  messages: ReadonlyArray<ChatMessage>,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<string> {
  const body: ChatRequest = { messages };
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) throw new Error(`the server answered ${response.status}`);

  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";

  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    text += part.value;
    onText(text);
  }

  return text;
}

const Markdown = ({ text }: { text: string }) => (
  <div dangerouslySetInnerHTML={{ __html: marked.parse(text, { async: false }) }} />
);

const Typing = () => (
  <span class="typing" aria-label="waiting for the answer">
    <i />
    <i />
    <i />
  </span>
);

function Composer({
  busy,
  onSend,
  onStop,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!busy) area.current?.focus();
  }, [busy]);

  const submit = (event: Event) => {
    event.preventDefault();

    if (busy || draft.trim() === "") return;

    onSend(draft.trim());
    setDraft("");
    area.current!.style.height = "auto";
  };

  const grow = (event: Event) => {
    const element = event.currentTarget as HTMLTextAreaElement;
    setDraft(element.value);
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  };

  const keyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) submit(event);
  };

  return (
    <div class="composer">
      <form onSubmit={submit}>
        <textarea
          ref={area}
          rows={1}
          value={draft}
          placeholder="Ask anything"
          disabled={busy}
          onInput={grow}
          onKeyDown={keyDown}
        />
        {busy ? (
          <button type="button" class="stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" class="primary" disabled={draft.trim() === ""}>
            Send
          </button>
        )}
      </form>
      <p class="hint">Enter sends, Shift+Enter starts a new line</p>
    </div>
  );
}

function App() {
  const [history, setHistory] = useState<ChatMessage[]>(loadHistory);
  const [reply, setReply] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const thread = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    thread.current!.scrollTop = thread.current!.scrollHeight;
  }, [history, reply]);

  const send = async (text: string) => {
    const messages = [...history, { role: "user", content: text } as const];
    const controller = new AbortController();
    let partial = "";

    setHistory(messages);
    setError(null);
    setReply({ text: "", controller });

    try {
      partial = await streamReply(messages, controller.signal, (streamed) => {
        partial = streamed;
        setReply({ text: streamed, controller });
      });
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    }

    if (partial !== "") setHistory([...messages, { role: "assistant", content: partial }]);
    setReply(null);
  };

  const clear = () => {
    reply?.controller.abort();
    setHistory([]);
    setError(null);
  };

  return (
    <>
      <header>
        <h1>chat</h1>
        <button type="button" onClick={clear} disabled={history.length === 0 && reply === null}>
          New chat
        </button>
      </header>
      <div class="thread" ref={thread}>
        <div class="thread-inner">
          {history.length === 0 && reply === null && (
            <div class="empty">
              <p>Ask a question, or start from one of these.</p>
              <div class="suggestions">
                {suggestions.map((suggestion) => (
                  <button type="button" key={suggestion} onClick={() => void send(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}
          {history.map((message, index) => (
            <div class={`message ${message.role}`} key={index}>
              <div class="bubble">
                {message.role === "assistant" ? (
                  <Markdown text={message.content} />
                ) : (
                  message.content
                )}
              </div>
            </div>
          ))}
          {reply !== null && (
            <div class="message assistant">
              <div class="bubble">
                {reply.text === "" ? <Typing /> : <Markdown text={reply.text} />}
                {reply.text !== "" && <span class="cursor" />}
              </div>
            </div>
          )}
          {error !== null && (
            <div class="message assistant error">
              <div class="bubble">Something went wrong: {error}</div>
            </div>
          )}
        </div>
      </div>
      <Composer
        busy={reply !== null}
        onSend={(text) => void send(text)}
        onStop={() => reply?.controller.abort()}
      />
    </>
  );
}

document.head.appendChild(Object.assign(document.createElement("style"), { textContent: styles }));
render(<App />, document.getElementById("app")!);
