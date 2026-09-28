import { describe, expect, it } from "vitest";
import { SecretBook, findLeaks } from "./secrets";

describe("findLeaks", () => {
  it("names the owner of each leaked secret without echoing it", () => {
    const book = new SecretBook();
    book.add("reconnect token of Mika", "tok-abc123-secret");
    book.add("reconnect token of Ada", "tok-zzz999-secret");
    const leaks = findLeaks("<p>tok-abc123-secret</p>", book);
    expect(leaks).toEqual(["reconnect token of Mika"]);
  });

  it("finds nothing in clean markup", () => {
    const book = new SecretBook();
    book.add("reconnect token of Mika", "tok-abc123-secret");
    expect(findLeaks("<p>Nailed It</p>", book)).toEqual([]);
  });

  it("refuses to track a trivially short secret, which would match by accident", () => {
    expect(() => new SecretBook().add("x", "ab")).toThrow(/too short/);
  });
});
