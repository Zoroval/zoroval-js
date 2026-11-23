from langfuse import observe, get_client
from langfuse.openai import openai


@observe()
def answer(conversation_id, text):
    return openai.chat.completions.create(model="gpt-5", messages=[{"role": "user", "content": text}])
