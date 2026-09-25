import OpenAI from 'openai';

// Vercel Hobby tier defaults to a 10s function timeout — too short for a
// classroom-loaded local model, which can occasionally run past that under
// concurrent student traffic. Hobby allows up to 60s with this export.
export const maxDuration = 60;

const client = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL,
  apiKey: process.env.VCS_API_SECRET,
});

// Some servers reject these extra fields (400/422) — if so we fall back to a
// plain request without them instead of failing every chat message.
async function requestStream(messages, withThinkingDisabled) {
  return client.chat.completions.create({
    model: process.env.OLLAMA_MODEL,
    messages,
    stream: true,
    ...(withThinkingDisabled ? { reasoning_effort: 'none', think: false } : {}),
  });
}

export async function POST(req) {
  const { messages } = await req.json();

  let completionStream;
  try {
    // Ask reasoning models to skip their internal "thinking" pass — it's the
    // biggest single cause of long waits and the user never sees those tokens anyway.
    completionStream = await requestStream(messages, true);
  } catch (error) {
    if (error?.status === 400 || error?.status === 422) {
      completionStream = await requestStream(messages, false);
    } else {
      return Response.json(
        { error: error instanceof Error ? error.message : 'Chat request failed.' },
        { status: error?.status || 500 },
      );
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of completionStream) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) controller.enqueue(encoder.encode(delta));
        }
      } catch (error) {
        controller.enqueue(encoder.encode(`\n\n[Error: ${error.message}]`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
