"""Generates test/golden/python-spans.json: the generation spans the Python SDK (zoroval-python 0.2.0)
writes for test/golden/scenarios.json against the fake OpenAI server (test/fake-openai.mjs).

usage: PYTHONPATH=<zoroval-python>/src python generate.py http://127.0.0.1:<port>/v1 > python-spans.json
Needs the Python SDK's dependencies and `openai`; the server comes from `node test/golden/serve.mjs`.
"""
import json
import sys
from pathlib import Path

import openai
import zoroval
from opentelemetry import trace
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

base_url = sys.argv[1]
scenarios = json.loads((Path(__file__).parent / "scenarios.json").read_text())

assert zoroval.init("zv_ingest_abcdefghijkl_0123456789ABCDEFGHIJ", ingest_url="http://127.0.0.1:1", instrument=["openai"])
exporter = InMemorySpanExporter()
trace.get_tracer_provider().add_span_processor(SimpleSpanProcessor(exporter))
client = openai.OpenAI(api_key="sk-test", base_url=base_url, max_retries=0)

out = []
for scenario in scenarios:
    exporter.clear()
    body = scenario["body"]
    api = client.chat.completions if scenario["api"] == "chat" else client.responses
    with zoroval.conversation("golden"):
        with zoroval.turn(input="q"):
            try:
                result = api.create(**body)
                if body.get("stream"):
                    for _event in result:
                        pass
            except openai.APIError:
                assert scenario.get("expectError")
    spans = [s for s in exporter.get_finished_spans() if (s.attributes or {}).get("zoroval.observation.type") == "generation"]
    assert len(spans) == 1, (scenario["name"], len(spans))
    span = spans[0]
    out.append({
        "name": scenario["name"],
        "span": {
            "name": span.name,
            "kind": int(span.kind.value) + 1 if hasattr(span.kind, "value") else int(span.kind),
            "status": span.status.status_code.name,
            "status_message": span.status.description,
            "attributes": {k: (list(v) if isinstance(v, (list, tuple)) else v) for k, v in dict(span.attributes).items()},
            "events": [{"name": e.name, "attributes": sorted(dict(e.attributes))} for e in span.events],
        },
    })
json.dump(out, sys.stdout, indent=1, sort_keys=True)
