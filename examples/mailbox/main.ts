/** A mailbox: mail to <applet>@<domain> lands in `inbox`, and the page sends mail from the same address. Turn email on in the applet's settings. */
import { email as mailer, log, page, sql, type InboundEmail } from "@std";

import type { Message, Mailbox, Outgoing, SendResult } from "./shared/types.ts";

type Row = Omit<Message, "attachments"> & { attachments: string };

const fields = "direction, messageId, sender, recipient, subject, text, html, attachments, at";

const setup = `CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, direction TEXT NOT NULL, messageId TEXT NOT NULL, sender TEXT NOT NULL,
  recipient TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL, html TEXT,
  attachments TEXT NOT NULL, at TEXT NOT NULL)`;

/** This applet's address: its name at the request host with the applet label removed. */
const address = (request: Request): string => {
  const [name, ...domain] = new URL(request.url).hostname.split(".");

  return `${name}@${domain.join(".")}`;
};

const toMessage = (row: Row): Message => ({ ...row, attachments: JSON.parse(row.attachments) });

function store(message: Omit<Message, "id">): Message {
  const { lastInsertRowid } = sql.execute({
    sql: `INSERT INTO messages (${fields}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      message.direction,
      message.messageId,
      message.sender,
      message.recipient,
      message.subject,
      message.text,
      message.html,
      JSON.stringify(message.attachments),
      message.at,
    ],
  });

  return { ...message, id: lastInsertRowid };
}

const list = (): ReadonlyArray<Message> =>
  sql.execute<Row>(`SELECT id, ${fields} FROM messages ORDER BY id DESC`).rows.map(toMessage);

async function send(request: Request): Promise<Response> {
  const outgoing = await request.json<Outgoing>();

  try {
    const messageId = await mailer.send(outgoing);
    const message = store({
      direction: "out",
      messageId,
      sender: address(request),
      recipient: outgoing.to,
      subject: outgoing.subject,
      text: outgoing.text,
      html: null,
      attachments: [],
      at: new Date().toISOString(),
    });

    return Response.json({ ok: true, message } satisfies SendResult);
  } catch (failure) {
    const error = failure instanceof Error ? failure.message : String(failure);
    log.warn("send refused", { to: outgoing.to, error });

    return Response.json({ ok: false, error } satisfies SendResult, { status: 502 });
  }
}

export function inbox(message: InboundEmail): void {
  sql.execute(setup);
  store({
    direction: "in",
    messageId: message.id,
    sender: message.from,
    recipient: message.to.join(", "),
    subject: message.subject,
    text: message.text ?? "",
    html: message.html,
    attachments: message.attachments,
    at: new Date().toISOString(),
  });
  log.info("received", { from: message.from, subject: message.subject });
}

export async function fetch(request: Request): Promise<Response> {
  sql.execute(setup);

  const { pathname } = new URL(request.url);
  const attachment = pathname.match(/^\/api\/attachments\/([^/]+)\/([^/]+)$/);

  if (attachment !== null) return mailer.attachment(attachment[1]!, attachment[2]!);

  if (pathname === "/api/messages")
    return Response.json({ address: address(request), messages: list() } satisfies Mailbox);

  if (pathname === "/api/send" && request.method === "POST") return send(request);

  return page({ title: "mailbox" });
}
