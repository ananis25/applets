import { Alert, AlertAction, AlertDescription, AlertTitle } from "@applets/ui/components/ui/alert";
import { Button } from "@applets/ui/components/ui/button";
import { AlertCircleIcon } from "lucide-react";

/** What went wrong, where the page's content would be. Nothing shows without an error. */
export function Failure({
  error,
  title = "That didn't work",
  retry,
  className,
}: {
  error: Error | string | null | undefined;
  title?: string;
  /** Offers to try again, for a query that can refetch. */
  retry?: () => void;
  className?: string;
}) {
  if (!error) return null;

  return (
    <Alert variant="destructive" role="alert" className={className}>
      <AlertCircleIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="whitespace-pre-wrap break-words font-mono text-xs">
        {error instanceof Error ? error.message : error}
      </AlertDescription>
      {retry && (
        <AlertAction>
          <Button variant="outline" size="xs" onClick={retry}>
            retry
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
