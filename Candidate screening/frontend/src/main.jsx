import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App.jsx";
import { ConfirmProvider } from "./components/Confirm.jsx";
import { ToastProvider } from "./components/Toast.jsx";
import "./styles/index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </React.StrictMode>,
);
