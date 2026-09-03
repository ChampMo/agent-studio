/**
 * The right panel's width, and the one bug it keeps having.
 *
 * `AppShell` shipped reading the width through `usePanelStore((s) => s.widthOf)`
 * — a resolver on the store. Dragging the divider recorded the new number and
 * the panel did not move, because a zustand action's identity never changes and
 * a component subscribed to one is subscribed to nothing. That is the third
 * time in this codebase (the timeline's `nameOf`, the transcript's `roster`,
 * this), so the shape is now a plain selector over the data and the test below
 * is the one that fails if a resolver comes back.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  MAX_WIDTH,
  MIN_WIDTH,
  selectPanelWidth,
  usePanelStore,
} from "./panelStore";

const fresh = () => usePanelStore.setState({ mode: "run", widths: {} });

describe("panel width", () => {
  beforeEach(fresh);

  it("gives the terminal more room than the run summary by default", () => {
    const run = selectPanelWidth(usePanelStore.getState());
    usePanelStore.getState().open("terminal");
    const terminal = selectPanelWidth(usePanelStore.getState());
    expect(terminal).toBeGreaterThan(run);
  });

  it("is zero when the panel is closed", () => {
    usePanelStore.getState().close();
    expect(selectPanelWidth(usePanelStore.getState())).toBe(0);
  });

  it("changes when a drag records a new width", () => {
    const before = selectPanelWidth(usePanelStore.getState());
    usePanelStore.getState().setWidth("run", before + 120);
    expect(selectPanelWidth(usePanelStore.getState())).toBe(before + 120);
  });

  it("remembers a width per panel, so switching does not carry one over", () => {
    usePanelStore.getState().setWidth("run", 300);
    usePanelStore.getState().setWidth("terminal", 700);
    expect(selectPanelWidth(usePanelStore.getState())).toBe(300);
    usePanelStore.getState().open("terminal");
    expect(selectPanelWidth(usePanelStore.getState())).toBe(700);
  });

  it("clamps and rounds, so a drag off the edge cannot hide the panel", () => {
    usePanelStore.getState().setWidth("run", -500);
    expect(selectPanelWidth(usePanelStore.getState())).toBe(MIN_WIDTH);
    usePanelStore.getState().setWidth("run", 99_999);
    expect(selectPanelWidth(usePanelStore.getState())).toBe(MAX_WIDTH);
    usePanelStore.getState().setWidth("run", 401.6);
    expect(selectPanelWidth(usePanelStore.getState())).toBe(402);
  });

  it("toggles the lit panel closed and a different one open", () => {
    usePanelStore.getState().toggle("run");
    expect(usePanelStore.getState().mode).toBeNull();
    usePanelStore.getState().toggle("terminal");
    expect(usePanelStore.getState().mode).toBe("terminal");
    usePanelStore.getState().toggle("run");
    expect(usePanelStore.getState().mode).toBe("run");
  });
});
