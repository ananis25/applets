/**
 * Questions that need an answer before something happens: "discard these edits?",
 * "name the new applet". `ask` and `askText` resolve once the user answers, and
 * the `Asker` at the root shows the one question open at a time.
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@applets/ui/components/ui/alert-dialog";
import { Input } from "@applets/ui/components/ui/input";
import { Label } from "@applets/ui/components/ui/label";
import { useState } from "react";
import { create } from "zustand";

type Question = {
  title: string;
  description?: string;
  /** The label on the button that says yes; "Cancel" is always the other. */
  action?: string;
  destructive?: boolean;
  /** With `input`, the answer is text; `match` disables the action until the text equals it. */
  input?: { label: string; initial?: string; match?: string };
};

type Pending = Question & { resolve: (answer: string | null) => void };

const usePending = create<{ pending: Pending | null }>()(() => ({ pending: null }));

const open = (question: Question) =>
  new Promise<string | null>((resolve) => {
    usePending.getState().pending?.resolve(null);
    usePending.setState({ pending: { ...question, resolve } });
  });

/** Whether the user agrees to `question`. */
export const ask = (question: Omit<Question, "input">) =>
  open(question).then((answer) => answer !== null);

/** The text the user gives, or null when they cancel. Whitespace around it is dropped. */
export const askText = (question: Question & { input: NonNullable<Question["input"]> }) =>
  open(question).then((answer) => answer?.trim() ?? null);

export function Asker() {
  const pending = usePending((state) => state.pending);

  if (pending === null) return null;

  return <Question key={pending.title} pending={pending} />;
}

function Question({ pending }: { pending: Pending }) {
  const [text, setText] = useState(pending.input?.initial ?? "");
  const blocked = pending.input?.match !== undefined && text.trim() !== pending.input.match;

  const answer = (value: string | null) => {
    pending.resolve(value);
    usePending.setState({ pending: null });
  };

  return (
    <AlertDialog open onOpenChange={(stillOpen) => !stillOpen && answer(null)}>
      <AlertDialogContent>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();

            if (!blocked) answer(pending.input ? text : "");
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{pending.title}</AlertDialogTitle>
            {pending.description && (
              <AlertDialogDescription>{pending.description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          {pending.input && (
            <Label className="flex-col items-start gap-1 text-xs">
              {pending.input.label}
              <Input
                autoFocus
                className="font-mono text-xs"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </Label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="submit"
              disabled={blocked}
              variant={pending.destructive ? "destructive" : "default"}
            >
              {pending.action ?? "OK"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
