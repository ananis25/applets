import { createRoot } from "react-dom/client";
import { Launcher } from "./app.tsx";
import "../styles.css";

document.documentElement.classList.toggle(
  "dark",
  matchMedia("(prefers-color-scheme: dark)").matches,
);

createRoot(document.getElementById("root")!).render(<Launcher />);
