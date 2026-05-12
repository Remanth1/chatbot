import type { ChatMessage } from "@/lib/types";

const SUPPORTED_TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/xml",
  "text/csv",
  "text/html",
  "text/javascript",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/typescript",
  "text/x-python",
  "text/yaml",
]);

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  csv: "text/csv",
  htm: "text/html",
  html: "text/html",
  js: "text/javascript",
  json: "application/json",
  jsx: "text/javascript",
  md: "text/markdown",
  mdx: "text/markdown",
  py: "text/x-python",
  ts: "text/typescript",
  tsx: "text/typescript",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
};

const MAX_SOURCE_BYTES = 1_000_000;
const MAX_CHARS_PER_SOURCE = 40_000;
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;
const MAX_CONTEXT_CHUNKS = 8;
const MAX_CONTEXT_CHARS = 10_000;

type FilePart = {
  type: "file";
  mediaType: string;
  name?: string;
  url: string;
};

type RagChunk = {
  filename: string;
  index: number;
  text: string;
  score: number;
};

export const SUPPORTED_RAG_MEDIA_TYPES = Array.from(SUPPORTED_TEXT_MEDIA_TYPES);

export function isSupportedRagMediaType(mediaType: string) {
  return (
    mediaType.startsWith("text/") || SUPPORTED_TEXT_MEDIA_TYPES.has(mediaType)
  );
}

export function getSupportedRagMediaType({
  mediaType,
  filename,
}: {
  mediaType?: string | null;
  filename?: string | null;
}) {
  if (mediaType && isSupportedRagMediaType(mediaType)) {
    return mediaType;
  }

  const extension = filename?.split(".").pop()?.toLowerCase();

  if (!extension) {
    return null;
  }

  return EXTENSION_MEDIA_TYPES[extension] ?? null;
}

function getQuestionText(message: ChatMessage | undefined) {
  if (!message) {
    return "";
  }

  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { type: "text"; text: string }).text)
    .join("\n");
}

function isFilePart(
  part: ChatMessage["parts"][number]
): part is ChatMessage["parts"][number] & FilePart {
  const candidate = part as Partial<FilePart>;

  return (
    part.type === "file" &&
    typeof candidate.url === "string" &&
    typeof candidate.mediaType === "string" &&
    isSupportedRagMediaType(candidate.mediaType)
  );
}

function getFileParts(messages: ChatMessage[]): FilePart[] {
  return messages.flatMap((message) =>
    message.parts.filter(isFilePart).map((part) => ({
      type: "file",
      mediaType: part.mediaType,
      name: part.name,
      url: part.url,
    }))
  );
}

function tokenize(text: string) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2)
  );
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function chunkText(text: string) {
  const normalizedText = normalizeText(text).slice(0, MAX_CHARS_PER_SOURCE);
  const chunks: string[] = [];

  for (
    let start = 0;
    start < normalizedText.length;
    start += CHUNK_SIZE - CHUNK_OVERLAP
  ) {
    const chunk = normalizedText.slice(start, start + CHUNK_SIZE).trim();

    if (chunk) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

function scoreChunk(chunk: string, queryTokens: Set<string>) {
  if (queryTokens.size === 0) {
    return 0;
  }

  const chunkTokens = tokenize(chunk);
  let score = 0;

  for (const token of queryTokens) {
    if (chunkTokens.has(token)) {
      score += 1;
    }
  }

  return score;
}

async function fetchTextFile(part: FilePart) {
  if (
    !part.url ||
    !part.mediaType ||
    !isSupportedRagMediaType(part.mediaType)
  ) {
    return null;
  }

  const response = await fetch(part.url);

  if (!response.ok) {
    return null;
  }

  const contentLength = response.headers.get("content-length");

  if (contentLength && Number(contentLength) > MAX_SOURCE_BYTES) {
    return null;
  }

  const text = await response.text();

  return {
    filename: part.name || "uploaded file",
    text,
  };
}

export async function buildRagContext(messages: ChatMessage[]) {
  const latestUserMessage = messages.findLast(
    (message) => message.role === "user"
  );
  const queryTokens = tokenize(getQuestionText(latestUserMessage));
  const fileParts = getFileParts(messages);

  if (fileParts.length === 0) {
    return "";
  }

  const files = await Promise.all(fileParts.map((part) => fetchTextFile(part)));
  const chunks: RagChunk[] = files.flatMap((file) => {
    if (!file) {
      return [];
    }

    return chunkText(file.text).map((chunk, index) => ({
      filename: file.filename,
      index: index + 1,
      text: chunk,
      score: scoreChunk(chunk, queryTokens),
    }));
  });

  const selectedChunks = chunks
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CONTEXT_CHUNKS);

  if (selectedChunks.length === 0) {
    return "";
  }

  const context = selectedChunks
    .map(
      (chunk) =>
        `Source: ${chunk.filename} (chunk ${chunk.index})\n${chunk.text}`
    )
    .join("\n\n---\n\n")
    .slice(0, MAX_CONTEXT_CHARS);

  return `Use the following retrieved context from the user's uploaded files to answer file-related questions. Cite source filenames when useful. If the retrieved context does not contain the answer, say so and do not invent details.\n\n${context}`;
}
