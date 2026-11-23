"""Docstring that mentions chat_id and client.chat.completions.create(model=x)."""
from __future__ import annotations
import os, sys as system
import a.b.c as abc
from . import sibling
from .rel import thing
from langfuse.openai import openai, OpenAI as LFOpenAI
from langfuse.decorators import observe
from openinference.instrumentation.openai import OpenAIInstrumentor
from traceloop.sdk import Traceloop
from phoenix.otel import register
from flask import (
    Flask,
    request as req,
)
from opentelemetry.sdk.trace import TracerProvider

app = Flask(__name__)
OpenAIInstrumentor().instrument()
Traceloop.init(app_name="x")
register(project_name="p")
tp = TracerProvider()


def make_client():
    return openai.OpenAI()


@app.route("/x", methods=["POST"])
@observe()
async def handle(a, /, b, chatId, *args, session_id=None, **kwargs):
    text = "chat_id" + '''client.chat.completions.create(''' + f"{thread_id}"  # chat_id in comment
    data = req.json["conversationId"]
    other = ["chat_id"]
    resp = (make_client()
            .chat
            .completions
            .create(model="x",
                    messages=[],
                    thread_id=1,
                    **kwargs))
    r2 = openai.responses.parse(model="x", input=dict(room_id=3, x=lambda dialog_id=1: 1))
    return handle2(sessionId=resp.session_id, x=req.args.chat_id)


class K:
    @staticmethod
    def handler(event, context):
        return None

    async def stream(self, c, *, threadId):
        async with c.responses.stream(model="m") as s:
            pass


def handler(event, context): ...


def lambda_handler(event, *rest): ...


if __name__ == "__main__":
    app.run()
elif __name__ != "x":
    pass
