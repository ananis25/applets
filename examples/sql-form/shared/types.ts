/** What the page and the API exchange. */
export type Submission = {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly message: string;
  readonly created_at: string;
};

export type NewSubmission = Pick<Submission, "name" | "email" | "message">;
