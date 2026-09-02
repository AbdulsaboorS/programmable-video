import { createRoot } from "react-dom/client";

import "./composition.css";
import { installRenderBridge } from "./render-bridge";
import "./render.css";

const rootElement = document.getElementById("render-root");
if (!rootElement) throw new Error("Render root is missing");

installRenderBridge(createRoot(rootElement));
