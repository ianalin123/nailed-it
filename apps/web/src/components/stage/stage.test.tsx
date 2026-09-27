import { act, render, screen, within } from "@testing-library/react";
import type { ClientMessage, RoomState } from "@nailed-it/protocol";
import { makePlayer, makeRound, makeState } from "@/test/fixtures";
import type { RoomTransport, TransportListener } from "@/lib/room/transport";
import type { OpenTransport } from "@/lib/room/useRoom";
import { StageScreen } from "./StageScreen";

const SECRET = "tok-must-not-show";

const mountStage = (state: RoomState | undefined, extra: object[] = []) => {
  const sent: ClientMessage[] = [];
  let listener: TransportListener | undefined;
  const transport: RoomTransport = {
    send: (message) => {
      sent.push(message);
      return { ok: true };
    },
    subscribe: (next) => {
      listener = next;
      return () => undefined;
    },
    close: () => undefined,
  };
  const open: OpenTransport = () => ({ ok: true, transport });
  const view = render(<StageScreen code="ABCD" openTransport={open} />);
  act(() => {
    listener?.({ kind: "status", status: "open" });
    if (state) listener?.({ kind: "message", data: JSON.stringify({ type: "welcome", playerId: "stage-1", state }) });
    extra.forEach((message) => listener?.({ kind: "message", data: JSON.stringify(message) }));
  });
  return { sent, view };
};

beforeEach(() => {
  window.localStorage.setItem("nailed-it:seat:ABCD", JSON.stringify({ playerId: "a", token: SECRET }));
});

describe("StageScreen", () => {
  it("joins as a stage and never shows a stored token", () => {
    const { sent } = mountStage(makeState());
    expect(sent).toEqual([{ type: "join", nickname: "Stage", role: "stage" }]);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("shows the code, a join QR, and players with deck stamps in the lobby", () => {
    mountStage(makeState());
    expect(screen.getAllByText("ABCD").length).toBeGreaterThan(0);
    expect(screen.getByTitle("Scan to join room ABCD")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getAllByText("Deck in")).toHaveLength(2);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows who has voted, never what, with no controls", () => {
    const state = makeState({ status: "playing", round: makeRound({ hotSeatPlayerId: "b", votedPlayerIds: ["c"] }) });
    mountStage(state);
    expect(screen.getByRole("heading").textContent).toBe("Bo's in the hot seat");
    const votes = screen.getByRole("complementary", { name: "Who has guessed" });
    expect(within(votes).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Adathinking",
      "Cyguessed",
    ]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reveals the stamp, points, confidence and the chain in order", () => {
    const state = makeState({
      status: "playing",
      players: [
        makePlayer({ id: "a", nickname: "Ada", isHost: true, hasDeck: true }),
        makePlayer({ id: "b", nickname: "Bo", hasDeck: true }),
      ],
      round: makeRound({
        hotSeatPlayerId: "b",
        phase: "reveal",
        truth: "off",
        guesses: { a: "nailed" },
        readerConfidence: 0.62,
        pointsAwarded: { a: 0 },
        chain: [
          { kind: "evidence", text: "Saw a folder of drafts." },
          { kind: "inference", text: "Drafts outnumber finals." },
        ],
      }),
    });
    mountStage(state);
    expect(screen.getByRole("img", { name: "Stamped: Way off" })).toBeTruthy();
    expect(screen.getByText("The reader was 62% sure.")).toBeTruthy();
    expect(screen.getByText("+0")).toBeTruthy();
    const chain = screen.getByRole("region", { name: "How it knew" });
    expect(within(chain).getAllByRole("listitem")).toHaveLength(3);
  });

  it("shows the leaderboard and reader accuracy at the end", () => {
    mountStage(makeState({ status: "finished", readerAccuracy: 0.5 }));
    expect(screen.getByText("Final scores")).toBeTruthy();
    expect(screen.getByText("The reader got 50% of its reads right.")).toBeTruthy();
  });

  it("explains a missing room", () => {
    mountStage(undefined, [{ type: "error", code: "room_not_found", message: "No room ABCD." }]);
    expect(screen.getByRole("alert").textContent).toContain("There's no room ABCD");
  });
});
