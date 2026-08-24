export type ProbeId = string & { readonly __brand: "ProbeId" };

export interface SyntheticProbe {
  readonly id: ProbeId;
  readonly input: "alpha" | "bravo";
  readonly outcome: "accepted";
}

export function acceptSyntheticProbe(id: string, input: "alpha" | "bravo"): SyntheticProbe {
  if (!/^probe_[a-z0-9]{8}$/.test(id)) throw new Error("INVALID_SYNTHETIC_PROBE_ID");
  return Object.freeze({ id: id as ProbeId, input, outcome: "accepted" });
}
