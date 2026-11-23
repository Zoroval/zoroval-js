from openai import OpenAI

client = OpenAI()


def parse(text, thread_id):
    return client.responses.parse(model="gpt-5", input=text, text_format=dict)
