import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// The API server is mounted at /api behind the shared proxy (same origin as
// this app), so session cookies are sent automatically on every request.
setBaseUrl("/api");

createRoot(document.getElementById("root")!).render(<App />);
