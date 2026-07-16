import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { App } from "./app";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Patchdesk renderer root is missing");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
