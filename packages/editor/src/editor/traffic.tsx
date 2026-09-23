import { useState } from "react";
import { Button } from "@applets/ui/components/ui/button";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { TrafficHour } from "@applets/api";
import { call } from "../client.ts";

const hourMs = 3_600_000;

const ranges = {
  "24h": { bars: 24, hours: 1 },
  "7d": { bars: 28, hours: 6 },
} as const;

type Range = keyof typeof ranges;

type Bar = { readonly start: number; readonly total: number; readonly failed: number };

/** The last `bars` spans ending with the current hour, each the sum of the hours inside it. */
function barsFor(hours: ReadonlyArray<TrafficHour>, range: Range, now: number): Bar[] {
  const { bars, hours: span } = ranges[range];
  const size = span * hourMs;
  const end = Math.floor(now / hourMs) * hourMs + hourMs;

  return Array.from({ length: bars }, (_, index) => {
    const start = end - (bars - index) * size;

    const inside = hours.filter((hour) => {
      const at = Date.parse(hour.hour);

      return at >= start && at < start + size;
    });

    return {
      start,
      total: inside.reduce((sum, hour) => sum + hour.total, 0),
      failed: inside.reduce((sum, hour) => sum + hour.failed, 0),
    };
  });
}

const label = (bar: Bar) =>
  `${new Date(bar.start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" })} · ${bar.total} requests, ${bar.failed} failed`;

/** Requests over the last day or week, every version and trigger, failures in red. `latest` changes when a new request arrives, which reloads the counts. */
export function Traffic({ name, latest }: { name: string; latest: number | undefined }) {
  const [range, setRange] = useState<Range>("24h");

  const { data } = useQuery({
    queryKey: ["applet", name, "traffic", latest],
    queryFn: () =>
      call((api) => api.applets.traffic({ params: { name } }), { quiet: true }).then(
        ({ hours }) => ({ hours, at: Date.now() }),
      ),
    placeholderData: keepPreviousData,
  });

  const bars = barsFor(data?.hours ?? [], range, data?.at ?? 0);
  const peak = Math.max(1, ...bars.map((bar) => bar.total));
  const total = bars.reduce((sum, bar) => sum + bar.total, 0);
  const failed = bars.reduce((sum, bar) => sum + bar.failed, 0);

  return (
    <div className="flex flex-col gap-1 border-b border-border px-3 py-2">
      <div className="flex items-center gap-2 font-mono text-xs">
        <span>
          {total} requests · {failed} failed
        </span>
        <span className="ml-auto text-muted-foreground">peak {peak}</span>
        {Object.keys(ranges).map((key) => (
          <Button
            key={key}
            variant={key === range ? "default" : "outline"}
            size="xs"
            onClick={() => setRange(key === "7d" ? "7d" : "24h")}
          >
            {key}
          </Button>
        ))}
      </div>
      <div className="flex h-16 items-end gap-px" role="img" aria-label={`Requests, last ${range}`}>
        {bars.map((bar) => (
          <div
            key={bar.start}
            className="flex h-full min-w-0 flex-1 flex-col justify-end bg-muted/40"
            title={label(bar)}
          >
            <div className="bg-destructive" style={{ height: `${(bar.failed / peak) * 100}%` }} />
            <div
              className="bg-chart-3"
              style={{ height: `${((bar.total - bar.failed) / peak) * 100}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
