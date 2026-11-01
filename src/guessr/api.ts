import type { Bounds, Point } from "./rules";
import type { ImageGameConfig } from './image-game';
import type { ClueSource } from './clue-camera';
export { gameApiOrigin } from './api-origin';

export interface RankedState {
  id: string;
  challengeId: string;
  day: string;
  title: string;
  totalRounds: number;
  round: number;
  status: "active" | "complete" | "expired";
  revealed: boolean;
  revealAt: number;
  closesAt: number;
  serverNow: number;
  bounds: Bounds;
  deadline: number | null;
  image: string | null;
  config?: ImageGameConfig;
  clue?: ClueSource | null;
  submitted: number[];
  score?: number;
  elapsedMs?: number;
  results?: {
    ordinal: number;
    answer: Point;
    name: string;
    biome: string;
    seed: number;
    image: string;
    clue?: ClueSource;
    difficultyTier?: 'easy' | 'normal' | 'hard';
    guess: {
      x: number | null;
      y: number | null;
      score: number;
      distance: number | null;
      elapsed_ms: number;
      maximum?: number;
      area_score?: number | null;
      position_score?: number | null;
    } | null;
  }[];
}
export interface DailyStatus {
  challenge: {
    id: string;
    day: string;
    title: string;
    closesAt: number;
    revealAt: number;
    roundSeconds: number;
    totalRounds: number;
  } | null;
  attemptId: string | null;
}
export interface Leaderboard {
  period: string;
  day: string;
  pending: boolean;
  rows: { name: string; score: number; elapsedMs: number; games: number }[];
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
let authReady:
  Promise<(typeof import("../auth/auth-service"))["authService"]> | undefined;
export function gameAuth() {
  return (authReady ??= (async () => {
    const [{ authService }, { initializeTranslations }] = await Promise.all([
      import("../auth/auth-service"),
      import("../i18n"),
    ]);
    await initializeTranslations();
    await authService.init();
    return authService;
  })().catch((error) => {
    authReady = undefined;
    throw error;
  }));
}
export class GameApi {
  private ticket?: { token: string; expiresAt: number };
  private ticketRequest?: Promise<string>;
  constructor(readonly origin: string) {}
  clear(): void {
    this.ticket = undefined;
  }
  private async getTicket(): Promise<string> {
    if (this.ticket && this.ticket.expiresAt > Date.now() + 30000)
      return this.ticket.token;
    return (this.ticketRequest ??= this.issueTicket().finally(() => {
      this.ticketRequest = undefined;
    }));
  }
  private async issueTicket(): Promise<string> {
    const auth = await gameAuth();
    if (!auth.getState().isSubscriber)
      throw new ApiError(
        403,
        "Ranked games and leaderboards are available with Pro.",
      );
    const host = location.hostname;
    const local = ["localhost", "127.0.0.1"].includes(host);
    const authOrigin =
      (local && localStorage.getItem("noitamap_auth_worker")) ||
      (local || host.includes("dev.")
        ? "https://noitamap-auth-dev.wuote.workers.dev"
        : "https://noitamap-auth.wuote.workers.dev");
    const response = await fetch(authOrigin + "/auth/game-ticket", {
      method: "POST",
      headers: { Authorization: "Bearer " + auth.getToken() },
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.token !== "string")
      throw new ApiError(
        response.status,
        data.error ||
          "Ranked sign-in is unavailable. Practice is ready to play.",
      );
    this.ticket = data;
    return data.token;
  }
  async request<T>(path: string, options: { body?: unknown } = {}): Promise<T> {
    if (!path.startsWith("/api/")) throw new Error("Invalid game route");
    const token = await this.getTicket();
    const response = await fetch(this.origin + path, {
      method: options.body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) this.clear();
      throw new ApiError(
        response.status,
        data.error || "Could not contact the game. Please retry.",
      );
    }
    return data as T;
  }
  async image(path: string, signal?: AbortSignal): Promise<Blob> {
    if (!/^\/api\/attempts\/[\w-]+\/image\/[0-9]$/.test(path))
      throw new Error("Invalid round image");
    const response = await fetch(this.origin + path, {
      headers: { Authorization: "Bearer " + (await this.getTicket()) },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if (response.status === 401) this.clear();
      throw new ApiError(
        response.status,
        "Could not load this clue. Your attempt is saved.",
      );
    }
    return response.blob();
  }
}
