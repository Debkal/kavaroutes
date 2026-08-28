import { QueryClient } from "@tanstack/react-query";
import { makeBoardProjection } from "./fixtures";
import { createProjectionStore } from "./projection-store";
import { createSyntheticApi } from "./synthetic-api";

export const projectionStore = createProjectionStore(makeBoardProjection());
export const syntheticApi = createSyntheticApi(projectionStore.getSnapshot());
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, gcTime: 120_000, retry: (count, error) => count < 2 && !(error instanceof DOMException && error.name === "AbortError"), refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

export function clearWebContext(): void {
  queryClient.clear();
  projectionStore.reset(makeBoardProjection());
}
