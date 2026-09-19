import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import PluginComponent from "./main";

createRoot(document.querySelector("#root") as HTMLDivElement).render(
  <StrictMode>
    <PluginComponent />
  </StrictMode>,
);
