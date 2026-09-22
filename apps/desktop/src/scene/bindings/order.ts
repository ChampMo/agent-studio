/**
 * The order a team is listed in, wherever it is listed (§2.1).
 *
 * Three surfaces show the same five people — the room seats them, the compact
 * roster lists them, the rail lists them again — and they had two different
 * answers between them. The rail read the snapshot straight through, which is
 * seat order; the compact roster put the leader first. On a real team whose
 * leader sits in seat 4 that is two lists of the same team in two orders, with
 * nothing on screen to say why.
 *
 * **Leader first, then by seat.** The leader is the one member the
 * orchestrator never assigns a task to, so who it is changes how the run
 * behaves — and the room says so by seating them at the head of the table. A
 * list has no head, so the thing that carries the same fact is being first.
 * Seat order for the rest, so the list does not reshuffle itself as statuses
 * change.
 *
 * Note what this is *not*: a rank. Nobody is ordered by what they spent or how
 * much they did. Those are comparisons the panel would be inventing (§1.1).
 */
export interface Seated {
  seat_index: number;
  role_in_team?: string;
}

export function bySeat<T extends Seated>(members: readonly T[]): T[] {
  return [...members].sort(
    (a, b) =>
      Number(b.role_in_team === "leader") - Number(a.role_in_team === "leader") ||
      a.seat_index - b.seat_index,
  );
}
