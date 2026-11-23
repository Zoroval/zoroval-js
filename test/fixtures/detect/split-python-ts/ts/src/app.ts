import { answer } from "./operation.ts";

export function handleMessage(chatId: string, input: string) {
  return answer(input, chatId);
}
