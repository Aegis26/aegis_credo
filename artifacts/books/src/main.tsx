import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// The generated API client already prefixes every request with /api (from the
// OpenAPI `servers.url`), and the API server is mounted at /api behind the
// shared proxy on the same origin — so session cookies are sent automatically
// and no base URL override is needed here.

createRoot(document.getElementById("root")!).render(<App />);
