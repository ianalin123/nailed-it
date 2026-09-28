const MIN_SECRET_LENGTH = 8;

export class SecretBook {
  private readonly entries: Array<{ owner: string; value: string }> = [];

  add(owner: string, value: string): void {
    if (value.length < MIN_SECRET_LENGTH) {
      throw new Error(`The ${owner} is too short (${value.length} chars) to screen frames for reliably.`);
    }
    this.entries.push({ owner, value });
  }

  get size(): number {
    return this.entries.length;
  }

  owners(text: string): string[] {
    return this.entries.filter((entry) => text.includes(entry.value)).map((entry) => entry.owner);
  }
}

export const findLeaks = (markup: string, book: SecretBook): string[] => book.owners(markup);
