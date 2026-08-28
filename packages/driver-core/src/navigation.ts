export type NavigationDestination = { readonly kind: "PLACE_ID"; readonly value: string } | { readonly kind: "COORDINATE"; readonly latitude: number; readonly longitude: number } | { readonly kind: "SYNTHETIC_ADDRESS"; readonly value: string };
export type NavigationPlatform = "android" | "ios" | "other";

export function buildGoogleDirectionsUrl(destination: NavigationDestination, action: "navigate" | "preview" = "navigate"): string {
  let value: string;
  if (destination.kind === "PLACE_ID") {
    if (!/^ChI[A-Za-z0-9_-]{8,240}$/.test(destination.value)) throw new Error("NAVIGATION_PLACE_ID_INVALID");
    value = `place_id:${destination.value}`;
  } else if (destination.kind === "COORDINATE") {
    if (!Number.isFinite(destination.latitude) || destination.latitude < -90 || destination.latitude > 90 || !Number.isFinite(destination.longitude) || destination.longitude < -180 || destination.longitude > 180) throw new Error("NAVIGATION_COORDINATE_INVALID");
    value = `${destination.latitude.toFixed(6)},${destination.longitude.toFixed(6)}`;
  } else {
    if (!/^Synthetic [A-Za-z0-9 .-]{4,80}$/.test(destination.value)) throw new Error("NAVIGATION_ADDRESS_INVALID");
    value = destination.value;
  }
  const query = new URLSearchParams({ api: "1", destination: value, travelmode: "driving" });
  if (action === "navigate") query.set("dir_action", "navigate");
  return `https://www.google.com/maps/dir/?${query.toString()}`;
}

export function buildAppleMapsUrl(destination: NavigationDestination): string {
  const google = new URL(buildGoogleDirectionsUrl(destination, "preview"));
  const destinationValue = google.searchParams.get("destination");
  if (!destinationValue) throw new Error("NAVIGATION_DESTINATION_MISSING");
  return `https://maps.apple.com/?${new URLSearchParams({ daddr: destinationValue, dirflg: "d" }).toString()}`;
}

export async function handoffNavigation(
  port: { canOpen(url: string): Promise<boolean>; open(url: string): Promise<void> },
  destination: NavigationDestination,
  platform: NavigationPlatform = "other",
): Promise<"OPENED_GOOGLE" | "OPENED_APPLE" | "UNAVAILABLE"> {
  const url = platform === "ios" ? buildAppleMapsUrl(destination) : buildGoogleDirectionsUrl(destination);
  if (await port.canOpen(url)) { await port.open(url); return platform === "ios" ? "OPENED_APPLE" : "OPENED_GOOGLE"; }
  return "UNAVAILABLE";
}

export function safeNavigationTelemetry(outcome: "OPENED_GOOGLE" | "OPENED_APPLE" | "UNAVAILABLE" | "REJECTED") {
  return Object.freeze({ metric: "driver_navigation_handoff", outcome });
}
