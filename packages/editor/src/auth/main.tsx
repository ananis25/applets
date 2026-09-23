import { createRoot } from "react-dom/client";
import { Auth } from "./app.tsx";
import "../styles.css";

createRoot(document.getElementById("root")!).render(<Auth />);
