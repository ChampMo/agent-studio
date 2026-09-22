/**
 * Which drawing a tool is (`props.ts`), and which tools have none.
 */
import { describe, expect, it } from "vitest";

import { propFor } from "./props";

describe("which drawing a tool is", () => {
  it("groups the tools that mean one thing under one drawing", () => {
    for (const tool of ["read_file", "glob", "grep", "list_dir"]) {
      expect(propFor(tool)).toBe("computer");
    }
    for (const tool of ["write_file", "edit_file"]) expect(propFor(tool)).toBe("papers");
    for (const tool of ["web_search", "web_fetch"]) expect(propFor(tool)).toBe("dish");
    for (const tool of ["remember", "recall"]) expect(propFor(tool)).toBe("files");
    expect(propFor("bash")).toBe("toolbox");
    expect(propFor("ask_user")).toBe("phone");
  });

  it("draws nothing for send_message, which everyone has", () => {
    expect(propFor("send_message")).toBeNull();
  });

  it("draws nothing for a tool this build has never heard of, rather than a guess", () => {
    expect(propFor("teleport")).toBeNull();
  });

  it("draws nothing for no tool", () => {
    expect(propFor(null)).toBeNull();
    expect(propFor(undefined)).toBeNull();
    expect(propFor("")).toBeNull();
  });
});
