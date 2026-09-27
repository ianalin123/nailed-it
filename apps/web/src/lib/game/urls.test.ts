import { roomUrls } from "./urls";

describe("roomUrls", () => {
  it("builds join and stage links and a short display host", () => {
    expect(roomUrls("https://nailed.example/", "KQRT")).toEqual({
      join: "https://nailed.example/room/KQRT",
      stage: "https://nailed.example/room/KQRT/stage",
      display: "nailed.example",
    });
  });
});
