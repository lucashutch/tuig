import React from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <div className="guig-shell">
        <div className="guig-placeholder">
          Guig scaffold: the application shell lands in the next commit.
        </div>
      </div>
    </React.StrictMode>,
  );
}
