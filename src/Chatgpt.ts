import { AxiosRequestConfig } from 'axios'
import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import { AzureOpenAI } from "openai";

import ConversationStore from './ConversationStore'
import Tokenizer from './Tokenizer'
import {
  IChatCompletion,
  IChatGPTResponse,
  IChatGPTUserMessage,
  IChatGPTSystemMessage,
  ERole,
  IChatGPTHTTPDataMessage,
  IChatGPTParams,
  IChatCompletionStreamOnEndData,
  IChatCompletionErrReponseData,
  TLog,
  TCommonMessage,
  ISendMessagesOpts,
} from './types'
import { post } from './utils/request'
import URLS from './utils/urls'
import {
  genId,
  log as defaultLog,
  isString,
  isArray,
  concatMessages,
} from './utils'

// https://platform.openai.com/docs/api-reference/chat
// curl https://api.openai.com/v1/chat/completions \
//   -H 'Content-Type: application/json' \
//   -H 'Authorization: Bearer YOUR_API_KEY' \
//   -d '{
//   "model": "gpt-3.5-turbo",
//   "messages": [{"role": "user", "content": "Hello!"}]
// }'

function genDefaultSystemMessage(): IChatGPTHTTPDataMessage {
  const currentDate = new Date().toISOString().split('T')[0]
  return {
    role: ERole.system,
    content: `You are ChatGPT, a large language model trained by OpenAI. Answer as concisely as possible.\nCurrent date: ${currentDate}`,
  }
}

// role https://platform.openai.com/docs/guides/chat/introduction
export class ChatGPT {
  #apiKey = ''
  #model = ''
  #urls = URLS
  #debug = false
  #requestConfig: AxiosRequestConfig
  #store: ConversationStore
  #tokenizer: Tokenizer
  #maxTokens: number
  #limitTokensInAMessage: number
  #ignoreServerMessagesInPrompt: boolean
  #log: TLog
  #vendor: 'AZURE' | 'OPENAI' = 'OPENAI'
  #client: AzureOpenAI | null = null
  constructor(opts: IChatGPTParams) {
    const {
      apiKey,
      model = 'gpt-3.5-turbo',
      debug = false,
      requestConfig = {},
      storeConfig = {},
      tokenizerConfig = {},
      maxTokens = 4096,
      limitTokensInAMessage = 1000,
      ignoreServerMessagesInPrompt = false,
      log = defaultLog,
      AZURE,
    } = opts

    this.#apiKey = apiKey
    this.#model = model
    this.#debug = debug
    this.#requestConfig = requestConfig
    this.#tokenizer = new Tokenizer(tokenizerConfig)
    this.#maxTokens = maxTokens
    this.#limitTokensInAMessage = limitTokensInAMessage
    this.#ignoreServerMessagesInPrompt = ignoreServerMessagesInPrompt
    this.#log = log
    if (AZURE) {
      this.#vendor = 'AZURE'
      this.#urls = {
        ...this.#urls,
        ...AZURE,
      }
    }

    this.#store = new ConversationStore({
      ...storeConfig,
      debug: this.#debug,
      log: this.#log,
    })

    this.initClient();
  }

  initClient() {
    const credential = new DefaultAzureCredential();
    const scope = "https://cognitiveservices.azure.com/.default";
    const endpoint = 'https://2049-azure-openai.openai.azure.com/';
    const azureADTokenProvider = getBearerTokenProvider(credential, scope);
    const apiVersion = "2024-05-01-preview";
    this.#client = new AzureOpenAI({ azureADTokenProvider, apiVersion, apiKey: this.#apiKey, endpoint });
  }

  /**
   * get related messages
   * @param parentMessageId
   */
  async getMessages(opts: {
    id: string
    maxDepth?: number
  }): Promise<TCommonMessage[]> {
    const messages = await this.#store.getMessages(opts)
    return messages
  }

  /**
   * add messages to store
   * @param messages
   * @returns
   */
  async addMessages(messages: TCommonMessage[]) {
    return await this.#store.set(messages)
  }

  /**
   * send message to ChatGPT server
   * @param opts.text new message
   * @param opts.systemPrompt prompt message
   * @param opts.parentMessageId
   */
  sendMessage(opts: ISendMessagesOpts | string | TCommonMessage[]) {
    return new Promise<IChatCompletionStreamOnEndData>(
      async (resolve, reject) => {
        if (isString(opts)) {
          opts = { text: opts as string }
        } else if (isArray(opts)) {
          opts = { initialMessages: opts as TCommonMessage[] }
        } else {
          // 使用对象传入，必须要设置 text
          if (
            !(opts as ISendMessagesOpts).text &&
            !(opts as ISendMessagesOpts).initialMessages
          ) {
            return reject(
              'You are passing in an object and it is required to set the text or initialMessages attribute.',
            )
          }
        }
        let {
          text = '',
          systemPrompt = undefined,
          parentMessageId = undefined,
          onProgress = false,
          onEnd = () => {},
          initialMessages = undefined,
          temperature = 1,
          model = this.#model,
        } = opts as ISendMessagesOpts
        // 是否需要把数据存储到 store 中
        const shouldAddToStore = !initialMessages
        if (systemPrompt) {
          if (parentMessageId)
            await this.#store.clear1Conversation(parentMessageId)
          parentMessageId = undefined
        }
        const userMessage: IChatGPTUserMessage = {
          id: genId(),
          text,
          role: ERole.user,
          parentMessageId,
          tokens: this.#tokenizer.getTokenCnt(text),
        }
        let messages: IChatGPTHTTPDataMessage[] = []
        if (shouldAddToStore) {
          messages = await this.#makeConversations(userMessage, systemPrompt)
        } else {
          messages = (initialMessages as TCommonMessage[]).map((msg) => ({
            role: msg.role,
            content: msg.text,
          }))
        }
        if (this.#debug) {
          this.#log('history messages', messages)
        }
        if (onProgress) {
          const responseMessage: IChatGPTResponse = {
            id: genId(),
            text: '',
            created: Math.floor(Date.now() / 1000),
            role: ERole.assistant,
            parentMessageId: shouldAddToStore
              ? userMessage.id
              : (initialMessages as TCommonMessage[])[
                  (initialMessages as TCommonMessage[]).length - 1
                ].id,
            tokens: 0,
            len: 0,
          }
          const innerOnEnd = async (
            endData: IChatCompletionStreamOnEndData,
          ) => {
            if (shouldAddToStore) {
              const msgsToBeStored = [userMessage, responseMessage]
              if (systemPrompt) {
                const systemMessage: IChatGPTSystemMessage = {
                  id: genId(),
                  text: systemPrompt,
                  role: ERole.system,
                  tokens: this.#tokenizer.getTokenCnt(systemPrompt),
                }
                userMessage.parentMessageId = systemMessage.id
                msgsToBeStored.unshift(systemMessage)
              }
              await this.#store.set(msgsToBeStored)
            }
            await onEnd(endData)
            resolve(endData)
          }
          await this.#streamChat(
            messages,
            onProgress,
            responseMessage,
            innerOnEnd,
            temperature,
            model,
          )
        } else {
          const chatResponse = await this.#chat(messages, model)
          if (!chatResponse.success) {
            return resolve({
              ...chatResponse,
              data: chatResponse.data as IChatCompletionErrReponseData,
              raw: chatResponse.data,
            })
          }
          const res = chatResponse.data as IChatCompletion
          const responseMessage: IChatGPTResponse = {
            id: genId(),
            text: res?.choices[0]?.message?.content,
            created: res.created,
            role: ERole.assistant,
            parentMessageId: shouldAddToStore
              ? userMessage.id
              : (initialMessages as TCommonMessage[])[
                  (initialMessages as TCommonMessage[]).length - 1
                ].id,
            tokens: res?.usage?.total_tokens,
            len:
              (res?.choices[0]?.message?.content.length || 0) +
              concatMessages(messages).length,
          }
          if (shouldAddToStore) {
            const msgsToBeStored = [userMessage, responseMessage]
            if (systemPrompt) {
              const systemMessage: IChatGPTSystemMessage = {
                id: genId(),
                text: systemPrompt,
                role: ERole.system,
                tokens: this.#tokenizer.getTokenCnt(systemPrompt),
              }
              userMessage.parentMessageId = systemMessage.id
              msgsToBeStored.unshift(systemMessage)
            }
            await this.#store.set(msgsToBeStored)
          }
          resolve({
            success: true,
            data: responseMessage,
            raw: res,
            status: chatResponse.status,
          })
        }
      },
    )
  }

  async #streamChat(
    messages: { content: string; role: ERole }[],
    onProgress: boolean | ((t: string, rwa: string) => void),
    responseMessagge: IChatGPTResponse,
    innerOnEnd: (d: IChatCompletionStreamOnEndData) => void,
    temperature: number,
    model: string,
  ) {
    let errorMessages = <Array<string>>[];
    const events = this.#client!.chat.completions.create({
      model,
      temperature,
      messages,
      stream: true,
      ...(this.#requestConfig.data || {}),
    });
    // @ts-ignore
    for await (const event of events) {
      for (const choice of event.choices) {
        const content = choice.delta?.content;
        const dataArr = content.toString().split('\n')
        let onDataPieceText = '';
        let tempString = '';
        for (const dataStr of dataArr) {
          tempString += dataStr;
          if (tempString.endsWith('}]}')) {
            if (!tempString.startsWith('data: ')) {
              errorMessages.push(tempString);
              tempString = '';
              return;
            }
            try {
              const parsedData = JSON.parse(tempString.slice(6));
              const content = parsedData.choices[0]?.delta?.content || "";
              onDataPieceText += content;
              tempString = '';
            } catch(e) {

            }
          }
        }
        if (typeof onProgress === 'function') {
          onProgress(onDataPieceText, content.toString())
        }
        responseMessagge.text += onDataPieceText
      }
    }
    // stream end
    responseMessagge.tokens = this.#tokenizer.getTokenCnt(
      responseMessagge.text + concatMessages(messages),
    )
    responseMessagge.len =
      responseMessagge.text.length + concatMessages(messages).length
    responseMessagge.errorMessages = errorMessages;
    errorMessages = [];
    await innerOnEnd({
      success: true,
      data: responseMessagge,
      status: 200,
    })
  }

  async #chat(messages: { content: string; role: ERole }[], model: string) {
    const axiosResponse = await post(
      {
        url: this.#urls.createChatCompletion,
        ...this.#requestConfig,
        headers: {
          ...(this.#vendor === 'OPENAI'
            ? { Authorization: this.#genAuthorization() }
            : { 'api-key': this.#apiKey }),
          'Content-Type': 'application/json',
          ...(this.#requestConfig.headers || {}),
        },
        data: {
          ...(this.#vendor === 'OPENAI' ? { model } : {}),
          messages,
          ...(this.#requestConfig.data || {}),
        },
      },
      {
        debug: this.#debug,
        log: this.#log,
      },
    )
    const data = axiosResponse.data
    const status = axiosResponse.status
    if (this.#validateAxiosResponse(status)) {
      return {
        success: true,
        data: data as IChatCompletion,
        status,
      }
    } else {
      const isTimeoutErr = String(axiosResponse).includes(
        'AxiosError: timeout of',
      )
      if (isTimeoutErr) {
        return {
          success: false,
          data: {
            message: 'request timeout',
            type: 'error',
          },
          status: 500,
        }
      }
      return {
        success: false,
        data: {
          message: data?.error?.message,
          type: data?.error?.type,
          ...data?.error,
        },
        status,
      }
    }
  }

  #validateAxiosResponse(status: number) {
    return status >= 200 && status < 300
  }

  /**
   * make conversations for http request data.messages
   */
  async #makeConversations(userMessage: IChatGPTUserMessage, prompt?: string) {
    let messages: IChatGPTHTTPDataMessage[] = []
    let usedTokens = this.#tokenizer.getTokenCnt(userMessage.text)
    if (prompt) {
      messages.push({
        role: ERole.system,
        content: prompt,
      })
    } else {
      messages = await this.#store.findMessages({
        id: userMessage.parentMessageId,
        tokenizer: this.#tokenizer,
        limit: this.#limitTokensInAMessage,
        availableTokens: this.#maxTokens - usedTokens,
        ignore: this.#ignoreServerMessagesInPrompt,
      })
    }
    /**
     * if there are no default system massage, add one
     */
    if (!messages.length || messages[0].role !== ERole.system) {
      messages.unshift(genDefaultSystemMessage())
    }
    messages.push({
      role: ERole.user,
      content: userMessage.text,
    })
    return messages
  }

  async clear1Conversation(parentMessageId?: string) {
    return await this.#store.clear1Conversation(parentMessageId)
  }

  /**
   * generate HTTP Authorization
   * @returns
   */
  #genAuthorization() {
    return `Bearer ${this.#apiKey}`
  }

  getStoreSize() {
    return this.#store.getStoreSize()
  }

  async createModeration(input: string): Promise<boolean> {
    const moderationRes = await post(
      {
        url: URLS.createModeration,
        headers: {
          Authorization: this.#genAuthorization(),
          'Content-Type': 'application/json',
        },
        data: {
          input,
        },
      },
      {
        debug: this.#debug,
        log: this.#log,
      },
    )
    const { data } = moderationRes
    return data.results[0].flagged
  }
}
