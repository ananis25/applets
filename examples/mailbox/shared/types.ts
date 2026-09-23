/** The wire shapes between the mailbox page and its /api routes. */
export type Attachment = {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
};

export type Message = {
  readonly id: number;
  readonly direction: "in" | "out";
  readonly messageId: string;
  readonly sender: string;
  readonly recipient: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string | null;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly at: string;
};

export type Mailbox = { readonly address: string; readonly messages: ReadonlyArray<Message> };

export type Outgoing = { readonly to: string; readonly subject: string; readonly text: string };

export type SendResult =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly error: string };
