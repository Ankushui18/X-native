import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { DialogHost } from "./ui/DialogHost";
import { ThemeProvider } from "./ui/theme";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
      {/* One host for the whole app, above the router: a dialog raised from the
          dashboard (project name) and one raised in the editor (rename) then
          render in the same place and behave the same way. */}
      <DialogHost />
    </ThemeProvider>
  </StrictMode>,
);
