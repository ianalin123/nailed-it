"use client";

import { useEffect, useState } from "react";

export const useOrigin = (): string | undefined => {
  const [origin, setOrigin] = useState<string | undefined>(undefined);
  useEffect(() => setOrigin(window.location.origin), []);
  return origin;
};
