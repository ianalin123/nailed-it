const started = Date.now();

const stamp = (): string => `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s`;

export const log = (message: string): void => {
  process.stdout.write(`[demo ${stamp()}] ${message}\n`);
};

export const warn = (message: string): void => {
  process.stderr.write(`[demo ${stamp()}] WARNING ${message}\n`);
};
