import type { TranslationProvider } from "./base.js";
import type { ProviderConfig } from "./base.js";

/** Strip optional markdown code-fence wrapper the model sometimes adds. */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced ? fenced[1] : raw.trim();
}

export class AnthropicProvider implements TranslationProvider {
  constructor(private config: ProviderConfig) {}

  async translate(
    keys: Record<string, string>,
    targetLocale: string,
    systemPrompt: string,
  ): Promise<Record<string, string>> {
    let Anthropic: typeof import("@anthropic-ai/sdk").default;
    try {
      const mod = await import("@anthropic-ai/sdk");
      Anthropic = mod.default;
    } catch {
      throw new Error(
        "The @anthropic-ai/sdk package is required to use the Anthropic provider. Install it with: npm install @anthropic-ai/sdk",
      );
    }

    const client = new Anthropic({
      apiKey: this.config.apiKey ?? process.env.ANTHROPIC_API_KEY,
      ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
    });

    const userMessage =
      `Translate the following JSON values to ${targetLocale}.\n` +
      `Return ONLY a valid JSON object with the same keys.\n` +
      `Do not add explanation or markdown.\n\n` +
      JSON.stringify(keys, null, 2);

    const callApi = async (): Promise<string> => {
      const response = await client.messages.create({
        model: this.config.model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      });
      const block = response.content[0];
      if (block.type !== "text")
        throw new Error("Unexpected response content type from Anthropic");
      return block.text;
    };

    let raw: string;
    try {
      raw = await callApi();
    } catch (err) {
      throw new Error(
        `Anthropic API call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch {
      // Retry once
      process.stderr.write(
        `[warn] Failed to parse Anthropic response as JSON, retrying...\n`,
      );
      let raw2: string;
      try {
        raw2 = await callApi();
      } catch (err) {
        throw new Error(
          `Anthropic API call failed on retry: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        parsed = JSON.parse(extractJson(raw2));
      } catch {
        throw new Error(
          `Anthropic response is not valid JSON after retry. Raw response:\n${raw2}`,
        );
      }
    }

    const result: Record<string, string> = {};
    for (const [key, originalValue] of Object.entries(keys)) {
      if (key in parsed) {
        result[key] = String(parsed[key]);
      } else {
        process.stderr.write(
          `[warn] Missing key "${key}" in Anthropic translation response, keeping original value\n`,
        );
        result[key] = originalValue;
      }
    }

    return result;
  }
}
