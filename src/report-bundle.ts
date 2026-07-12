export type ReportBundle = "public" | "subscriber";

export function reportBundleFor(state: { authenticated: boolean; isSubscriber: boolean }): ReportBundle {
  return state.authenticated && state.isSubscriber ? "subscriber" : "public";
}
