/** The mailbox page: an inbox and a sent list from /api/messages, one message open beside them, and a compose form. */
import { render } from "npm:preact";
import { useEffect, useState } from "npm:preact/hooks";

import type { Mailbox, Message, Outgoing, SendResult } from "../shared/types.ts";
import { styles } from "./styles.ts";

type Tab = "in" | "out";

/** What the right pane shows: nothing, one message, or the compose form. */
type Pane = { kind: "none" } | { kind: "message"; id: number } | { kind: "compose" };

const refreshEvery = 30_000;

const loadMailbox = (): Promise<Mailbox> =>
  fetch("/api/messages").then((response) => response.json());

/** "just now", "5m ago", "3h ago", "2d ago", or the date once it is older than a week. */
function relative(at: string): string {
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / (60 * 24))}d ago`;

  return new Date(at).toLocaleDateString();
}

const size = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;

function Row({
  message,
  selected,
  onOpen,
}: {
  message: Message;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button type="button" class={`row${selected ? " selected" : ""}`} onClick={onOpen}>
      <div class="line">
        <span class="who">{message.direction === "in" ? message.sender : message.recipient}</span>
        <span class="when">{relative(message.at)}</span>
      </div>
      <div class="subject">{message.subject || "(no subject)"}</div>
      <div class="preview">{message.text.slice(0, 120)}</div>
    </button>
  );
}

function Detail({ message }: { message: Message }) {
  return (
    <article class="message">
      <h2>{message.subject || "(no subject)"}</h2>
      <dl class="meta">
        <dt>From</dt>
        <dd>{message.sender}</dd>
        <dt>To</dt>
        <dd>{message.recipient}</dd>
        <dt>Date</dt>
        <dd>{new Date(message.at).toLocaleString()}</dd>
      </dl>
      {message.text === "" && message.html !== null ? (
        <iframe class="body" sandbox="" srcdoc={message.html} title="message" />
      ) : (
        <div class="body">{message.text}</div>
      )}
      {message.attachments.length > 0 && (
        <div class="attachments">
          {message.attachments.map((attachment) => (
            <a
              key={attachment.id}
              href={`/api/attachments/${message.messageId}/${attachment.id}`}
              download={attachment.filename}
            >
              {attachment.filename} <span>{size(attachment.size)}</span>
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

function Compose({ onSent }: { onSent: (message: Message) => void }) {
  const [draft, setDraft] = useState<Outgoing>({ to: "", subject: "", text: "" });
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "sending" } | { kind: "failed"; error: string }
  >({ kind: "idle" });

  const field = (name: keyof Outgoing) => (event: Event) =>
    setDraft({ ...draft, [name]: (event.currentTarget as HTMLInputElement).value });

  const submit = async (event: Event) => {
    event.preventDefault();
    setState({ kind: "sending" });

    const response = await fetch("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    const result: SendResult = await response.json();

    if (!result.ok) return setState({ kind: "failed", error: result.error });

    onSent(result.message);
  };

  return (
    <form class="compose" onSubmit={(event) => void submit(event)}>
      <h2>New message</h2>
      <input type="email" placeholder="To" value={draft.to} onInput={field("to")} required />
      <input placeholder="Subject" value={draft.subject} onInput={field("subject")} required />
      <textarea
        placeholder="Write your message"
        value={draft.text}
        onInput={field("text")}
        required
      />
      <div class="actions">
        <button type="submit" class="primary" disabled={state.kind === "sending"}>
          {state.kind === "sending" ? "Sending…" : "Send"}
        </button>
        {state.kind === "failed" && <span class="status error">Not sent: {state.error}</span>}
      </div>
    </form>
  );
}

function App() {
  const [mailbox, setMailbox] = useState<Mailbox | null>(null);
  const [tab, setTab] = useState<Tab>("in");
  const [pane, setPane] = useState<Pane>({ kind: "none" });
  const [copied, setCopied] = useState(false);

  const refresh = () => void loadMailbox().then(setMailbox);

  useEffect(() => {
    refresh();
    const timer = setInterval(
      () => document.visibilityState === "visible" && refresh(),
      refreshEvery,
    );

    return () => clearInterval(timer);
  }, []);

  if (mailbox === null) return <div class="empty">Loading…</div>;

  const shown = mailbox.messages.filter((message) => message.direction === tab);
  const open =
    pane.kind === "message"
      ? mailbox.messages.find((message) => message.id === pane.id)
      : undefined;

  const copy = () => {
    void navigator.clipboard.writeText(mailbox.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const sent = (message: Message) => {
    setMailbox({ ...mailbox, messages: [message, ...mailbox.messages] });
    setTab("out");
    setPane({ kind: "message", id: message.id });
  };

  const showTab = (next: Tab) => {
    setTab(next);
    setPane({ kind: "none" });
  };

  return (
    <>
      <header>
        <h1>mailbox</h1>
        <span class="address">
          {mailbox.address}
          <button type="button" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
        <span class="grow" />
        <button type="button" onClick={refresh}>
          Refresh
        </button>
        <button type="button" class="primary" onClick={() => setPane({ kind: "compose" })}>
          Compose
        </button>
      </header>
      <nav class="tabs">
        <button type="button" class={tab === "in" ? "active" : ""} onClick={() => showTab("in")}>
          Inbox
          <span class="count">
            {mailbox.messages.filter((message) => message.direction === "in").length}
          </span>
        </button>
        <button type="button" class={tab === "out" ? "active" : ""} onClick={() => showTab("out")}>
          Sent
          <span class="count">
            {mailbox.messages.filter((message) => message.direction === "out").length}
          </span>
        </button>
      </nav>
      <div class={`panes${pane.kind === "none" ? "" : " showing-detail"}`}>
        <div class="list">
          {shown.length === 0 && (
            <div class="empty">
              {tab === "in"
                ? `Nothing yet. Mail ${mailbox.address} and it shows up here.`
                : "Nothing sent yet."}
            </div>
          )}
          {shown.map((message) => (
            <Row
              key={message.id}
              message={message}
              selected={open?.id === message.id}
              onOpen={() => setPane({ kind: "message", id: message.id })}
            />
          ))}
        </div>
        <div class="detail">
          <button type="button" class="back" onClick={() => setPane({ kind: "none" })}>
            ← Back
          </button>
          {pane.kind === "compose" && <Compose onSent={sent} />}
          {open !== undefined && <Detail message={open} />}
          {pane.kind === "none" && <div class="empty">Select a message to read it.</div>}
        </div>
      </div>
    </>
  );
}

document.head.appendChild(Object.assign(document.createElement("style"), { textContent: styles }));
render(<App />, document.getElementById("app")!);
