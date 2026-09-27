"use client";

import { use } from "react";
import { RoomEntry } from "@/components/room/RoomEntry";
import { parseCreateAttempt } from "@/lib/room/joinPlan";

type RoomPageProps = {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function RoomPage({ params, searchParams }: RoomPageProps) {
  const { code } = use(params);
  const query = use(searchParams);
  const rawCode = decodeURIComponent(code);
  return <RoomEntry key={rawCode} rawCode={rawCode} createAttempt={parseCreateAttempt(query.create)} />;
}
