import { createRoot } from "react-dom/client";
import { installRenderBridge } from "./render-bridge";
import "./render.css";

const rootElement = document.getElementById("render-root");

if (!rootElement) {
  throw new Error("Render root element is missing");
}

installRenderBridge(createRoot(rootElement));
