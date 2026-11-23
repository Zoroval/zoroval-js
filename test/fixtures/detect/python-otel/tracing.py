from opentelemetry.sdk.trace import TracerProvider
from opentelemetry import trace
from anthropic import Anthropic

provider = TracerProvider()
trace.set_tracer_provider(provider)
client = Anthropic()
msg = client.messages.create(model="x", max_tokens=1, messages=[], threadId="t")
