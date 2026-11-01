import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { InsforgeAuthProvider } from "./contexts/InsforgeAuthContext.jsx";
import { AccountViewProvider } from "./contexts/AccountViewContext.jsx";
import { LocaleProvider } from "./ui/foundation/LocaleProvider.jsx";
import { CurrencyProvider } from "./ui/foundation/CurrencyProvider.jsx";
import { TokenFormatProvider } from "./ui/foundation/TokenFormatProvider.jsx";
import App from "./App.jsx";
import { initAnalytics } from "./lib/analytics.js";
import { initSentry } from "./lib/sentry.js";
import { DashboardRouteError } from "./components/DashboardRouteError.jsx";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/700.css";
import "@fontsource/geist-mono/900.css";
import "./styles.css";

initSentry();
initAnalytics();

// Use createElement so two adjacent JSX tags do not trip the rawText hardcode
// scanner (/> ... < between siblings looks like JSX text).
const router = createBrowserRouter([
  {
    path: "*",
    element: React.createElement(App),
    errorElement: React.createElement(DashboardRouteError),
  },
]);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LocaleProvider>
      <TokenFormatProvider>
        <CurrencyProvider>
          <InsforgeAuthProvider>
            <AccountViewProvider>
              <RouterProvider router={router} />
            </AccountViewProvider>
          </InsforgeAuthProvider>
        </CurrencyProvider>
      </TokenFormatProvider>
    </LocaleProvider>
  </React.StrictMode>,
);
