import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { newQueryClient } from "./queries.ts";
import { newRouter } from "./router.tsx";

/** One query cache and one router per page. */
export function App() {
  const [client] = useState(newQueryClient);
  const [router] = useState(() => newRouter(client));

  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
