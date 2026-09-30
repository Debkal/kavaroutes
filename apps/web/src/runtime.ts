import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, gcTime: 120_000, retry: (count, error) => count < 2 && !(error instanceof DOMException && error.name === "AbortError"), refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

export function clearWebContext(): void {
  queryClient.clear();
}
