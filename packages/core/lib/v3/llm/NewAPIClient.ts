import {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionUserMessageParam,
} from "openai/resources/chat";
import { validateZodSchema } from "../../utils.js";
import { LogLine } from "../types/public/logs.js";
import { AvailableModel, ClientOptions } from "../types/public/model.js";
import {
  CreateChatCompletionResponseError,
  StagehandError,
  ZodSchemaValidationError,
} from "../types/public/sdkErrors.js";
import { toJsonSchema } from "../zodCompat.js";
import {
  ChatCompletionOptions,
  ChatMessage,
  CreateChatCompletionOptions,
  LLMClient,
  LLMResponse,
} from "./LLMClient.js";

type NewAPIChatCompletionResponse = LLMResponse & {
  error?: {
    message?: string;
    type?: string;
    code?: string;
    param?: string;
  };
};

export class NewAPIClient extends LLMClient {
  public type = "openai" as const;
  declare public clientOptions: ClientOptions;
  private readonly apiKey?: string;
  private readonly baseURL: string;
  private readonly headers?: Record<string, string>;

  constructor({
    modelName,
    clientOptions,
  }: {
    logger: (message: LogLine) => void;
    modelName: AvailableModel;
    clientOptions?: ClientOptions;
  }) {
    super(modelName);
    this.clientOptions = clientOptions ?? {};
    this.apiKey = clientOptions?.apiKey;
    this.baseURL = (clientOptions?.baseURL ?? "").replace(/\/+$/, "");
    this.headers = clientOptions?.headers;
    this.modelName = modelName;
  }

  async createChatCompletion<T = LLMResponse>({
    options: optionsInitial,
    logger,
    retries = 3,
  }: CreateChatCompletionOptions): Promise<T> {
    if (!this.apiKey) {
      throw new StagehandError(
        "NEWAPI_API_KEY is required to use the newapi provider",
      );
    }
    if (!this.baseURL) {
      throw new StagehandError(
        "NEWAPI_BASE_URL is required to use the newapi provider",
      );
    }

    let options: Partial<ChatCompletionOptions> = optionsInitial;
    let isToolsOverridedForO1 = false;

    if (this.modelName.startsWith("o1") || this.modelName.startsWith("o3")) {
      /* eslint-disable */
      let {
        tool_choice,
        top_p,
        frequency_penalty,
        presence_penalty,
        temperature,
      } = options;
      ({
        tool_choice,
        top_p,
        frequency_penalty,
        presence_penalty,
        temperature,
        ...options
      } = options);
      /* eslint-enable */

      options.messages = options.messages.map((message) => ({
        ...message,
        role: "user",
      }));

      if (options.tools && options.response_model) {
        throw new StagehandError(
          "Cannot use both tool and response_model for o1 models",
        );
      }

      if (options.tools) {
        const { tools, ...rest } = options;
        options = rest;
        isToolsOverridedForO1 = true;
        options.messages.push({
          role: "user",
          content: `You have the following tools available to you:\n${JSON.stringify(
            tools,
          )}\n\nRespond with the following zod schema format to use a method: {\n  "name": "<tool_name>",\n  "arguments": <tool_args>\n}\n\nDo not include any other text or formattings like \`\`\` in your response. Just the JSON object.`,
        });
      }
    }

    if (
      options.temperature &&
      (this.modelName.startsWith("o1") || this.modelName.startsWith("o3"))
    ) {
      throw new StagehandError("Temperature is not supported for o1 models");
    }

    const { requestId, ...optionsWithoutImageAndRequestId } = options;

    logger({
      category: "openai",
      message: "creating chat completion",
      level: 2,
      auxiliary: {
        options: {
          value: JSON.stringify({
            ...optionsWithoutImageAndRequestId,
            requestId,
          }),
          type: "object",
        },
        modelName: {
          value: this.modelName,
          type: "string",
        },
      },
    });

    if (options.image) {
      const screenshotMessage: ChatMessage = {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${options.image.buffer.toString("base64")}`,
            },
          },
          ...(options.image.description
            ? [{ type: "text", text: options.image.description }]
            : []),
        ],
      };

      options.messages.push(screenshotMessage);
    }

    let responseFormat:
      | ChatCompletionCreateParamsNonStreaming["response_format"]
      | undefined;
    if (options.response_model) {
      responseFormat = {
        type: "json_object",
      };
    }

    /* eslint-disable */
    const { response_model, ...openAiOptions } = {
      ...optionsWithoutImageAndRequestId,
      model: this.modelName,
    };
    /* eslint-enable */

    logger({
      category: "openai",
      message: "creating chat completion",
      level: 2,
      auxiliary: {
        openAiOptions: {
          value: JSON.stringify(openAiOptions),
          type: "object",
        },
      },
    });

    const formattedMessages: ChatCompletionMessageParam[] =
      options.messages.map((message) => {
        if (Array.isArray(message.content)) {
          const contentParts = message.content.map((content) => {
            if ("image_url" in content) {
              const imageContent: ChatCompletionContentPartImage = {
                image_url: {
                  url: content.image_url.url,
                },
                type: "image_url",
              };
              return imageContent;
            } else {
              const textContent: ChatCompletionContentPartText = {
                text: content.text,
                type: "text",
              };
              return textContent;
            }
          });

          if (message.role === "system") {
            const formattedMessage: ChatCompletionSystemMessageParam = {
              ...message,
              role: "system",
              content: contentParts.filter(
                (content): content is ChatCompletionContentPartText =>
                  content.type === "text",
              ),
            };
            return formattedMessage;
          } else if (message.role === "user") {
            const formattedMessage: ChatCompletionUserMessageParam = {
              ...message,
              role: "user",
              content: contentParts,
            };
            return formattedMessage;
          } else {
            const formattedMessage: ChatCompletionAssistantMessageParam = {
              ...message,
              role: "assistant",
              content: contentParts.filter(
                (content): content is ChatCompletionContentPartText =>
                  content.type === "text",
              ),
            };
            return formattedMessage;
          }
        }

        return {
          role: message.role,
          content: message.content,
        } as ChatCompletionMessageParam;
      });

    if (options.response_model) {
      const schemaJson = JSON.stringify(
        toJsonSchema(options.response_model.schema),
        null,
        2,
      );
      formattedMessages.push({
        role: "user",
        content: `Respond with valid JSON matching this schema:\n${schemaJson}\n\nDo not include any other text, formatting or markdown in your output. Do not include \`\`\` or \`\`\`json in your response. Only the JSON object itself.`,
      });
    }

    const body: ChatCompletionCreateParamsNonStreaming = {
      ...openAiOptions,
      model: this.modelName,
      messages: formattedMessages,
      response_format: responseFormat,
      stream: false,
      tools: options.tools?.map((tool) => ({
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
        type: "function",
      })),
    };

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    let parsedResponse: NewAPIChatCompletionResponse;
    try {
      parsedResponse = JSON.parse(responseText) as NewAPIChatCompletionResponse;
    } catch {
      throw new CreateChatCompletionResponseError(
        `Failed to parse newapi response as JSON: ${responseText}`,
      );
    }

    if (!response.ok || parsedResponse.error) {
      throw new CreateChatCompletionResponseError(
        parsedResponse.error?.message ??
          `newapi chat completion failed with status ${response.status}`,
      );
    }

    if (isToolsOverridedForO1) {
      try {
        const parsedContent = JSON.parse(
          parsedResponse.choices[0].message.content ?? "",
        );

        parsedResponse.choices[0].message.tool_calls = [
          {
            function: {
              name: parsedContent["name"],
              arguments: JSON.stringify(parsedContent["arguments"]),
            },
            type: "function",
            id: "-1",
          },
        ];
        parsedResponse.choices[0].message.content = null;
      } catch (error) {
        logger({
          category: "openai",
          message: "Failed to parse tool call response",
          level: 0,
          auxiliary: {
            error: {
              value: error instanceof Error ? error.message : String(error),
              type: "string",
            },
            content: {
              value: parsedResponse.choices[0].message.content,
              type: "string",
            },
          },
        });

        if (retries > 0) {
          return this.createChatCompletion({
            options: options as ChatCompletionOptions,
            logger,
            retries: retries - 1,
          });
        }

        throw error;
      }
    }

    logger({
      category: "openai",
      message: "response",
      level: 2,
      auxiliary: {
        response: {
          value: JSON.stringify(parsedResponse),
          type: "object",
        },
        requestId: {
          value: requestId,
          type: "string",
        },
      },
    });

    if (options.response_model) {
      const extractedData = parsedResponse.choices[0].message.content;
      if (!extractedData) {
        throw new CreateChatCompletionResponseError("No content in response");
      }

      let parsedData: unknown;
      try {
        parsedData = JSON.parse(extractedData);
        validateZodSchema(options.response_model.schema, parsedData);
      } catch (e) {
        logger({
          category: "openai",
          message:
            e instanceof SyntaxError
              ? "Response is not valid JSON"
              : "Response failed Zod schema validation",
          level: 0,
        });
        if (retries > 0) {
          return this.createChatCompletion({
            options: options as ChatCompletionOptions,
            logger,
            retries: retries - 1,
          });
        }

        if (e instanceof ZodSchemaValidationError) {
          throw new CreateChatCompletionResponseError(e.message);
        }
        throw new CreateChatCompletionResponseError(
          e instanceof Error ? e.message : "Unknown error during response processing",
        );
      }

      return {
        data: parsedData,
        usage: parsedResponse.usage,
      } as T;
    }

    return parsedResponse as T;
  }
}
