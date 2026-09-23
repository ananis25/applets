/** Five-field cron expressions, minute resolution, UTC, parsed by Effect's `Cron`. */
import { Cron, Result } from "effect";

const fiveFields = (expression: string): boolean => expression.trim().split(/\s+/).length === 5;

/** The first occurrence strictly after `from`, as epoch milliseconds, or undefined when the expression is not valid. */
export function nextRun(expression: string, from: Date): number | undefined {
  if (!fiveFields(expression)) return undefined;

  const cron = Cron.parse(expression, "UTC");

  return Result.isSuccess(cron) ? Cron.next(cron.success, from).getTime() : undefined;
}

export const isCron = (expression: string): boolean =>
  nextRun(expression, new Date()) !== undefined;
