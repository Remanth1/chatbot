import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import { getSupportedRagMediaType } from "@/lib/ai/rag";

// Use Blob instead of File since File is not available in Node.js environment
const FileSchema = z.object({
  file: z.instanceof(Blob).refine((file) => file.size <= 10 * 1024 * 1024, {
    message: "File size should be less than 10MB",
  }),
});

function getAllowedContentType(file: Blob, filename: string) {
  if (["image/jpeg", "image/png"].includes(file.type)) {
    return file.type;
  }

  return getSupportedRagMediaType({
    mediaType: file.type,
    filename,
  });
}

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.body === null) {
    return new Response("Request body is empty", { status: 400 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as Blob;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const validatedFile = FileSchema.safeParse({ file });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.errors
        .map((error) => error.message)
        .join(", ");

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    // Get filename from formData since Blob doesn't have name property
    const filename = (formData.get("file") as File).name;
    const contentType = getAllowedContentType(file, filename);

    if (!contentType) {
      return NextResponse.json(
        { error: "File type should be JPEG, PNG, or a text-based document" },
        { status: 400 }
      );
    }

    const fileBuffer = await file.arrayBuffer();

    try {
      const data = await put(`${filename}`, fileBuffer, {
        access: "public",
        contentType,
      });

      return NextResponse.json(data);
    } catch (_error) {
      return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}
