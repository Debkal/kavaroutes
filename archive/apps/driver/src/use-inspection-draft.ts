import { useEffect, useRef, useState } from "react";
import { readInspectionFormDraft, saveInspectionFormDraft } from "./nativeActions";
import type { FormBinding, InspectionFormDraft } from "./inspection-form-store";
export function useInspectionDraft(binding: FormBinding, initial: InspectionFormDraft) {
  const [draft, setDraft] = useState(initial); const current = useRef(initial);
  const [ready, setReady] = useState(false); const [error, setError] = useState<string>();
  const write = useRef(Promise.resolve()); const live = useRef(true);
  useEffect(() => {
    let active = true;
    live.current = true; setReady(false);
    void readInspectionFormDraft(binding).then(saved => {
      if (!active) return;
      current.current = saved ?? initial; setDraft(current.current); setReady(true);
    }).catch(() => { if (active) setError("Cannot recover the protected inspection draft. No completion was recorded."); });
    return () => { active = false; live.current = false; };
  }, [binding.generation, binding.stage, binding.policyDigest]);
  const change = (patch: Partial<InspectionFormDraft>) => {
    const next = { ...current.current, ...patch }; current.current = next; setDraft(next);
    write.current = write.current.catch(() => undefined).then(() => saveInspectionFormDraft(binding, next));
    void write.current.then(() => { if (live.current) setError(undefined); }).catch(() => {
      if (live.current) setError("The latest input is not saved. Retry the edit before closing or submitting.");
    });
  };
  return { draft, ready, error, change, flush: () => write.current };
}
