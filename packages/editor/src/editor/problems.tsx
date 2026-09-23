import { Button } from "@applets/ui/components/ui/button";
import { clearProblems, useStore } from "../store.ts";

/** The bundler's errors and warnings from the last deploy, under the code until dismissed. */
export function Problems() {
  const problems = useStore((state) => state.problems);

  if (problems.length === 0) return null;

  return (
    <section className="flex max-h-48 shrink-0 flex-col border-t border-border bg-background">
      <div className="flex items-center justify-between px-3 py-1 text-xs font-semibold uppercase tracking-wide">
        Problems
        <Button variant="outline" size="xs" onClick={clearProblems}>
          clear
        </Button>
      </div>
      <div className="min-h-0 overflow-auto py-1 font-mono text-xs">
        {problems.map((problem, index) => (
          <div
            key={index}
            className={`flex gap-2 px-3 ${problem.kind === "error" ? "text-destructive" : "text-amber-700"}`}
          >
            <span className="w-14 shrink-0">{problem.kind}</span>
            <span className="whitespace-pre-wrap">{problem.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
