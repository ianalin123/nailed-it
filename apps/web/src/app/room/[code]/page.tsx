"use client";

import { use } from "react";
import { RoomEntry } from "@/components/room/RoomEntry";

export default function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  return <RoomEntry rawCode={decodeURIComponent(code)} />;
}
