export async function saveChat(chatId: string, messages: unknown[]) {
  return { chatId, count: messages.length };
}
