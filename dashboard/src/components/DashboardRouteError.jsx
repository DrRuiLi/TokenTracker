import React, { useEffect } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { copy } from "../lib/copy";
import { captureDashboardException } from "../lib/sentry.js";

/**
 * React Router catch-all error UI that also reports to Sentry when enabled.
 * createBrowserRouter's default boundary swallows render errors before the
 * global handlers, so we capture here explicitly.
 */
export function DashboardRouteError() {
  const error = useRouteError();

  useEffect(() => {
    if (!error) return;
    const err = isRouteErrorResponse(error)
      ? new Error(`Route error ${error.status}: ${error.statusText || "unknown"}`)
      : error instanceof Error
        ? error
        : new Error(typeof error === "string" ? error : "Unknown route error");
    void captureDashboardException(err, { tags: { surface: "react-router" } });
  }, [error]);

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText || ""}`.trim()
    : error instanceof Error
      ? error.message
      : copy("error.boundary.no_details");

  return (
    <div className="flex min-h-screen items-center justify-center bg-oai-white p-6 font-oai text-oai-black antialiased dark:bg-oai-gray-950 dark:text-oai-white">
      <div className="w-full max-w-lg rounded-xl border border-oai-gray-200 bg-white p-6 text-center shadow-sm dark:border-oai-gray-800 dark:bg-oai-gray-900">
        <h1 className="text-xl font-semibold text-oai-black dark:text-white">
          {copy("error.boundary.title")}
        </h1>
        <p className="mt-2 text-sm text-oai-gray-500 dark:text-oai-gray-400">
          {copy("error.boundary.subtitle")}
        </p>
        <div className="mt-4 max-h-32 overflow-auto rounded-lg border border-oai-gray-200 bg-oai-gray-50 px-3 py-2 text-left text-xs leading-5 text-oai-gray-600 dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:text-oai-gray-300">
          {message}
        </div>
      </div>
    </div>
  );
}
