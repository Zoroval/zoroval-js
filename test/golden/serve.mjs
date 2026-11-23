// Starts the fake OpenAI server on a fixed port for test/golden/generate.py. usage: node serve.mjs [port]
import { startFakeOpenAI } from "../fake-openai.mjs";
const fake = await startFakeOpenAI({ port: Number(process.argv[2] ?? 4599) });
console.log(fake.url);
