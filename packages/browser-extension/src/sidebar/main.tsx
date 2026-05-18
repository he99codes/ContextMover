/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import Sidebar from "./Sidebar";
import AuthGate from "./AuthGate";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate>{() => <Sidebar />}</AuthGate>
  </React.StrictMode>
);
