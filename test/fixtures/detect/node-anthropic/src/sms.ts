import twilio from "twilio";

const client = twilio();

export async function notify(to: string, body: string) {
  await client.messages.create({ to, from: "+10000000000", body });
}
