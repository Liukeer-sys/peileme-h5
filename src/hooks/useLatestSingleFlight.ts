import { useCallback, useEffect, useRef, useState } from "react";

type OperationCallbacks<T> = {
  onStart?: () => void;
  onSuccess: (value: T) => void | Promise<void>;
  onError: (error: unknown) => void | Promise<void>;
};

export const useLatestSingleFlight = () => {
  const lockedRef = useRef(false);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    lockedRef.current = false;
    setBusy(false);
  }, []);

  const run = useCallback(
    async <T,>(
      operation: (signal: AbortSignal) => Promise<T>,
      callbacks: OperationCallbacks<T>
    ): Promise<boolean> => {
      if (lockedRef.current) return false;
      lockedRef.current = true;
      setBusy(true);
      const generation = ++generationRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      callbacks.onStart?.();
      try {
        const value = await operation(controller.signal);
        if (
          generation !== generationRef.current ||
          controller.signal.aborted
        ) {
          return false;
        }
        await callbacks.onSuccess(value);
        return true;
      } catch (error) {
        if (
          generation !== generationRef.current ||
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return false;
        }
        await callbacks.onError(error);
        return false;
      } finally {
        if (generation === generationRef.current) {
          lockedRef.current = false;
          abortRef.current = null;
          setBusy(false);
        }
      }
    },
    []
  );

  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    },
    []
  );

  return { busy, cancel, run };
};
