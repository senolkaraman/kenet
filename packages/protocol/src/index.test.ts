import { describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "./index.js";

describe("Kenet protocol", () => {
  it("models an explicit connection request", () => {
    const request: ClientMessage = {
      type: "signal",
      to: "ABC123",
      payload: { type: "connection-request", requestId: "request-1", requesterName: "Windows-123" }
    };

    expect(request.payload.type).toBe("connection-request");
  });

  it("models an unavailable peer error", () => {
    const response: ServerMessage = {
      type: "error",
      code: "PEER_UNAVAILABLE",
      message: "Target device is offline."
    };

    expect(response.code).toBe("PEER_UNAVAILABLE");
  });

  it("models a device coming online", () => {
    const hello: ClientMessage = { type: "hello", token: "jwt", name: "Ofis-PC" };
    expect(hello.type).toBe("hello");
  });
});
