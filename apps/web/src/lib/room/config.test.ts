import { resolveRoomConfig } from "./config";

describe("resolveRoomConfig", () => {
  it("prefers the mock when enabled", () => {
    expect(resolveRoomConfig({ mock: "1", host: "x.dev", party: undefined })).toEqual({ mode: "mock" });
  });

  it("uses the host without a protocol prefix", () => {
    expect(resolveRoomConfig({ mock: "0", host: "https://room.example.dev", party: " " })).toEqual({
      mode: "party",
      host: "room.example.dev",
      party: undefined,
    });
  });

  it("explains a missing host", () => {
    const config = resolveRoomConfig({ mock: undefined, host: "", party: undefined });
    expect(config.mode).toBe("unconfigured");
  });
});
