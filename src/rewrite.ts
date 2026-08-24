const RETRY_DELAY_SECONDS = 30;

export type RewriteResult = {
  text: string;
  rewritten: boolean;
};

type ErrorBody = {
  code?: unknown;
  message?: unknown;
};

type JsonObject = Record<string, unknown>;

export function rewriteCapacityError(text: string): RewriteResult {
  if (
    !text.includes("server_is_overloaded") &&
    !text.includes("slow_down")
  ) {
    return { text, rewritten: false };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { text, rewritten: false };
  }

  if (!isObject(payload)) {
    return { text, rewritten: false };
  }

  let rewritten = rewriteErrorBody(payload.error);
  if (isObject(payload.response)) {
    rewritten = rewriteErrorBody(payload.response.error) || rewritten;
  }

  return rewritten
    ? { text: JSON.stringify(payload), rewritten: true }
    : { text, rewritten: false };
}

export function rewriteSseEventBlock(block: string): RewriteResult {
  let rewritten = false;
  const lines = block.split(/\r?\n/).map((line) => {
    if (!line.startsWith("data:")) {
      return line;
    }

    const whitespace = line.slice(5).match(/^\s*/)?.[0] ?? "";
    const result = rewriteCapacityError(line.slice(5 + whitespace.length));
    rewritten = result.rewritten || rewritten;
    return result.rewritten ? `data:${whitespace}${result.text}` : line;
  });

  return { text: lines.join("\n"), rewritten };
}

export function createSseRewriteStream(
  onRewrite: () => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";

  return new TransformStream({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      while (true) {
        const delimiter = /\r?\n\r?\n/.exec(buffered);
        if (!delimiter) {
          break;
        }

        const block = buffered.slice(0, delimiter.index);
        buffered = buffered.slice(delimiter.index + delimiter[0].length);
        const result = rewriteSseEventBlock(block);
        if (result.rewritten) {
          onRewrite();
        }
        controller.enqueue(encoder.encode(result.text + delimiter[0]));
      }
    },
    flush(controller) {
      buffered += decoder.decode();
      if (!buffered) {
        return;
      }
      const result = rewriteSseEventBlock(buffered);
      if (result.rewritten) {
        onRewrite();
      }
      controller.enqueue(encoder.encode(result.text));
    },
  });
}

function rewriteErrorBody(candidate: unknown): boolean {
  if (!isObject(candidate)) {
    return false;
  }

  const error = candidate as ErrorBody;
  if (
    error.code !== "server_is_overloaded" &&
    error.code !== "slow_down"
  ) {
    return false;
  }

  error.code = "rate_limit_exceeded";
  const originalMessage =
    typeof error.message === "string" && error.message.trim()
      ? error.message.trim()
      : "Selected model is at capacity.";
  error.message = /try again in\s+\d+(?:\.\d+)?\s*(?:s|ms|seconds?)/i.test(
    originalMessage,
  )
    ? originalMessage
    : `${originalMessage} Please try again in ${RETRY_DELAY_SECONDS}s.`;
  return true;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
