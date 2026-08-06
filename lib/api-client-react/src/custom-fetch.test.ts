/**
 * Error-body surfacing: the API sends `{ error: string }` bodies, customFetch
 * throws `ApiError` with that body on `.data`, and `getApiErrorMessage` is the
 * one sanctioned way for UI handlers to surface it. Guards against the
 * axios-shaped `.response.data.error` regression that silently swallowed every
 * server message behind a generic toast.
 */
import { describe, it, expect } from "vitest";
import { ApiError, getApiErrorMessage } from "./custom-fetch";

function makeApiError(body: unknown, status = 400): ApiError {
  const response = new Response(JSON.stringify(body), {
    status,
    statusText: "Bad Request",
  });
  return new ApiError(response, body, { method: "POST", url: "/api/test" });
}

describe("getApiErrorMessage", () => {
  it("surfaces the server's { error } body from ApiError.data", () => {
    const err = makeApiError({ error: "This PDF is password-protected." });
    expect(getApiErrorMessage(err, "fallback")).toBe(
      "This PDF is password-protected.",
    );
  });

  it("does NOT find the message at the axios-style e.response.data path", () => {
    // Regression guard: `.response` on ApiError is a raw fetch Response — the
    // old UI code read `.response.data.error` and always got the fallback.
    const err = makeApiError({ error: "specific message" });
    const axiosShaped = (
      err as unknown as { response?: { data?: { error?: string } } }
    ).response?.data?.error;
    expect(axiosShaped).toBeUndefined();
    expect(getApiErrorMessage(err, "fallback")).toBe("specific message");
  });

  it("falls back for empty, missing, or non-string error fields", () => {
    expect(getApiErrorMessage(makeApiError({ error: "" }), "fb")).toBe("fb");
    expect(getApiErrorMessage(makeApiError({ error: "   " }), "fb")).toBe("fb");
    expect(getApiErrorMessage(makeApiError({ message: "x" }), "fb")).toBe("fb");
    expect(getApiErrorMessage(makeApiError(null), "fb")).toBe("fb");
    expect(getApiErrorMessage(new Error("boom"), "fb")).toBe("fb");
    expect(getApiErrorMessage(undefined, "fb")).toBe("fb");
    expect(getApiErrorMessage(makeApiError({ error: 42 }), "fb")).toBe("fb");
  });
});
