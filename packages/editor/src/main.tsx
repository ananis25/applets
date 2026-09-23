import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./styles.css";

// A deploy replaces every chunk; a page open across one reloads for the current build instead of going blank.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  location.reload();
});

createRoot(document.getElementById("root")!).render(<App />);
