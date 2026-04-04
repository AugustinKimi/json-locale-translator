import type { TranslationProvider } from "./base.js";
import type { ProviderConfig } from "./base.js";
import { retryWithBackoff } from "../retry.js";
import type { RetryOptions } from "../retry.js";
import { RateLimiter } from "../rate-limiter.js";

/** Strip optional markdown code-fence wrapper the model sometimes adds. */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced ? fenced[1] : raw.trim();
}

export class OpenAIProvider implements TranslationProvider {
  private readonly _rateLimiter: RateLimiter;

  constructor(
    private config: ProviderConfig,
    /** Injectable delay function for tests — omit in production. */
    private _delayFn?: RetryOptions["delayFn"],
  ) {
    this._rateLimiter = new RateLimiter(_delayFn);
  }

  async translate(
    keys: Record<string, string>,
    targetLocale: string,
    systemPrompt: string,
  ): Promise<Record<string, string>> {
    let OpenAI: typeof import("openai").default;
    try {
      const mod = await import("openai");
      OpenAI = mod.default;
    } catch {
      throw new Error(
        "The openai package is required to use the OpenAI provider. Install it with: npm install openai",
      );
    }

    const client = new OpenAI({
      apiKey: this.config.apiKey ?? process.env.OPENAI_API_KEY,
      ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
    });

    const userMessage =
      `Translate the following JSON values to ${targetLocale}.\n` +
      `Return ONLY a valid JSON object with the same keys.\n` +
      `Do not add explanation or markdown.\n\n` +
      JSON.stringify(keys, null, 2);

    const callApi = async (): Promise<string> => {
      await this._rateLimiter.throttle();
      const { data: completion, response: httpResponse } =
        await client.chat.completions
          .create({
            model: this.config.model,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
            ],
          })
          .withResponse();
      this._rateLimiter.update(httpResponse.headers);
      const content = completion.choices[0]?.message?.content;
      if (!content) throw new Error("Empty response from OpenAI");
      return content;
    };

    let raw: string;
    try {
      raw = await retryWithBackoff(callApi, { delayFn: this._delayFn });
    } catch (err) {
      throw new Error(
        `OpenAI API call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch {
      // Retry once
      process.stderr.write(
        `[warn] Failed to parse OpenAI response as JSON, retrying...\n`,
      );
      let raw2: string;
      try {
        raw2 = await retryWithBackoff(callApi, { delayFn: this._delayFn });
      } catch (err) {
        throw new Error(
          `OpenAI API call failed on retry: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        parsed = JSON.parse(extractJson(raw2));
      } catch {
        throw new Error(
          `OpenAI response is not valid JSON after retry. Raw response:\n${raw2}`,
        );
      }
    }

    const result: Record<string, string> = {};
    for (const [key, originalValue] of Object.entries(keys)) {
      if (key in parsed) {
        result[key] = String(parsed[key]);
      } else {
        process.stderr.write(
          `[warn] Missing key "${key}" in OpenAI translation response, keeping original value\n`,
        );
        result[key] = originalValue;
      }
    }

    return result;
  }
}
