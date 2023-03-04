import { stdin, stdout } from 'process'
import { createInterface } from 'readline'
import { ChatGPT } from '../src'
import apiKey from './.key'

function getReadLine() {
  const rl = createInterface({ input: stdin, output: stdout })
  const iter = rl[Symbol.asyncIterator]()
  return async () => (await iter.next()).value
}

void (async function () {
  let prevRes: any
  let line = ''
  const readline = getReadLine()
  console.log('---------------------your question------------------')
  while ((line = await readline())) {
    prevRes = await basicRunner(line, prevRes?.id)
    console.log('---------------------ChatGPT says------------------------')
    console.log(prevRes.text)
    console.log('---------------------your question------------------')
  }
})()

const api = new ChatGPT({
  apiKey,
  debug: true,
  requestConfig: {
    timeout: 1000 * 600,
  },
})

async function basicRunner(text: string, parentMessageId?: string) {
  const res = await api.createChatCompletion({
    text,
    parentMessageId,
  })
  return res
}