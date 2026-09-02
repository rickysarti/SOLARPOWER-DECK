import { runtimeSecret } from "./db.ts";

export type AgentMessage = { role: "user" | "assistant"; content: string };

type ImageInput = { mediaType: string; data: string };

export async function askClaude(
  system: string,
  messages: AgentMessage[],
  maxTokens = 900,
  image?: ImageInput,
): Promise<string> {
  const apiKey = await runtimeSecret("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");

  const model = await runtimeSecret("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001";
  const apiMessages: unknown[] = messages.map((message, index) => {
    if (!image || index !== messages.length - 1 || message.role !== "user") return message;
    return {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: image.mediaType, data: image.data },
        },
        { type: "text", text: message.content },
      ],
    };
  });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: apiMessages }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic ${response.status}: ${body.slice(0, 400)}`);
  }

  const result = await response.json();
  const text = result?.content?.find((part: { type?: string }) => part.type === "text")?.text;
  if (!text) throw new Error("Anthropic returned no text");
  return String(text).trim();
}

export async function classifyContact(text: string): Promise<string> {
  const result = await askClaude(
    "Clasifica el mensaje para SolarPower. Responde solo una palabra: residencial, comercial, academia, cv u otro.",
    [{ role: "user", content: text }],
    20,
  );
  const normalized = result.toLowerCase().match(/residencial|comercial|academia|cv|otro/)?.[0];
  return normalized ?? "otro";
}

export async function analyzeImage(mediaType: string, data: string): Promise<string> {
  return await askClaude(
    "Describe imagenes recibidas por el agente comercial de SolarPower Argentina.",
    [{
      role: "user",
      content: "Describe en una oracion que se ve. Si es una factura de luz, techo, panel o instalacion electrica, indicalo claramente.",
    }],
    140,
    { mediaType, data },
  );
}
