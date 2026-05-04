import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

const THEME_KEY = "scheduler-theme";
try {
  const t = localStorage.getItem(THEME_KEY);
  document.documentElement.setAttribute(
    "data-theme",
    t === "light" || t === "dark" ? t : "dark"
  );
} catch {
  document.documentElement.setAttribute("data-theme", "dark");
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
