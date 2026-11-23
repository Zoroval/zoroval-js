import os
from fastapi import FastAPI, Request
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()
app = FastAPI()
client = OpenAI()


@app.post("/chat")
async def chat(request: Request, chat_id: str, *, thread_id: str = "x"):
    body = await request.json()
    session = body["session_id"]
    reply = client.chat.completions.create(model="gpt-5", messages=[{"role": "user", "content": body["text"]}])
    again = client.responses.create(model="gpt-5", input="hi", conversation_id=chat_id)
    return {"id": request.chat_id, "ref": ["chat_id"]}


@app.get("/health")
def health():
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, workers=2)
