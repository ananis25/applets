/**
 * Email: the `Email` capability a loaded applet receives, and the `email`
 * handler that forwards received mail to the applet it is addressed to. Only
 * the router holds the `send_email` binding; applets reach it over RPC.
 */
import type {
  Attachment,
  Email as EmailCapability,
  InboundEmail,
  OutboundEmail,
} from "@applets/api/capabilities";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Option } from "effect";
import PostalMime, { type Address } from "postal-mime";

import { Bucket, Mailer, Supervisors, Vars } from "./bindings.ts";
import { log } from "./platformLog.ts";
import { Registry } from "./registry.ts";
import { run } from "./runtime.ts";
import { targetOf, type AppletProps } from "./types.ts";

/** The domain applets receive at and send from: the host suffix without its leading dot. */
export const emailDomain = (suffix: string): string => suffix.replace(/^\./, "");

/** Where a received message's attachments live in the blobs bucket, by applet id. `_` keeps the prefix clear of every applet's own keys. */
export const attachmentPrefix = (id: string): string => `_email/${id}/`;

/** One message out as `<applet>@<domain>`, recorded whether Cloudflare took it or not. */
const send = (applet: AppletProps, message: OutboundEmail) =>
  Effect.gen(function* () {
    const { HOST_SUFFIX } = yield* Vars;
    const mailer = yield* Mailer;
    const registry = yield* Registry;
    const from = `${applet.name}@${emailDomain(HOST_SUFFIX)}`;

    const record = (status: "sent" | "failed", message_id: string | null, detail: string | null) =>
      registry.writeEmail({
        direction: "out",
        applet_id: applet.id,
        message_id,
        sender: from,
        recipient: [message.to].flat().join(", "),
        subject: message.subject,
        status,
        detail,
      });

    return yield* mailer.send(from, message).pipe(
      Effect.tap((id) => record("sent", id, null)),
      Effect.tapError((failed) =>
        Effect.all([
          record("failed", null, failed.message),
          log.warn("mail send failed", {
            applet: applet.name,
            to: message.to,
            reason: failed.message,
          }),
        ]),
      ),
    );
  });

/** What `@std`'s `email` calls from inside an applet. */
export class Email
  extends WorkerEntrypoint<Cloudflare.Env, AppletProps>
  implements EmailCapability
{
  /** Sends one message; the id comes back, or the reason Cloudflare refused it. */
  send(message: OutboundEmail): Promise<string> {
    return run(this.env, this.ctx, send(this.ctx.props, message));
  }

  /** The bytes of one attachment of a message this applet received. */
  attachment(emailId: string, attachmentId: string): Promise<Attachment> {
    const key = `${attachmentPrefix(this.ctx.props.id)}${emailId}/${attachmentId}`;

    return run(
      this.env,
      this.ctx,
      Effect.gen(function* () {
        const bucket = yield* Bucket;
        const object = yield* bucket.get(key);

        if (object === null) throw new Error(`no attachment ${attachmentId} on email ${emailId}`);

        return {
          body: yield* Effect.promise(() => object.arrayBuffer()),
          contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
        };
      }),
    );
  }
}

const mailboxes = (addresses: ReadonlyArray<Address> = []): Array<string> =>
  addresses
    .flatMap((address) => address.group ?? [address])
    .map((mailbox) =>
      mailbox.name === "" ? mailbox.address : `${mailbox.name} <${mailbox.address}>`,
    );

/**
 * The `email` handler. Parses the message, records it, and hands it to the
 * `inbox` of the applet named by the local part of the envelope recipient, when
 * that applet's email setting is on. Attachments go to the blobs bucket first,
 * so the handler can fetch them. Delivery is at most once: a failure is recorded, not retried.
 */
export const handleInbound = Effect.fn("Email.inbound")(function* (
  envelope: ForwardableEmailMessage,
) {
  const { HOST_SUFFIX } = yield* Vars;
  const registry = yield* Registry;
  const bucket = yield* Bucket;
  const supervisors = yield* Supervisors;

  const parsed = yield* Effect.promise(() => PostalMime.parse(envelope.raw));
  const id = crypto.randomUUID();
  const from = mailboxes(parsed.from && [parsed.from])[0] ?? envelope.from;
  const subject = parsed.subject ?? "";
  const [local = "", host] = envelope.to.toLowerCase().split("@");

  const applet =
    host === emailDomain(HOST_SUFFIX) ? Option.getOrNull(yield* registry.getApplet(local)) : null;

  const record = (status: "delivered" | "failed" | "unclaimed", detail: string | null) =>
    registry.writeEmail({
      direction: "in",
      applet_id: applet?.id ?? null,
      message_id: id,
      sender: from,
      recipient: envelope.to,
      subject,
      status,
      detail,
    });

  const target = applet === null ? undefined : targetOf(applet);

  if (applet === null || target === undefined || applet.email === 0) {
    yield* log.info("mail unclaimed", { applet: applet?.name, to: envelope.to, from });

    return yield* record("unclaimed", null);
  }

  const stored = yield* Effect.forEach(parsed.attachments, (attachment, index) =>
    bucket.put(
      `${attachmentPrefix(applet.id)}${id}/${index}`,
      attachment.content,
      attachment.mimeType,
    ),
  );

  const message: InboundEmail = {
    id,
    from,
    to: mailboxes(parsed.to),
    cc: mailboxes(parsed.cc),
    subject,
    text: parsed.text ?? null,
    html: parsed.html ?? null,
    headers: Object.fromEntries(parsed.headers.map((header) => [header.key, header.value])),
    attachments: parsed.attachments.map((attachment, index) => ({
      id: String(index),
      filename: attachment.filename ?? "",
      contentType: attachment.mimeType,
      size: stored[index]?.size ?? 0,
    })),
  };

  yield* supervisors.deliver(target, message).pipe(
    Effect.matchEffect({
      onSuccess: () => record("delivered", null),
      onFailure: (failed) =>
        Effect.all([
          log.warn("mail delivery failed", { applet: applet.name, from, reason: failed.message }),
          record("failed", failed.message.slice(0, 500)),
        ]),
    }),
  );
});

/** Drops attachments older than a week, the same window the `emails` rows keep. One page a run is enough on a 10-minute cron. */
export const vacuumAttachments = Effect.gen(function* () {
  const bucket = yield* Bucket;
  const cutoff = Date.now() - 7 * 24 * 3_600_000;
  const page = yield* bucket.list({ prefix: "_email/" });
  const stale = page.objects.filter((object) => object.uploaded.getTime() < cutoff);

  if (stale.length > 0) yield* bucket.delete(stale.map((object) => object.key));
});
