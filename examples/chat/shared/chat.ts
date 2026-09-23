/** The wire shape of a turn: the browser sends the whole history, the server streams the reply. */
export type Role = "user" | "assistant";

export type ChatMessage = { readonly role: Role; readonly content: string };

export type ChatRequest = { readonly messages: ReadonlyArray<ChatMessage> };
