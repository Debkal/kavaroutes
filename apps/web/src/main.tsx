import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { router } from "./router";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("WEB_ROOT_MISSING");
createRoot(root).render(<StrictMode><RouterProvider router={router} /></StrictMode>);
