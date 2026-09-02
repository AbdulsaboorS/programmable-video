import "@cloudflare/kumo/styles/standalone";
import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./app.css";

const root = document.getElementById("root");

document.documentElement.dataset.mode = "light";

if (!root) {
  throw new Error("Studio root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
