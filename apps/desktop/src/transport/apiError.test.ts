/**
 * A structured error must not become the string "[object Object]".
 *
 * FastAPI's `detail` is often an object: `{message, problems}` when a team
 * cannot run, `{message, names}` when `@Name` matches two teammates. The
 * client put that object straight into `Error.message`, so the composer
 * printed one bullet reading `[object Object]` under *This team cannot run* —
 * and every reason the backend listed, deliberately and in full, was gone.
 */
import { describe, expect, it } from "vitest";

import { ApiError, detailMessage } from "./rest";

describe("turning a detail into a sentence", () => {
  it("never produces [object Object]", () => {
    const detail = { message: "this team cannot run", problems: ["no leader"] };
    expect(detailMessage(detail, "Conflict")).toBe("this team cannot run");
    expect(detailMessage(detail, "Conflict")).not.toContain("[object");
  });

  it("keeps a plain string detail as it is", () => {
    expect(detailMessage("a chat needs a provider_id", "Bad Request")).toBe(
      "a chat needs a provider_id",
    );
  });

  it("falls back to the status text when there is no detail", () => {
    expect(detailMessage(null, "Not Found")).toBe("Not Found");
    expect(detailMessage(undefined, "Not Found")).toBe("Not Found");
    expect(detailMessage("", "Not Found")).toBe("Not Found");
  });

  it("shows the json rather than nothing for an object with no message", () => {
    // Ugly, and at least it is the information the backend sent.
    expect(detailMessage({ names: ["Dev", "Designer"] }, "Conflict")).toBe(
      '{"names":["Dev","Designer"]}',
    );
  });
});

describe("what the error carries", () => {
  it("keeps the body so a caller can read its list", () => {
    const detail = {
      message: "this team cannot run",
      problems: ["no leader", "nobody carries write_file"],
    };
    const err = new ApiError(409, detailMessage(detail, "Conflict"), { detail });
    // The message is a sentence and the structure survives beside it, which is
    // what lets the composer list every finding instead of one bullet.
    expect(err.message).toBe("this team cannot run");
    expect((err.detail as { problems: string[] }).problems).toHaveLength(2);
  });
});
