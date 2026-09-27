import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ClientMessage } from "@nailed-it/protocol";
import { makePlayer, makeRound, makeState } from "@/test/fixtures";
import { FinishedView } from "./FinishedView";
import { LobbyView } from "./LobbyView";
import { RevealView } from "./RevealView";
import { VotingView } from "./VotingView";

const recorder = () => {
  const sent: ClientMessage[] = [];
  return { sent, send: (message: ClientMessage) => sent.push(message) };
};

describe("LobbyView", () => {
  it("shows the plugin command and submits a schema-valid demo deck", async () => {
    const state = makeState({ players: [makePlayer({ id: "a", nickname: "Ada", isHost: true })] });
    const { sent, send } = recorder();
    render(<LobbyView room={state} viewerId="a" send={send} />);
    expect(screen.getByText("/nailed-it:read ABCD")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Use demo deck" }));
    expect(sent[0]?.type).toBe("submit_deck");
  });

  it("disables Start for the host with the reason", () => {
    const state = makeState({
      players: [makePlayer({ id: "a", nickname: "Ada", isHost: true, hasDeck: true }), makePlayer({ id: "b" })],
    });
    render(<LobbyView room={state} viewerId="a" send={() => undefined} />);
    const start = screen.getByRole("button", { name: "Start the game" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText("Needs at least 2 decks. 1 in so far.")).toBeTruthy();
  });

  it("starts with the chosen number of cards per player", async () => {
    const { sent, send } = recorder();
    render(<LobbyView room={makeState()} viewerId="a" send={send} />);
    await userEvent.click(screen.getByRole("button", { name: "More cards" }));
    await userEvent.click(screen.getByRole("button", { name: "Start the game" }));
    expect(sent).toEqual([{ type: "start", cardsPerPlayer: 4 }]);
  });

  it("hides host controls from other players", () => {
    render(<LobbyView room={makeState()} viewerId="b" send={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Start the game" })).toBeNull();
    expect(screen.getByText("Waiting for Ada to start.")).toBeTruthy();
  });
});

describe("VotingView", () => {
  const voting = makeState({
    status: "playing",
    round: makeRound({ hotSeatPlayerId: "b", votedPlayerIds: ["c"] }),
  });

  it("gives guessers two buttons and lets them change their guess", async () => {
    const { sent, send } = recorder();
    render(<VotingView room={voting} viewerId="a" send={send} />);
    expect(screen.getByRole("heading").textContent).toBe("Bo's in the hot seat");
    await userEvent.click(screen.getByRole("button", { name: "Nailed it" }));
    await userEvent.click(screen.getByRole("button", { name: "Way off" }));
    expect(sent).toEqual([
      { type: "guess", readId: "r1", guess: "nailed" },
      { type: "guess", readId: "r1", guess: "off" },
    ]);
    expect(screen.getByRole("button", { name: "Way off" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Partly" })).toBeNull();
  });

  it("gives the hot seat three reveal buttons and the vote count", async () => {
    const { sent, send } = recorder();
    render(<VotingView room={voting} viewerId="b" send={send} />);
    expect(screen.getByRole("heading").textContent).toBe("You're in the hot seat");
    expect(screen.getByText("1 of 2")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Partly" }));
    expect(sent).toEqual([{ type: "reveal", readId: "r1", truth: "partly" }]);
  });

  it("shows who has guessed without what they guessed", () => {
    render(<VotingView room={voting} viewerId="a" send={() => undefined} />);
    const strip = screen.getByRole("list", { name: "Who has guessed" });
    const chips = within(strip).getAllByRole("listitem").map((item) => item.textContent);
    expect(chips).toEqual(["You thinking", "Cy guessed"]);
    expect(strip.textContent).not.toMatch(/nailed|off/i);
  });
});

describe("RevealView", () => {
  const revealed = makeState({
    status: "playing",
    round: makeRound({
      hotSeatPlayerId: "b",
      phase: "reveal",
      truth: "nailed",
      guesses: { a: "nailed", c: "off" },
      readerConfidence: 0.7,
      pointsAwarded: { a: 100, c: 0 },
    }),
  });

  it("shows truth, confidence, each guess and points, and Next for the host", async () => {
    const { sent, send } = recorder();
    render(<RevealView room={revealed} viewerId="a" send={send} />);
    expect(screen.getByRole("img", { name: "Stamped: Nailed it" })).toBeTruthy();
    expect(screen.getByText("The reader was 70% sure.")).toBeTruthy();
    expect(screen.getByText("+100")).toBeTruthy();
    expect(screen.getByText("Said way off. Wrong.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next card" }));
    expect(sent).toEqual([{ type: "next" }]);
  });

  it("tells non-hosts who they are waiting on", () => {
    render(<RevealView room={revealed} viewerId="c" send={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Next card" })).toBeNull();
    expect(screen.getByText("Waiting for Ada to deal the next card.")).toBeTruthy();
  });
});

describe("FinishedView", () => {
  it("ranks players and reports reader accuracy", () => {
    const state = makeState({
      status: "finished",
      readerAccuracy: 0.64,
      players: [makePlayer({ id: "a", nickname: "Ada", score: 100 }), makePlayer({ id: "b", nickname: "Bo", score: 300 })],
    });
    render(<FinishedView room={state} viewerId="a" />);
    const rows = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(rows).toEqual(["1Bo300", "2Ada (you)100"]);
    expect(screen.getByText("The reader got 64% of its reads right.")).toBeTruthy();
  });
});
